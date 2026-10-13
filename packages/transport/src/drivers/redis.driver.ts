/*
 * @file redis 传输驱动
 * @description 跨进程/微服务形态的传输驱动，基于 Redis 列表的请求/应答 RPC 协议：
 *   - 调用方：`LPUSH <prefix>:req:<address>` 投递信封（含应答键），随后 `BLPOP <prefix>:rpl:<id>` 等应答；
 *   - 处理方：每地址一条阻塞连接 `BRPOP <prefix>:req:<address>` 取请求，执行处理器后
 *     `LPUSH <replyTo>` 回传应答并 `EXPIRE` 60s 兜底清理；
 *   - 处理方执行上限取信封里的调用方超时（`withTimeout` 包裹），双方超时语义一致；
 *   - 应答键由调用方读到后 `DEL`，处理方崩溃时由 TTL 兜底，不泄漏键。
 *   连接分工：caller 连接（LPUSH + BLPOP）与每地址一条 worker 阻塞连接（BRPOP）分离，
 *   避免阻塞命令相互堵塞。ioredis 懒加载（optional peer），缺失时给出可操作报错。
 *   caller 角色不起消费循环；handler 角色只消费不发起（除非业务主动调用）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { Logger } from '@fw/logger';
import {
  assertAddress,
  deserializeTransportError,
  HandlerNotRegisteredError,
  serializeTransportError,
  TransportError,
  TransportTimeoutError,
  TransportUnavailableError,
} from '../errors.js';
import type { TransportDriverPort } from '../driver.port.js';
import type { TransportRegistry } from '../registry.js';
import { withTimeout } from '../async.js';
import { createRedisClient, MISSING_REDIS_URL_MESSAGE, type RedisLike } from './redis-client.js';
import type { CallOptions, TransportContext, TransportEnvelope, TransportHandlerFn, TransportReply } from '../types.js';

const logger = Logger.for('transport');

/** 应答键兜底 TTL（秒）：调用方异常退出未 DEL 时由 Redis 自动清理 */
const REPLY_TTL_SECONDS = 60;
/** 消费循环轮询间隔（秒）：BRPOP 超时后检查停机标志 */
const WORKER_POLL_SECONDS = 1;

/** redis 驱动构造选项 */
export interface RedisTransportDriverOptions {
  /** Redis 连接串 */
  url?: string;
  /** key 前缀（已由 buildTransportOptions 解析，非空） */
  prefix: string;
  /** 实例标识 */
  instanceId: string;
  /** 默认超时（毫秒） */
  defaultTimeoutMs: number;
  /** 优雅停机等待在途请求的超时（毫秒） */
  shutdownTimeoutMs: number;
  /** 自定义客户端工厂（测试注入 fake；传入后忽略 url 与 ioredis 懒加载） */
  createClient?: (purpose: 'caller' | 'worker') => RedisLike | Promise<RedisLike>;
}

/** 消费循环状态 */
interface WorkerState {
  /** 阻塞连接（懒创建） */
  client?: RedisLike;
  /** 停机标志 */
  stop: boolean;
  /** 循环 Promise（优雅停机等待） */
  loop: Promise<void>;
}

/**
 * redis 传输驱动（跨进程 RPC）
 */
export class RedisTransportDriver implements TransportDriverPort {
  /** 驱动名 */
  readonly kind = 'redis' as const;

  private readonly registry: TransportRegistry;
  private readonly options: RedisTransportDriverOptions;
  private readonly workers = new Map<string, WorkerState>();
  private callerClient?: RedisLike;
  private started = false;
  private closing = false;
  private handled = 0;

  /**
   * @param registry 处理器注册表（与服务共享）
   * @param options 连接、前缀、超时与角色相关配置
   */
  constructor(registry: TransportRegistry, options: RedisTransportDriverOptions) {
    this.registry = registry;
    this.options = options;
  }

  /**
   * 注册处理器；启动后注册会即时补起该地址的消费循环（角色含 handler 时）
   * @param address 传输地址
   * @param handler 处理器
   */
  register(address: string, handler: TransportHandlerFn): void {
    this.registry.register(address, handler);
    if (this.started && this.registry.handling && !this.closing) {
      this.spawnWorker(address);
    }
  }

  /** 启动：校验角色与连接串后按已注册地址起消费循环（caller 角色不消费） */
  async start(): Promise<void> {
    // 配置守卫：redis 驱动缺连接串时启动即失败（懒加载不能把错误推迟到首次调用，
    // 那会让「起服务即报错」的运维语义退化成一个 503）——与 M7 bullmq 守卫一致
    if (!this.options.url) throw new TransportUnavailableError(MISSING_REDIS_URL_MESSAGE);
    this.started = true;
    if (!this.registry.handling) return;
    for (const address of this.registry.addresses()) {
      this.spawnWorker(address);
    }
  }

  /**
   * 发起调用：投递请求 → 等应答 → 清理应答键
   * @param address 传输地址
   * @param payload 调用载荷（须可 JSON 序列化）
   * @param options 单次调用选项
   */
  async call<TRes = unknown>(address: string, payload: unknown, options?: CallOptions): Promise<TRes> {
    assertAddress(address);
    const timeoutMs = options?.timeoutMs ?? this.options.defaultTimeoutMs;
    const caller = await this.getCallerClient();
    const id = newId();
    const replyTo = this.replyKey(id);
    const envelope: TransportEnvelope = {
      id,
      address,
      payload,
      replyTo,
      callerId: this.options.instanceId,
      sentAt: Date.now(),
      timeoutMs,
    };
    let raw: string;
    try {
      raw = JSON.stringify(envelope);
    } catch (cause) {
      throw new TransportError(`传输载荷不可 JSON 序列化：${address}`, { cause });
    }
    await caller.lpush(this.requestKey(address), raw);

    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new TransportTimeoutError(address, timeoutMs);
      // BLPOP 超时粒度是秒（>=1），可能提前返回；按剩余时间循环等待，保证超时精度
      const popped = await caller.blpop(replyTo, Math.max(1, Math.ceil(remaining / 1000)));
      if (!popped) continue;
      await caller.del(replyTo).catch(() => undefined);
      const reply = JSON.parse(popped[1]) as TransportReply;
      if (!reply.ok) {
        throw deserializeTransportError(reply.error ?? { name: 'TransportError', message: '对端未知错误' });
      }
      return reply.result as TRes;
    }
  }

  /**
   * 可用性探测：ping 全部存活连接；尚无连接时验证一次连通性
   */
  async ping(): Promise<boolean> {
    const clients: RedisLike[] = [];
    if (this.callerClient) clients.push(this.callerClient);
    for (const state of this.workers.values()) {
      if (state.client) clients.push(state.client);
    }
    if (clients.length === 0) {
      try {
        const client = await this.getCallerClient();
        await client.ping();
        return true;
      } catch {
        return false;
      }
    }
    try {
      for (const client of clients) await client.ping();
      return true;
    } catch {
      return false;
    }
  }

  /** 本进程已处理请求数 */
  handledCount(): number {
    return this.handled;
  }

  /**
   * 优雅停机：停消费循环 → 等在途请求（超时）→ 断开全部连接
   * @param timeoutMs 等待上限（毫秒），缺省取构造选项
   */
  async close(timeoutMs?: number): Promise<void> {
    const budget = timeoutMs ?? this.options.shutdownTimeoutMs;
    this.closing = true;
    const states = [...this.workers.values()];
    for (const state of states) state.stop = true;
    await Promise.race([Promise.all(states.map((state) => state.loop)), sleep(budget)]);
    this.workers.clear();

    const clients: RedisLike[] = [];
    if (this.callerClient) clients.push(this.callerClient);
    for (const state of states) {
      if (state.client) clients.push(state.client);
    }
    for (const client of clients) {
      try {
        await client.quit();
      } catch {
        client.disconnect();
      }
    }
    this.callerClient = undefined;
  }

  /** 请求队列键 */
  private requestKey(address: string): string {
    return `${this.options.prefix}:req:${address}`;
  }

  /** 应答列表键（按关联 ID 唯一） */
  private replyKey(id: string): string {
    return `${this.options.prefix}:rpl:${id}`;
  }

  /** 懒创建调用方连接 */
  private async getCallerClient(): Promise<RedisLike> {
    if (this.callerClient) return this.callerClient;
    const client = await this.resolveClient('caller');
    this.callerClient = client;
    return client;
  }

  /** 解析客户端：测试工厂优先，否则懒加载 ioredis */
  private async resolveClient(purpose: 'caller' | 'worker'): Promise<RedisLike> {
    if (this.options.createClient) return await this.options.createClient(purpose);
    return await createRedisClient(this.options.url);
  }

  /** 补起某地址的消费循环（幂等） */
  private spawnWorker(address: string): void {
    if (this.workers.has(address) || this.closing) return;
    const state: WorkerState = { stop: false, loop: Promise.resolve() };
    this.workers.set(address, state);
    state.loop = this.runWorker(address, state);
  }

  /** 消费循环：阻塞取请求 → 分发 → 回传应答；BRPOP 1s 轮询以便响应停机 */
  private async runWorker(address: string, state: WorkerState): Promise<void> {
    try {
      const client = await this.resolveClient('worker');
      state.client = client;
      const requestKey = this.requestKey(address);
      while (!state.stop && !this.closing) {
        const popped = await client.brpop(requestKey, WORKER_POLL_SECONDS);
        if (!popped) continue;
        await this.dispatch(address, popped[1], client);
      }
    } catch (error) {
      if (!this.closing) {
        logger.error('传输消费循环异常退出（该地址暂停消费，重启或修复连接后恢复）', {
          address,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /** 分发单条请求并回传应答 */
  private async dispatch(address: string, raw: string, client: RedisLike): Promise<void> {
    let envelope: TransportEnvelope;
    try {
      envelope = JSON.parse(raw) as TransportEnvelope;
    } catch {
      return; // 坏消息无法应答，直接丢弃
    }
    const handler = this.registry.resolve(address);
    const ctx: TransportContext = {
      address,
      driver: 'redis',
      instanceId: this.options.instanceId,
      receivedAt: Date.now(),
    };
    let reply: TransportReply;
    try {
      if (!handler) throw new HandlerNotRegisteredError(address);
      // 执行上限取调用方超时：双方超时语义一致，处理方不会无限挂死占用消费循环
      const result = await withTimeout(() => handler(envelope.payload, ctx), envelope.timeoutMs, address);
      reply = { id: envelope.id, ok: true, result };
    } catch (error) {
      reply = { id: envelope.id, ok: false, error: serializeTransportError(error) };
    }
    this.handled += 1;
    await client.lpush(envelope.replyTo, JSON.stringify(reply));
    await client.expire(envelope.replyTo, REPLY_TTL_SECONDS).catch(() => undefined);
  }
}

/** 生成关联 ID（Node 20+ 全局 crypto；兜底时间戳 + 随机数） */
function newId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID();
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** 停机等待用延迟（不阻塞进程退出） */
function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
