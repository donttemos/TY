/*
 * @file memory 缓存驱动（零依赖）
 * @description 进程内缓存：Map 插入序实现近似 LRU（命中即移到队尾，容量超限淘汰队首），
 *   TTL 惰性过期 + 写入时抽样清理；同时实现字符串与集合（标签映射）两类条目。
 *   小系统（单实例）用它即可跑通全部缓存能力，无需安装 Redis（PRD-004 AC-001）。
 *   多实例部署下不共享，仅适用于可容忍不一致的数据（PRD-004 §8 风险说明）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import type { CacheStorePort, TokenBucketTakeResult } from '../store.port.js';
import type { CacheDriverName } from '../types.js';

/** 存储条目：字符串值或集合值，带过期时间戳 */
interface Entry {
  /** 条目类型：单个字符串 / 集合成员 */
  kind: 'value' | 'set';
  /** 值：字符串或集合成员数组 */
  value: string | string[];
  /** 过期时间戳（毫秒） */
  expireAt: number;
}

/** 默认容量上限，与 CACHE_MAX_ITEMS 默认值一致 */
export const DEFAULT_MEMORY_MAX_ITEMS = 10000;

/**
 * 进程内缓存驱动
 *
 * 说明：全部方法为 async 仅为与 redis 驱动保持一致的调用形态，
 * 内部执行为同步（memory 驱动单次 get ≤ 1ms，PRD-004 NFR-1）。
 */
export class MemoryCacheStore implements CacheStorePort {
  readonly kind: CacheDriverName = 'memory';

  private readonly entries = new Map<string, Entry>();

  /** 因容量超限被淘汰的键数量（观测量，不计入 CacheService 指标） */
  private evicted = 0;

  /** 令牌桶状态表（M10 E-03 限流；独立于条目表——桶有自身回满 TTL，不受 LRU 淘汰影响） */
  private readonly buckets = new Map<string, { tokens: number; lastMs: number }>();

  /**
   * @param maxItems 容量上限，默认 10000
   */
  constructor(private readonly maxItems: number = DEFAULT_MEMORY_MAX_ITEMS) {}

  /** 命中并移动到队尾（LRU），过期即删除返回 undefined */
  private touch(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    // Map 插入序 LRU：删除后重新插入即移动到队尾
    this.entries.delete(key);
    this.entries.set(key, entry);
    return entry;
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.touch(key);
    return entry && entry.kind === 'value' ? (entry.value as string) : undefined;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    this.entries.delete(key);
    this.entries.set(key, { kind: 'value', value, expireAt: Date.now() + ttlMs });
    this.evictIfNeeded();
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    if (this.touch(key)) return false;
    this.entries.set(key, { kind: 'value', value, expireAt: Date.now() + ttlMs });
    this.evictIfNeeded();
    return true;
  }

  async del(keys: readonly string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.entries.delete(key)) removed++;
    }
    return removed;
  }

  async exists(key: string): Promise<boolean> {
    return this.touch(key) !== undefined;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    const entry = this.touch(key);
    if (!entry) return false;
    entry.expireAt = Date.now() + ttlMs;
    return true;
  }

  async mget(keys: readonly string[]): Promise<Array<string | undefined>> {
    return keys.map((key) => {
      const entry = this.touch(key);
      return entry && entry.kind === 'value' ? (entry.value as string) : undefined;
    });
  }

  async sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    const existing = this.touch(key);
    const bucket = existing && existing.kind === 'set' ? new Set(existing.value as string[]) : new Set<string>();
    for (const member of members) bucket.add(member);
    this.entries.delete(key);
    // 集合条目续期：每次登记刷新 TTL，避免「幽灵缓存」随集合提前消失
    this.entries.set(key, { kind: 'set', value: [...bucket], expireAt: Date.now() + ttlMs });
    this.evictIfNeeded();
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.touch(key);
    return entry && entry.kind === 'set' ? [...(entry.value as string[])] : [];
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const entry = this.touch(key);
    if (!entry || entry.kind !== 'value' || entry.value !== expected) return false;
    this.entries.delete(key);
    return true;
  }

  /** 令牌桶状态（进程内惰性补充——无序列化与网络开销，P95 ≤ 1ms） */
  async tokenBucketTake(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost: number,
    nowMs: number,
  ): Promise<TokenBucketTakeResult> {
    const bucket = this.buckets.get(key) ?? { tokens: capacity, lastMs: nowMs };
    // 按流逝时间补充（上限封顶），时间倒流（时钟回拨）按 0 处理
    const elapsed = Math.max(0, nowMs - bucket.lastMs);
    bucket.tokens = Math.min(capacity, bucket.tokens + (elapsed / 1000) * refillPerSecond);
    bucket.lastMs = nowMs;
    let allowed = false;
    let retryAfterMs = 0;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      allowed = true;
    } else if (capacity >= cost && refillPerSecond > 0) {
      retryAfterMs = Math.ceil(((cost - bucket.tokens) / refillPerSecond) * 1000);
    }
    this.buckets.set(key, bucket);
    return { allowed, remaining: Math.floor(bucket.tokens), retryAfterMs };
  }

  async compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    const entry = this.touch(key);
    if (!entry || entry.kind !== 'value' || entry.value !== expected) return false;
    entry.expireAt = Date.now() + ttlMs;
    return true;
  }

  async ping(): Promise<boolean> {
    return true;
  }

  async close(): Promise<void> {
    this.entries.clear();
  }

  async size(): Promise<number> {
    this.sweepExpired();
    return this.entries.size;
  }

  /** 已淘汰键数量（观测/测试） */
  evictedCount(): number {
    return this.evicted;
  }

  /** 校验 TTL：禁止无过期写入（防脏数据） */
  private assertTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`缓存 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的缓存`);
    }
  }

  /** 容量超限时按 LRU 淘汰队首 */
  private evictIfNeeded(): void {
    while (this.entries.size > this.maxItems) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evicted++;
    }
  }

  /** 清理全部过期键（容量压力下也可由 size 触发） */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expireAt <= now) this.entries.delete(key);
    }
  }
}
