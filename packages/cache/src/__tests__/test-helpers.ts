/*
 * @file 测试辅助：桩配置、可故障存储、Fake Redis 客户端
 * @description 单测共用的替身实现：`makeOptions` 统一运行时配置；`FaultyStore` 支持一键注入存储故障
 *   （验证 TC-CACHE-007/008 降级与回切）；`FakeRedisClient` 以内存模型实现 RedisClientLike，
 *   使 redis 驱动可在无真实 Redis 的沙箱内完整验证（TC-CACHE-001/009）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复配套：FakeRedisClient.eval 增加 SADD+PEXPIRE
 *   原子脚本分支（驱动侧集合登记已合并为单条 Lua）
 * @module @fw/cache
 */

import type { RedisClientLike } from '../drivers/redis-client.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import type { CacheStorePort } from '../store.port.js';
import type { CacheRuntimeOptions } from '../types.js';

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

  /** 故障时抛错，否则透传 */
  private async guard<T>(fn: () => Promise<T>): Promise<T> {
    if (this.broken) {
      this.failures++;
      throw new Error('模拟缓存依赖故障（connection refused）');
    }
    return fn();
  }

  get(key: string): Promise<string | undefined> {
    return this.guard(() => this.inner.get(key));
  }

  set(key: string, value: string, ttlMs: number): Promise<void> {
    return this.guard(() => this.inner.set(key, value, ttlMs));
  }

  setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    return this.guard(() => this.inner.setNx(key, value, ttlMs));
  }

  del(keys: readonly string[]): Promise<number> {
    return this.guard(() => this.inner.del(keys));
  }

  exists(key: string): Promise<boolean> {
    return this.guard(() => this.inner.exists(key));
  }

  expire(key: string, ttlMs: number): Promise<boolean> {
    return this.guard(() => this.inner.expire(key, ttlMs));
  }

  mget(keys: readonly string[]): Promise<Array<string | undefined>> {
    return this.guard(() => this.inner.mget(keys));
  }

  sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    return this.guard(() => this.inner.sadd(key, members, ttlMs));
  }

  smembers(key: string): Promise<string[]> {
    return this.guard(() => this.inner.smembers(key));
  }

  compareAndDelete(key: string, expected: string): Promise<boolean> {
    return this.guard(() => this.inner.compareAndDelete(key, expected));
  }

  compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    return this.guard(() => this.inner.compareAndExpire(key, expected, ttlMs));
  }

  ping(): Promise<boolean> {
    return this.guard(() => this.inner.ping());
  }

  close(): Promise<void> {
    return this.inner.close();
  }

  size(): Promise<number> {
    return this.guard(() => this.inner.size());
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
 * （字符串 SET PX/NX、GET、MGET、DEL、EXISTS、PEXPIRE；集合 SADD/SMEMBERS；Lua 条件操作）
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

  async get(key: string): Promise<string | null> {
    return this.live(key)?.value ?? null;
  }

  async set(key: string, value: string, ...args: Array<string | number>): Promise<unknown> {
    const pxIndex = args.indexOf('PX');
    const ttlMs = pxIndex >= 0 ? Number(args[pxIndex + 1]) : Number.POSITIVE_INFINITY;
    if (args.includes('NX') && this.live(key)) return null;
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
    return this.live(key) ? 1 : 0;
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
    return [...(this.liveSet(key)?.members ?? [])];
  }

  /** 按脚本内容模拟 Lua：SADD+PEXPIRE（集合登记原子脚本）/ GET 比较后 DEL / PEXPIRE */
  async eval(script: string, _numKeys: number, ...args: Array<string | number>): Promise<unknown> {
    this.evalCalls++;
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
