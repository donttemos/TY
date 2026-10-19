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
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复（C-01/C-03/A-04）：实现端口的两个原子方法
 *   `setWithTags` / `invalidateByTag`——memory 驱动单线程，方法体内无 await 间隔即天然原子
 *   （与 redis 驱动的 Lua 脚本同一条端口契约对齐）。
 * @modified 2026-10-17 donttemo Cache 缺陷清单 A-01 跨驱动语义对齐：① 类型冲突显式失败——
 *   get/smembers/sadd/compareAndDelete/compareAndExpire 遇到与操作不符的条目类型时抛错
 *   （对齐 Redis WRONGTYPE），不再静默替换/返回空，防止调用方键命名错误被吞掉；
 *   mget 对非字符串条目返回 undefined（对齐 Redis MGET「永不出错、非字符串为 nil」）；
 *   set/setNx/exists/expire/del/invalidateByTag 保持任意类型可用（对齐 Redis SET/DEL/EXISTS 等）；
 *   ② sadd(key, [], ttl) 不再创建空集合条目（对齐 Redis SADD 空成员无操作，防幽灵集合）。
 * @modified 2026-10-18 donttemo 复核修复（P1）：`setWithTags` 写前全量预检（标签键类型 + 标签键撞值键），
 *   与 redis 驱动 `SET_TAGS_LUA` 的预检同口径——确定性错误零写入，不再把字符串标签条目静默换成集合。
 * @module @fw/cache
 */

import type { CacheStorePort, TokenBucketTakeResult } from '../store.port.js';
import type { CacheDriverName } from '../types.js';
import { BizError, ErrorCode } from '@fw/core';

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

  /** 只读查看（不参与 LRU 重排；过期即删除）：预检路径不得因校验改变淘汰顺序 */
  private peek(key: string): Entry | undefined {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.entries.delete(key);
      return undefined;
    }
    return entry;
  }

  async get(key: string): Promise<string | undefined> {
    const entry = this.touch(key);
    this.assertKind(key, entry, 'value');
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
    // 非字符串条目返回 undefined（对齐 Redis MGET：永不出错，非字符串键为 nil——与单键 GET 抛 WRONGTYPE 不同）
    return keys.map((key) => {
      const entry = this.touch(key);
      return entry && entry.kind === 'value' ? entry.value : undefined;
    });
  }

  async sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    // 空成员为无操作（对齐 Redis SADD；不创建幽灵集合条目）
    if (members.length === 0) return;
    const existing = this.touch(key);
    this.assertKind(key, existing, 'set');
    const bucket = existing && existing.kind === 'set' ? new Set(existing.value) : new Set<string>();
    for (const member of members) bucket.add(member);
    this.entries.delete(key);
    // 集合条目续期：每次登记刷新 TTL，避免「幽灵缓存」随集合提前消失
    this.entries.set(key, { kind: 'set', value: [...bucket], expireAt: Date.now() + ttlMs });
    this.evictIfNeeded();
  }

  async smembers(key: string): Promise<string[]> {
    const entry = this.touch(key);
    this.assertKind(key, entry, 'set');
    return entry && entry.kind === 'set' ? [...entry.value] : [];
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const entry = this.touch(key);
    // 对齐 Redis：条件删除脚本内 GET 对集合键报 WRONGTYPE
    this.assertKind(key, entry, 'value');
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
    // 对齐 Redis：条件续期脚本内 GET 对集合键报 WRONGTYPE
    this.assertKind(key, entry, 'value');
    if (!entry || entry.kind !== 'value' || entry.value !== expected) return false;
    entry.expireAt = Date.now() + ttlMs;
    return true;
  }

  /**
   * 带标签登记的原子写入（端口契约见 store.port）：方法体内无 await 间隔，
   * JS 单线程语义下与 redis 驱动的 Lua 脚本等价原子（C-01/C-04 修复）。
   *
   * 2026-10-18 复核加固：写操作之前先做全量预检（标签键类型 + 标签键撞值键），
   * 与 redis 驱动的 `SET_TAGS_LUA` 同口径——确定性错误必须零写入失败，否则
   * 「值已写入、标签未登记」会留下孤儿缓存（此前 memory 会把字符串标签条目静默换成集合）。
   */
  async setWithTags(
    key: string,
    value: string,
    ttlMs: number,
    tags: ReadonlyArray<{ tagKey: string; ttlMs: number }>,
  ): Promise<void> {
    this.assertTtl(ttlMs);
    for (const tag of tags) this.assertTtl(tag.ttlMs);
    for (const tag of tags) {
      if (tag.tagKey === key) {
        throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存配置非法：标签键与值键相同（${key}），已中止写入`);
      }
      this.assertKind(tag.tagKey, this.peek(tag.tagKey), 'set');
    }
    const now = Date.now();
    // 写值
    this.entries.delete(key);
    this.entries.set(key, { kind: 'value', value, expireAt: now + ttlMs });
    // 标签登记（与写值同一同步块：半程状态不可见）
    for (const tag of tags) {
      const existing = this.touch(tag.tagKey);
      const bucket = existing && existing.kind === 'set' ? new Set(existing.value) : new Set<string>();
      bucket.add(key);
      this.entries.delete(tag.tagKey);
      this.entries.set(tag.tagKey, { kind: 'set', value: [...bucket], expireAt: now + tag.ttlMs });
    }
    this.evictIfNeeded();
  }

  /**
   * 原子标签失效（端口契约见 store.port）：读成员、删成员、删索引在同一同步块完成；
   * 失败即整体未发生，不存在「索引已删、成员残留」的半程状态（C-03 修复）
   */
  async invalidateByTag(tagKey: string): Promise<number> {
    const entry = this.touch(tagKey);
    const members = entry && entry.kind === 'set' ? [...entry.value] : [];
    let removed = 0;
    for (const member of members) {
      if (this.entries.delete(member)) removed++;
    }
    this.entries.delete(tagKey);
    return removed;
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
      throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的缓存`);
    }
  }

  /**
   * 类型冲突校验（A-01，对齐 Redis WRONGTYPE 语义）：条目存在但类型与操作不符时显式抛错，
   * 不静默替换/返回空——让调用方的键命名错误在开发期暴露，而不是在跨驱动切换后才炸。
   * 类型语义速查（与 redis 驱动一致，store-contract.test 锁定）：
   * - get / smembers / sadd / compareAndDelete / compareAndExpire：类型不符 → 抛错；
   * - mget：非字符串条目 → undefined（Redis MGET 对非字符串返回 nil，永不出错）；
   * - set / setNx / exists / expire / del / invalidateByTag：任意类型可用（Redis 同）。
   */
  // 断言签名收窄：wrong-kind 抛错后调用方拿到精确的条目类型（并行批次 A-01 修复的编译收尾）
  private assertKind(key: string, entry: Entry | undefined, expected: 'value'): asserts entry is ValueEntry | undefined;
  private assertKind(key: string, entry: Entry | undefined, expected: 'set'): asserts entry is SetEntry | undefined;
  private assertKind(key: string, entry: Entry | undefined, expected: 'value' | 'set'): void {
    if (entry && entry.kind !== expected) {
      const actual = entry.kind === 'value' ? '字符串' : '集合';
      const wanted = expected === 'value' ? '字符串' : '集合';
      throw new BizError(ErrorCode.INTERNAL, `缓存键类型冲突（WRONGTYPE）：键 ${key} 已是${actual}，不能按${wanted}操作`);
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
   *
   * A-07 验收口径（登记）：冷桶（低于阈值的过期桶）不保证立即清理，内存上界 =
   * `bucketSweepAt × 单桶体积`（阈值随存活量翻倍、有上界可控）；过期桶在被再次访问时惰性重建。
   * 若部署环境对内存上限有硬要求，应配合 CACHE_MAX_ITEMS / 进程内存告警，不依赖本清理的实时性。
   */
  private sweepBuckets(nowMs: number): void {
    if (this.buckets.size < this.bucketSweepAt) return;
    for (const [key, bucket] of this.buckets) {
      if (bucket.expiresAt <= nowMs) this.buckets.delete(key);
    }
    this.bucketSweepAt = Math.max(BUCKET_SWEEP_FLOOR, this.buckets.size * 2);
  }
}
