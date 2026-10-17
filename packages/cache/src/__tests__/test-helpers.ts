/*
 * @file 测试辅助：桩配置、可故障存储、Fake Redis 客户端
 * @description 单测共用的替身实现：`makeOptions` 统一运行时配置；`FaultyStore` 支持一键注入存储故障
 *   （验证 TC-CACHE-007/008 降级与回切）与按方法选择性故障（failWhen，验证 C-03 失效失败语义）；
 *   `FakeRedisClient` 以内存模型实现 RedisClientLike，使 redis 驱动可在无真实 Redis 的沙箱内
 *   完整验证（TC-CACHE-001/009）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复配套：FakeRedisClient.eval 增加 SADD+PEXPIRE
 *   原子脚本分支（驱动侧集合登记已合并为单条 Lua）
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复配套：① FaultyStore 补齐 tokenBucketTake
 *   （此前缺失，属潜在类型缺口）并实现端口的 setWithTags / invalidateByTag；guard 增加 method
 *   参数与 `failWhen` 选择性故障注入（默认关闭，不影响既有用例）；② FakeRedisClient.eval 增加
 *   SET_TAGS（写值+标签登记原子脚本）与 SMEMBERS 失效原子脚本两个分支；③ A-01 配套：Fake 客户端
 *   建模 Redis WRONGTYPE 语义——get/smembers/sadd 及 Lua 条件操作遇类型不符抛错（与 memory 驱动
 *   的 assertKind 对齐），mget 对集合键返回 null（对齐 Redis MGET nil）。
 * @module @fw/cache
 */

import type { RedisClientLike } from '../drivers/redis-client.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import type { CacheStorePort } from '../store.port.js';
import type { CacheRuntimeOptions } from '../types.js';

/** 可控并发测试门闩：让测试明确控制「操作执行到哪一步、何时继续」（回归测试设计 §1） */
export function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** 构造运行时配置（测试默认值：1 秒 TTL、空值占位 1 秒、无抖动） */
export function makeOptions(overrides: Partial<CacheRuntimeOptions> = {}): CacheRuntimeOptions {
  return {
    driver: 'memory',
    url: undefined,
    prefix: 'test',
    defaultTtlSeconds: 1,
    maxItems: 10000,
    failOpen: true,
    nullTtlSeconds: 1,
    ttlJitter: 0,
    lockTtlSeconds: 1,
    tagTtlSeconds: 3600,
    slowMs: 50,
    maxValueBytes: 1024 * 1024,
    ...overrides,
  };
}

/**
 * 可注入故障的存储：默认透传 memory 驱动，`broken=true` 时所有操作抛错
 * 用于验证降级（fail-open）、fail-closed 与恢复回切
 */
export class FaultyStore implements CacheStorePort {
  readonly kind = 'redis' as const;
  /** 故障开关 */
  broken = false;
  /** 底层实现 */
  readonly inner = new MemoryCacheStore(1000);
  /** 抛错次数（断言用） */
  failures = 0;
  /**
   * 选择性故障注入（C-03 回归用）：返回 true 的方法名在 broken=false 时也抛错。
   * 默认恒 false，不影响既有用例。
   */
  failWhen: (method: string) => boolean = () => false;

  /** 故障时抛错，否则透传 */
  private async guard<T>(method: string, fn: () => Promise<T>): Promise<T> {
    if (this.broken || this.failWhen(method)) {
      this.failures++;
      throw new Error('模拟缓存依赖故障（connection refused）');
    }
    return fn();
  }

  get(key: string): Promise<string | undefined> {
    return this.guard('get', () => this.inner.get(key));
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.guard('set', () => this.inner.set(key, value, ttlMs));
  }

  setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    return this.guard('setNx', () => this.inner.setNx(key, value, ttlMs));
  }

  del(keys: readonly string[]): Promise<number> {
    return this.guard('del', () => this.inner.del(keys));
  }

  exists(key: string): Promise<boolean> {
    return this.guard('exists', () => this.inner.exists(key));
  }

  expire(key: string, ttlMs: number): Promise<boolean> {
    return this.guard('expire', () => this.inner.expire(key, ttlMs));
  }

  mget(keys: readonly string[]): Promise<Array<string | undefined>> {
    return this.guard('mget', () => this.inner.mget(keys));
  }

  sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    return this.guard('sadd', () => this.inner.sadd(key, members, ttlMs));
  }

  smembers(key: string): Promise<string[]> {
    return this.guard('smembers', () => this.inner.smembers(key));
  }

  compareAndDelete(key: string, expected: string): Promise<boolean> {
    return this.guard('compareAndDelete', () => this.inner.compareAndDelete(key, expected));
  }

  compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    return this.guard('compareAndExpire', () => this.inner.compareAndExpire(key, expected, ttlMs));
  }

  tokenBucketTake(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost: number,
    nowMs: number,
  ): ReturnType<MemoryCacheStore['tokenBucketTake']> {
    return this.guard('tokenBucketTake', () => this.inner.tokenBucketTake(key, capacity, refillPerSecond, cost, nowMs));
  }

  setWithTags(
    key: string,
    value: string,
    ttlMs: number,
    tags: ReadonlyArray<{ tagKey: string; ttlMs: number }>,
  ): Promise<void> {
    return this.guard('setWithTags', () => this.inner.setWithTags(key, value, ttlMs, tags));
  }

  invalidateByTag(tagKey: string): Promise<number> {
    return this.guard('invalidateByTag', () => this.inner.invalidateByTag(tagKey));
  }

  ping(): Promise<boolean> {
    return this.guard('ping', () => this.inner.ping());
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  size(): Promise<number> {
    return this.guard('size', () => this.inner.size());
  }
}

/** Fake Redis 条目 */
interface FakeEntry {
  value: string;
  expireAt: number;
}

/** Fake Redis 集合条目 */
interface FakeSet {
  members: Set<string>;
  expireAt: number;
}

/**
 * Fake Redis 客户端：以内存模型实现框架用到的命令子集
 * （字符串 SET PX/NX、GET、MGET、DEL、EXISTS、PEXPIRE；集合 SADD/SMEMBERS；Lua 条件与标签原子操作）
 */
export class FakeRedisClient implements RedisClientLike {
  private readonly strings = new Map<string, FakeEntry>();
  private readonly sets = new Map<string, FakeSet>();
  /** eval 调用次数（断言原子脚本被使用） */
  evalCalls = 0;

  /** 惰性过期检查 */
  private live(key: string): FakeEntry | undefined {
    const entry = this.strings.get(key);
    if (!entry) return undefined;
    if (entry.expireAt <= Date.now()) {
      this.strings.delete(key);
      return undefined;
    }
    return entry;
  }

  /** WRONGTYPE 建模（A-01）：键以集合形态存活时，字符串读命令必须报错（对齐真实 Redis） */
  private assertNotSet(key: string): void {
    if (this.liveSet(key)) {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value: ${key}`);
    }
  }

  /** WRONGTYPE 建模（A-01）：键以字符串形态存活时，集合命令必须报错（对齐真实 Redis） */
  private assertNotString(key: string): void {
    if (this.live(key)) {
      throw new Error(`WRONGTYPE Operation against a key holding the wrong kind of value: ${key}`);
    }
  }

  async get(key: string): Promise<string | null> {
    this.assertNotSet(key);
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
    const pxIndex = args.indexOf('PX');
    const ttlMs = pxIndex >= 0 ? Number(args[pxIndex + 1]) : Number.POSITIVE_INFINITY;
    if (args.includes('NX') && this.live(key)) return null;
    // SET 覆盖任意类型（对齐 Redis）：先清除可能存在的同键集合条目
    this.sets.delete(key);
    this.strings.set(key, { value, expireAt: ttlMs === Number.POSITIVE_INFINITY ? Number.POSITIVE_INFINITY : Date.now() + ttlMs });
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed++;
      else if (this.sets.delete(key)) removed++;
    }
    return removed;
  }

  async exists(key: string): Promise<number> {
    // EXISTS 对任意类型可用（对齐 Redis）
    if (this.live(key)) return 1;
    return this.liveSet(key) ? 1 : 0;
  }

  async pexpire(key: string, ms: number): Promise<number> {
    const entry = this.live(key);
    if (entry) {
      entry.expireAt = Date.now() + ms;
      return 1;
    }
    const set = this.liveSet(key);
    if (set) {
      set.expireAt = Date.now() + ms;
      return 1;
    }
    return 0;
  }

  async mget(...keys: string[]): Promise<Array<string | null>> {
    return keys.map((key) => this.live(key)?.value ?? null);
  }

  async sadd(key: string, ...members: string[]): Promise<number> {
    // WRONGTYPE 建模：字符串键上执行 SADD 报错（对齐真实 Redis；SET 覆盖任意类型则不在此列）
    this.assertNotString(key);
    const existing = this.liveSet(key);
    const bucket = existing ?? { members: new Set<string>(), expireAt: Number.POSITIVE_INFINITY };
    let added = 0;
    for (const member of members) {
      if (!bucket.members.has(member)) {
        bucket.members.add(member);
        added++;
      }
    }
    this.sets.set(key, bucket);
    return added;
  }

  async smembers(key: string): Promise<string[]> {
    // WRONGTYPE 建模：字符串键上执行 SMEMBERS 报错；集合键合法放行
    this.assertNotString(key);
    return [...(this.liveSet(key)?.members ?? [])];
  }

  /**
   * 按脚本内容模拟 Lua：
   * - SET+ SADD：SET_TAGS 带标签登记原子脚本（KEYS=[值键,标签键...]，ARGV=[值,值TTL,各标签TTL...]）；
   * - SMEMBERS：INVALIDATE_TAG 失效原子脚本（KEYS[1]=标签键，返回删除成员数）；
   * - SADD：SADD+PEXPIRE 集合登记原子脚本；
   * - 其余：GET 比较后 PEXPIRE / DEL（锁的条件操作）。
   */
  async eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.evalCalls++;
    if (script.includes("'SET'") && script.includes('SADD')) {
      // 带标签登记原子脚本：KEYS[1]=值键，KEYS[2..n]=标签键；ARGV=[值, 值TTL, 各标签TTL...]
      const keys = args.slice(0, numKeys) as string[];
      const argv = args.slice(numKeys) as [string, number, ...number[]];
      const [value, valueTtl, ...tagTtls] = argv;
      this.strings.set(keys[0], { value, expireAt: Date.now() + Number(valueTtl) });
      for (let i = 1; i < keys.length; i++) {
        await this.sadd(keys[i], keys[0]);
        const set = this.liveSet(keys[i]);
        if (set) set.expireAt = Date.now() + Number(tagTtls[i - 1]);
      }
      return null;
    }
    if (script.includes('SMEMBERS')) {
      // 标签失效原子脚本：读成员 → 逐个 DEL → DEL 索引，单次 eval 内完成
      const tagKey = args[0] as string;
      const members = await this.smembers(tagKey);
      let removed = 0;
      for (const member of members) {
        removed += await this.del(member);
      }
      await this.del(tagKey);
      return removed;
    }
    const [key, ...rest] = args as [string, ...Array<string | number>];
    if (script.includes('SADD')) {
      // 集合登记原子脚本：ARGV[1]=TTL，其余为成员；SADD 与 PEXPIRE 必须同一次 eval 内完成
      const [ttl, ...members] = rest as [number, ...string[]];
      const added = await this.sadd(key, ...members);
      const set = this.liveSet(key);
      if (set) set.expireAt = Date.now() + Number(ttl);
      return added;
    }
    const [expected, ttl] = rest as [string, number | undefined];
    // WRONGTYPE 建模：Lua 条件脚本内的 GET 对集合键报错（对齐真实 Redis eval 行为）
    this.assertNotSet(key);
    const entry = this.live(key);
    if (!entry || entry.value !== expected) return 0;
    if (script.includes('pexpire')) {
      entry.expireAt = Date.now() + Number(ttl);
      return 1;
    }
    this.strings.delete(key);
    return 1;
  }

  async ping(): Promise<string> {
    return 'PONG';
  }

  async quit(): Promise<unknown> {
    return 'OK';
  }

  disconnect(): void {
    /* 无连接可断 */
  }

  async dbsize(): Promise<number> {
    return this.strings.size + this.sets.size;
  }

  on(_event: string, _handler: (...args: unknown[]) => void): unknown {
    return this;
  }

  /** 直接写入原始值（模拟外部写入/人工数据） */
  raw(key: string, value: string, ttlMs = 60000): void {
    this.strings.set(key, { value, expireAt: Date.now() + ttlMs });
  }

  private liveSet(key: string): FakeSet | undefined {
    const set = this.sets.get(key);
    if (!set) return undefined;
    if (set.expireAt <= Date.now()) {
      this.sets.delete(key);
      return undefined;
    }
    return set;
  }
}
