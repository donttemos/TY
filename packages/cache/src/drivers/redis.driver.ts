/*
 * @file redis / redis-cluster 缓存驱动
 * @description 基于 ioredis 的存储端口实现：字符串用 SET PX / GET / MGET，集合用 Lua 一次完成
 *   SADD + PEXPIRE（两命令间崩溃会使集合失去 TTL、永久驻留——标签映射必须原子），
 *   条件删除与条件续期用 Lua 保证原子（锁的安全释放与续期，PRD-004 FR-09）。
 *   本文件不 import ioredis，只依赖 RedisClientLike 接口，便于用 fake 客户端跑单测（TC-CACHE-001）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复：① sadd+pexpire 改单条 Lua（消除「中间崩溃集合永存」
 *   的非原子窗口，标签映射与锁类操作对齐同一原子标准）；② tokenBucketTake 的 Lua 在
 *   capacity < cost（或 refill ≤ 0）时返回 retryAfterMs = -1（永不可满足），不再返回误导性的 0；
 *   ③ eval 结果解析改为逐项校验（不再用 as 元组断言掩盖形状错误）；
 *   ④ close() 对 quit() 加 3 秒超时兜底，挂住的连接强制 disconnect，不再阻塞优雅停机。
 * @module @fw/cache
 */

import type { CacheStorePort, TokenBucketTakeResult } from '../store.port.js';
import type { CacheDriverName } from '../types.js';
import type { RedisClientLike } from './redis-client.js';

/** 条件删除脚本：值匹配才删除（锁释放） */
const COMPARE_DELETE_LUA = "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end";

/** 条件续期脚本：值匹配才续期（锁续期） */
const COMPARE_EXPIRE_LUA =
  "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('pexpire', KEYS[1], ARGV[2]) else return 0 end";

/** 集合登记脚本：SADD 与 PEXPIRE 原子完成（ARGV[1]=TTL，其余为成员；返回新增成员数） */
const SADD_PEXPIRE_LUA = `
local added = redis.call('SADD', KEYS[1], unpack(ARGV, 2))
redis.call('PEXPIRE', KEYS[1], ARGV[1])
return added
`;

/**
 * 令牌桶原子取令牌（M10 E-03）：哈希存 tokens/last 两字段，一次 Lua 完成「补充 → 扣减 → 回写 → 续期」。
 * ARGV: [1]=capacity [2]=refillPerSecond [3]=cost [4]=nowMs [5]=ttlMs
 * 返回: [allowed(0/1), remaining, retryAfterMs]；retryAfterMs=-1 表示永不可满足（cost > capacity 配置错误）。
 */
const TOKEN_BUCKET_LUA = `
local tokens = tonumber(redis.call('HGET', KEYS[1], 'tokens'))
local last = tonumber(redis.call('HGET', KEYS[1], 'last'))
local capacity = tonumber(ARGV[1])
local refill = tonumber(ARGV[2])
local cost = tonumber(ARGV[3])
local now = tonumber(ARGV[4])
local ttl = tonumber(ARGV[5])
if tokens == nil or last == nil then
  tokens = capacity
  last = now
end
if now > last then
  tokens = math.min(capacity, tokens + (now - last) / 1000.0 * refill)
  last = now
end
local allowed = 0
local retry = 0
if tokens >= cost then
  tokens = tokens - cost
  allowed = 1
elseif capacity >= cost and refill > 0 then
  retry = math.ceil((cost - tokens) / refill * 1000)
else
  retry = -1
end
redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'last', tostring(last))
redis.call('PEXPIRE', KEYS[1], ttl)
return { allowed, tostring(math.floor(tokens)), retry }
`;

/** close() 等待 quit() 完成的上限（毫秒）：挂住的连接不再阻塞优雅停机 */
const CLOSE_TIMEOUT_MS = 3000;

/**
 * Redis 存储驱动（同时服务 `redis` 与 `redis-cluster` 两种模式）
 */
export class RedisCacheStore implements CacheStorePort {
  /**
   * @param client 已连接的 ioredis 客户端
   * @param kind 驱动名（redis / redis-cluster，仅用于指标与日志区分）
   */
  constructor(
    private readonly client: RedisClientLike,
    readonly kind: CacheDriverName = 'redis',
  ) {}

  async get(key: string): Promise<string | undefined> {
    const raw = await this.client.get(key);
    return raw === null ? undefined : raw;
  }

  async set(key: string, value: string, ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    await this.client.set(key, value, 'PX', Math.round(ttlMs));
  }

  async setNx(key: string, value: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    const result = await this.client.set(key, value, 'PX', Math.round(ttlMs), 'NX');
    return result === 'OK';
  }

  async del(keys: readonly string[]): Promise<number> {
    if (keys.length === 0) return 0;
    return this.client.del(...keys);
  }

  async exists(key: string): Promise<boolean> {
    return (await this.client.exists(key)) === 1;
  }

  async expire(key: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    return (await this.client.pexpire(key, Math.round(ttlMs))) === 1;
  }

  async mget(keys: readonly string[]): Promise<Array<string | undefined>> {
    if (keys.length === 0) return [];
    const values = await this.client.mget(...keys);
    return values.map((value) => (value === null ? undefined : value));
  }

  async sadd(key: string, members: readonly string[], ttlMs: number): Promise<void> {
    this.assertTtl(ttlMs);
    if (members.length === 0) return;
    // 每次登记刷新集合 TTL：映射比业务键活得久，避免「幽灵缓存」（PRD-004 §8）；
    // SADD 与 PEXPIRE 必须原子——两步之间崩溃会让集合失去 TTL 永久驻留，破坏端口契约
    await this.client.eval(SADD_PEXPIRE_LUA, 1, key, Math.round(ttlMs), ...members);
  }

  async smembers(key: string): Promise<string[]> {
    return this.client.smembers(key);
  }

  async compareAndDelete(key: string, expected: string): Promise<boolean> {
    const result = await this.client.eval(COMPARE_DELETE_LUA, 1, key, expected);
    return Number(result) === 1;
  }

  async compareAndExpire(key: string, expected: string, ttlMs: number): Promise<boolean> {
    this.assertTtl(ttlMs);
    const result = await this.client.eval(COMPARE_EXPIRE_LUA, 1, key, expected, Math.round(ttlMs));
    return Number(result) === 1;
  }

  async tokenBucketTake(
    key: string,
    capacity: number,
    refillPerSecond: number,
    cost: number,
    nowMs: number,
  ): Promise<TokenBucketTakeResult> {
    // 桶 TTL = 自然回满时间（含缓冲），冷桶自动回收不永驻
    const ttlMs = Math.ceil((capacity / Math.max(refillPerSecond, 1)) * 1000) + 60_000;
    const raw = await this.client.eval(TOKEN_BUCKET_LUA, 1, key, capacity, refillPerSecond, cost, nowMs, ttlMs);
    return parseTokenBucketResult(raw);
  }

  async ping(): Promise<boolean> {
    return (await this.client.ping()) === 'PONG';
  }

  async close(): Promise<void> {
    try {
      // quit 可能因连接半开挂住：加超时兜底，超时即强制断开，保证优雅停机不被缓存阻塞
      await Promise.race([
        this.client.quit(),
        new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, CLOSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      // quit 在断连场景会抛错，兜底强制断开
      this.client.disconnect();
    }
  }

  async size(): Promise<number> {
    // 说明：dbsize 为整库键数（无法按前缀过滤），此处作为容量观测的近似值——
    // 端口语义为「观测近似」，不保证 memory/redis 两种驱动的数值可比（见 store.port 注释）
    return this.client.dbsize();
  }

  /** 校验 TTL：禁止无过期写入 */
  private assertTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new Error(`缓存 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的缓存`);
    }
  }
}

/**
 * 解析令牌桶 Lua 返回值 [allowed, remaining, retryAfterMs]。
 * 逐项校验形状，不依赖 as 元组断言——异常形状按「拒绝 + 无等待建议」降级，不静默吞错。
 */
function parseTokenBucketResult(raw: unknown): TokenBucketTakeResult {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new Error(`令牌桶脚本返回形状异常：期望 [allowed, remaining, retryAfterMs]，收到 ${JSON.stringify(raw)}`);
  }
  const [allowedRaw, remainingRaw, retryRaw] = raw as [unknown, unknown, unknown];
  const allowed = Number(allowedRaw);
  const remaining = Number(remainingRaw);
  const retry = Number(retryRaw);
  if (!Number.isFinite(allowed) || !Number.isFinite(remaining) || !Number.isFinite(retry)) {
    throw new Error(`令牌桶脚本返回项非法：${JSON.stringify(raw)}`);
  }
  return { allowed: allowed === 1, remaining, retryAfterMs: retry };
}
