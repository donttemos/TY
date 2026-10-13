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
 * 内存版 fake Redis：以 Map 模拟列表，LPUSH 入头、BLPOP 弹尾、BRPOP 弹头，
 * 阻塞命令按真实超时时间轮询等待（无数据到期返回 null），与 ioredis 语义一致。
 * caller 与 worker 连接可指向同一实例（共享列表存储），quit/disconnect 幂等。
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

  /** ON：仅消费事件订阅，不做派发 */
  on(_event: string, _handler: (...args: unknown[]) => void): unknown {
    return this;
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
