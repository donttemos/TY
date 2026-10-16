/*
 * @file memory 缓存驱动（零依赖）
 * @description 进程内缓存：Map 插入序实现近似 LRU（命中即移到队尾，容量超限淘汰队首），
 *   TTL 惰性过期 + 写入时抽样清理；同时实现字符串与集合（标签映射）两类条目。
 *   小系统（单实例）用它即可跑通全部缓存能力，无需安装 Redis（PRD-004 AC-001）。
 *   多实例部署下不共享，仅适用于可容忍不一致的数据（PRD-004 §8 风险说明）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复：① Entry 改判别联合（消除 as 断言）；
 *   ② tokenBucketTake 时钟回拨对齐 Redis Lua（仅 now>last 才补充并推进 last）；③ 令牌桶补齐 TTL
 *   与摊销清理（原注释声称「桶有自身回满 TTL」但未实现——限流 key 会无限增长，OOM 风险）；
 *   ④ capacity < cost 时 retryAfterMs 返回 -1（永不可满足）而非误导性的 0；
 *   ⑤ evictIfNeeded 容量压力下先清过期键再 LRU 淘汰；⑥ size() 的过期清理按 1 秒节流，
 *   避免高频观测调用每次全量扫描阻塞事件循环；⑦ close() 同步清理令牌桶。
 * @module @fw/cache
 */

import type { CacheStorePort, TokenBucketTakeResult } from '../store.port.js';
import type { CacheDriverName } from '../types.js';

/** 存储条目（判别联合：kind 收窄后无需 as 断言） */
type Entry = ValueEntry | SetEntry;

/** 字符串条目 */
interface ValueEntry {
  /** 条目类型：单个字符串 */
  kind: 'value';
  /** 值 */
  value: string;
  /** 过期时间戳（毫秒） */
  expireAt: number;
}

/** 集合条目（标签映射） */
interface SetEntry {
  /** 条目类型：集合成员 */
  kind: 'set';
  /** 集合成员数组 */
  value: string[];
  /** 过期时间戳（毫秒） */
  expireAt: number;
}

/** 默认容量上限，与 CACHE_MAX_ITEMS 默认值一致 */
export const DEFAULT_MEMORY_MAX_ITEMS = 10000;

/** 令牌桶摊销清理的起始阈值（size 达到该值触发一次过期清理，之后阈值翻倍） */
const BUCKET_SWEEP_FLOOR = 64;

/** size() 过期清理的最小间隔（毫秒）——高频观测调用不重复全量扫描 */
const SIZE_SWEEP_INTERVAL_MS = 1000;

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

  /** 上次 size() 触发过期清理的时刻（节流用） */
  private lastSizeSweepAt = 0;

  /**
   * 令牌桶状态表（M10 E-03 限流；独立于条目表——桶有自身 TTL，到期即回收，
   * 不受 LRU 淘汰影响）。语义与 redis 驱动的 Lua 脚本一致：
   * - 仅当 now > last 才按流逝时间补充令牌并推进 last（时钟回拨不补充、不倒扣）；
   * - TTL = 桶自然回满时间 + 60s 缓冲（与 redis 侧 PEXPIRE 同源），冷桶到期回收不永驻。
   */
  private readonly buckets = new Map<string, { tokens: number; lastMs: number; expiresAt: number }>();

  /** 下一次桶过期清理触发的 size 阈值（摊销：每次清理后按存活量翻倍重设） */
  private bucketSweepAt = BUCKET_SWEEP_FLOOR;

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
    return entry && entry.kind === 'value' ? entry.value : undefined;
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
      return entry && entry.kind === 'value' ? entry.value : undefined;
    });
  }

  async sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    const existing = this.touch(key);
    const bucket = existing && existing.kind === 'set' ? new Set(existing.value) : new Set<string>();
    for (const member of members) bucket.add(member);
    this.entries.delete(key);
    // 集合条目续期：每次登记刷新 TTL，避免「幽灵缓存」随集合提前消失
    this.entries.set(key, { kind: 'set', value: [...bucket], expireAt: Date.now() + ttlMs });
    this.evictIfNeeded();
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.touch(key);
    return entry && entry.kind === 'set' ? [...entry.value] : [];
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
    // 桶 TTL = 自然回满时间（含缓冲），与 redis 驱动同源；冷桶到期后重建为满桶
    const ttlMs = Math.ceil((capacity / Math.max(refillPerSecond, 1)) * 1000) + 60_000;
    const existing = this.buckets.get(key);
    const bucket = existing && existing.expiresAt > nowMs ? existing : { tokens: capacity, lastMs: nowMs, expiresAt: 0 };
    // 时钟回拨语义与 redis Lua 的 `if now > last` 对齐：只有前进的时钟才补充并推进 last
    if (nowMs > bucket.lastMs) {
      bucket.tokens = Math.min(capacity, bucket.tokens + ((nowMs - bucket.lastMs) / 1000) * refillPerSecond);
      bucket.lastMs = nowMs;
    }
    bucket.expiresAt = nowMs + ttlMs;
    let allowed = false;
    let retryAfterMs = 0;
    if (bucket.tokens >= cost) {
      bucket.tokens -= cost;
      allowed = true;
    } else if (capacity >= cost && refillPerSecond > 0) {
      retryAfterMs = Math.ceil(((cost - bucket.tokens) / refillPerSecond) * 1000);
    } else {
      // capacity < cost（或 refill ≤ 0）时该桶对本次 cost 永不可满足：-1 表示「等待无意义」，
      // 调用方不得据此给出「立即重试」的误导（此前返回 0 会被当作可立即重试）
      retryAfterMs = -1;
    }
    this.buckets.set(key, bucket);
    this.sweepBuckets(nowMs);
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
    this.buckets.clear();
  }

  async size(): Promise<number> {
    // 观测近似值：过期清理按 1 秒节流（touch 已保证读路径的惰性过期，
    // 此处只为容量观测与内存回收，不需要每次调用都全量扫描阻塞事件循环）
    const now = Date.now();
    if (now - this.lastSizeSweepAt >= SIZE_SWEEP_INTERVAL_MS) {
      this.sweepExpired();
      this.lastSizeSweepAt = now;
    }
    return this.entries.size;
  }

  /** 已淘汰键数量（观测/测试） */
  evictedCount(): number {
    return this.evicted;
  }

  /** 令牌桶表条目数（观测/测试：验证桶 TTL 回收，不参与业务） */
  bucketCount(): number {
    return this.buckets.size;
  }

  /** 校验 TTL：禁止无过期写入（防脏数据） */
  private assertTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`缓存 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的缓存`);
    }
  }

  /** 容量超限时：先清理过期键（避免误杀活键），再按 LRU 淘汰队首 */
  private evictIfNeeded(): void {
    if (this.entries.size <= this.maxItems) return;
    this.sweepExpired();
    while (this.entries.size > this.maxItems) {
      const oldest = this.entries.keys().next();
      if (oldest.done) break;
      this.entries.delete(oldest.value);
      this.evicted++;
    }
  }

  /** 清理全部过期键（容量压力下由 evictIfNeeded / size 节流调用） */
  private sweepExpired(): void {
    const now = Date.now();
    for (const [key, entry] of this.entries) {
      if (entry.expireAt <= now) this.entries.delete(key);
    }
  }

  /**
   * 令牌桶过期清理（摊销 O(1)/次）：size 达到阈值时清一轮到期桶，之后阈值按存活量翻倍重设，
   * 保证「限流 key 随访问方无限增长」的场景（如伪造大量 IP）不会让 buckets 无界膨胀。
   */
  private sweepBuckets(nowMs: number): void {
    if (this.buckets.size < this.bucketSweepAt) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= nowMs) this.buckets.delete(key);
    }
    this.bucketSweepAt = Math.max(BUCKET_SWEEP_FLOOR, this.buckets.size * 2);
  }
}
