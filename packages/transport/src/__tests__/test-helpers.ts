/*
 * @file 单测公共夹具
 * @description 统一构造传输运行时配置、内存版 fake Redis（实现 RedisLike 最小接口，
 *   共享列表存储，caller 与 worker 连接指向同一实例）与轮询等待工具。
 *   单测一律使用真实定时器（不 mock 时钟），避免「假绿」。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import type { RedisLike } from '../drivers/redis-client.js';
import type { TransportRuntimeOptions } from '../types.js';

/** 默认运行时配置（超时压到亚秒级，保证单测快速且真实） */
export function makeRuntime(overrides: Partial<TransportRuntimeOptions> = {}): TransportRuntimeOptions {
  return {
    driver: 'in-process',
    url: undefined,
    prefix: 'fw:test',
    timeoutMs: 5000,
    role: 'both',
    instanceId: 'inst-test',
    shutdownTimeoutMs: 500,
    ...overrides,
  };
}

/** 轮询间隔（毫秒）：fake 阻塞命令用 */
const POLL_INTERVAL_MS = 5;

/**
 * 进程内事件总线（模拟 Redis pub/sub）：多连接共用同一 bus 即可复现「跨实例广播」——
 * 这是 E-12 多副本语义的单测近似（两个驱动实例 = 两个进程）。
 */
export class FakePubSubBus {
  /** 频道 → 监听器集合 */
  private readonly channels = new Map<string, Set<(channel: string, message: string) => void>>();

  /** 注册监听器 */
  attach(channel: string, listener: (channel: string, message: string) => void): void {
    const bucket = this.channels.get(channel) ?? new Set();
    bucket.add(listener);
    this.channels.set(channel, bucket);
  }

  /** 移除监听器 */
  detach(channel: string, listener: (channel: string, message: string) => void): void {
    const bucket = this.channels.get(channel);
    if (!bucket) return;
    bucket.delete(listener);
    if (bucket.size === 0) this.channels.delete(channel);
  }

  /** 广播并返回收到消息的订阅方数量 */
  broadcast(channel: string, message: string): number {
    const bucket = this.channels.get(channel);
    if (!bucket) return 0;
    for (const listener of [...bucket]) listener(channel, message);
    return bucket.size;
  }

  /** 当前某频道的订阅方数量（断言退订用） */
  subscriberCount(channel: string): number {
    return this.channels.get(channel)?.size ?? 0;
  }
}

/**
 * 内存版 fake Redis：以 Map 模拟列表，LPUSH 入头、BLPOP 弹尾、BRPOP 弹头，
 * 阻塞命令按真实超时时间轮询等待（无数据到期返回 null），与 ioredis 语义一致。
 * caller 与 worker 连接可指向同一实例（共享列表存储），quit/disconnect 幂等。
 * M10 E-12：另实现 PUBLISH / SUBSCRIBE / UNSUBSCRIBE（经可共享的 FakePubSubBus，
 * 多个 FakeRedis 传入同一 bus 即模拟 Redis 的跨连接广播）。
 */
export class FakeRedis implements RedisLike {
  /** 列表存储（键 → 元素数组；头 = 数组首部） */
  readonly lists = new Map<string, string[]>();
  /** expire 调用记录（断言应答键兜底 TTL） */
  readonly expired: Array<{ key: string; seconds: number }> = [];
  /** 是否已关闭 */
  closed = false;
  /** ping 次数 */
  pingCount = 0;
  /** 事件总线（缺省独享；跨实例测试传入共享实例） */
  readonly bus: FakePubSubBus;
  /** 已订阅频道 → 总线监听器 */
  private readonly subscriptions = new Map<string, (channel: string, message: string) => void>();
  /** message 监听器（`on('message', ...)`） */
  private readonly messageListeners: Array<(...args: unknown[]) => void> = [];

  /**
   * @param bus 共享事件总线（缺省独享，单连接自收自发）
   */
  constructor(bus?: FakePubSubBus) {
    this.bus = bus ?? new FakePubSubBus();
  }

  /** LPUSH：压入列表头 */
  async lpush(key: string, value: string): Promise<number> {
    const list = this.lists.get(key) ?? [];
    list.unshift(value);
    this.lists.set(key, list);
    return list.length;
  }

  /** BLPOP：阻塞弹出列表尾 */
  async blpop(key: string, timeoutSeconds: number): Promise<[string, string] | null> {
    return this.pop(key, 'tail', timeoutSeconds);
  }

  /** BRPOP：阻塞弹出列表头 */
  async brpop(key: string, timeoutSeconds: number): Promise<[string, string] | null> {
    return this.pop(key, 'head', timeoutSeconds);
  }

  /** DEL：删除键 */
  async del(key: string): Promise<number> {
    return this.lists.delete(key) ? 1 : 0;
  }

  /** EXPIRE：记录调用（不真正过期，单测周期远小于 TTL） */
  async expire(key: string, seconds: number): Promise<number> {
    this.expired.push({ key, seconds });
    return this.lists.has(key) ? 1 : 0;
  }

  /** PING */
  async ping(): Promise<string> {
    this.pingCount += 1;
    return 'PONG';
  }

  /** QUIT：幂等关闭 */
  async quit(): Promise<unknown> {
    this.closed = true;
    return 'OK';
  }

  /** DISCONNECT：幂等关闭 */
  disconnect(): void {
    this.closed = true;
  }

  /** ON：message 事件进入监听表（其余事件仅消费，不派发） */
  on(event: string, handler: (...args: unknown[]) => void): unknown {
    if (event === 'message') this.messageListeners.push(handler);
    return this;
  }

  /** PUBLISH：经总线广播，返回订阅方数量 */
  async publish(channel: string, message: string): Promise<number> {
    return this.bus.broadcast(channel, message);
  }

  /** SUBSCRIBE：同一频道重复订阅幂等 */
  async subscribe(channel: string): Promise<unknown> {
    if (this.subscriptions.has(channel)) return 'OK';
    const listener = (ch: string, message: string): void => {
      for (const handler of [...this.messageListeners]) handler(ch, message);
    };
    this.subscriptions.set(channel, listener);
    this.bus.attach(channel, listener);
    return 'OK';
  }

  /** UNSUBSCRIBE：移除总线监听器 */
  async unsubscribe(channel: string): Promise<unknown> {
    const listener = this.subscriptions.get(channel);
    if (!listener) return 'OK';
    this.subscriptions.delete(channel);
    this.bus.detach(channel, listener);
    return 'OK';
  }

  /** 取某键当前长度（测试断言入队/清理用） */
  lengthOf(key: string): number {
    return this.lists.get(key)?.length ?? 0;
  }

  /** 阻塞弹出公共实现：无数据时按真实超时轮询等待 */
  private async pop(key: string, end: 'head' | 'tail', timeoutSeconds: number): Promise<[string, string] | null> {
    const deadline = Date.now() + Math.max(0, timeoutSeconds) * 1000;
    for (;;) {
      const list = this.lists.get(key);
      if (list && list.length > 0) {
        const value = end === 'tail' ? (list.pop() as string) : (list.shift() as string);
        if (list.length === 0) this.lists.delete(key);
        return [key, value];
      }
      if (Date.now() >= deadline) return null;
      await sleepMs(POLL_INTERVAL_MS);
    }
  }
}

/** 毫秒延迟（不阻塞进程退出） */
export function sleepMs(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/**
 * 轮询等待条件成立
 * @param condition 条件
 * @param label 超时提示
 * @param timeoutMs 超时上限
 */
export async function waitFor(condition: () => boolean, label = '条件', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await sleepMs(5);
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}
