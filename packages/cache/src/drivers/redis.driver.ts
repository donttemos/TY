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
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复：① C-01/C-03/A-04——新增 `SET_TAGS_LUA`
 *   （写值 + SADD 标签登记单条原子）与 `INVALIDATE_TAG_LUA`（SMEMBERS → 逐个 DEL 成员 → DEL 标签集合
 *   单条原子）实现端口新方法 `setWithTags` / `invalidateByTag`，消除写登记半程状态与失效竞态窗口，
 *   失效故障时整体未发生（fail-open 不再误删索引）；② C-05——close() 超时分支改为真正触发
 *   disconnect()（原实现超时仅 resolve，与注释「超时即强制断开」不符），并对 quit() 挂接兜底
 *   catch 防止超时先行返回后的 unhandled rejection。
 * @modified 2026-10-17 donttemo A-01 跨驱动语义对齐 + Cluster 兼容告警：get/smembers/sadd/CAS
 *   类型不符显式抛错（对齐 Redis WRONGTYPE）；构造期检测 `isCluster` 客户端并告警——多键 Lua 在
 *   Cluster 跨 slot 时被拒（CROSSSLOT），策略与限制登记见 ADR-0028；单实例真实 Redis 由 CI
 *   redis:7 service 容器验证（`__tests__/redis-integration.test.ts`）。
 * @modified 2026-10-18 donttemo 复核修复（P1）：`SET_TAGS_LUA` 改为「写前只读预检 + 通过后才写」——
 *   Lua 只保证不可交错执行、**运行期报错不回滚**，此前「先 SET 再逐个 SADD」在某个标签键被占成
 *   字符串（WRONGTYPE）时会留下未登记的缓存值（孤儿缓存）。预检覆盖标签键类型与「标签键 == 值键」，
 *   并补真实 Redis 回归（类型注入后值键不存在）。
 * @modified 2026-10-19 donttemo P1 加固（写序重排 + 故障注入回归）：预检只能收敛**确定性**错误；
 *   预检通过后的**资源类**故障（OOM / 只读副本拒绝写）仍会中止脚本并保留已执行命令。故把写序
 *   从「写值 → 登记索引」改为「登记索引 → 最后写值」：残余故障的最坏结果由不可回收的「孤儿缓存」
 *   （有值无索引，标签失效永远触达不到）转为无害的「幽灵索引」（索引指向不存在的键：失效时
 *   DEL 不存在的键无副作用，且标签集合自身 TTL 到点即回收）。回归：Fake 客户端新增写值阶段故障
 *   注入（`failValueWriteOnce`），真实 Redis 侧以 maxmemory/noeviction 注入 OOM 验证无孤儿（门控
 *   用例 `CACHE_REDIS_INTEGRATION_ALLOW_MEMORY_FAULT`）；同时修正 `INVALIDATE_TAG_LUA` 返回值口径
 *   为**实际删除数**（累加各 DEL），消除「幽灵索引」场景下与 memory 驱动 / 端口契约的语义差异。
 * @module @fw/cache
 */

import type { CacheStorePort, TokenBucketTakeResult } from '../store.port.js';
import type { CacheDriverName } from '../types.js';
import type { RedisClientLike } from './redis-client.js';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';

const logger = Logger.for('cache.redis');

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
 * 带标签登记的写入脚本（C-01/A-04 修复 + 2026-10-18 预检 + 2026-10-19 写序加固）：
 * 写值与向各标签集合登记本键在**单次脚本执行**内完成——语义是「不可交错执行（isolation）」，
 * **不是事务回滚**：Redis 脚本运行期报错时，之前已执行的写命令不会撤销。因此脚本分三步：
 *   ① 只读预检（任何写操作之前）：标签键类型必须是 set 或不存在；标签键不得与值键同名。
 *      确定性错误（最典型是标签键被别的写入方占成字符串 → WRONGTYPE）必须在零写入时暴露，
 *      否则「SET 已成功、SADD 报错」会留下未登记的缓存值（孤儿缓存，重新打开 C-01 要消灭的缺口）。
 *   ② 预检通过后**先登记索引**（SADD + PEXPIRE 每个标签键）。此处若发生资源类故障（OOM /
 *      只读副本拒绝写），最坏结果是「索引已登记、值未写入」的**幽灵索引**：标签失效对它执行
 *      DEL 不存在的键（无副作用，返回 0），标签集合又自带 TTL 会自行回收——失败方向无害。
 *   ③ **最后**写值。把唯一的「值存在性」写入放在末位，使脚本在任何中途失败时都不可能产生
 *      「有值无索引」的孤儿缓存（孤儿缓存无法被标签失效触达，只能等业务 TTL，危害最大）。
 * 残余风险：②③ 之间被外部（非脚本）因素打断时，仅剩幽灵索引这一无害方向。
 * KEYS[1]=值键，KEYS[2..n]=标签映射键；ARGV[1]=值 ARGV[2]=值TTL(ms) ARGV[i+1]=KEYS[i] 的标签集合TTL(ms)。
 * 已知限制：多键脚本在 redis-cluster 跨 slot 时会被拒绝（CROSSSLOT），见 store.port 登记项。
 */
const SET_TAGS_LUA = `
local valueKey = KEYS[1]
for i = 2, #KEYS do
  if KEYS[i] == valueKey then
    return redis.error_reply('ERR 标签键与值键相同（' .. KEYS[i] .. '），已中止写入')
  end
  local kind = redis.call('TYPE', KEYS[i])['ok']
  if kind ~= 'none' and kind ~= 'set' then
    return redis.error_reply('WRONGTYPE 标签索引键不是集合（' .. KEYS[i] .. ' 实际为 ' .. kind .. '），已中止写入，值键未写入')
  end
end
for i = 2, #KEYS do
  redis.call('SADD', KEYS[i], valueKey)
  redis.call('PEXPIRE', KEYS[i], ARGV[i + 1])
end
redis.call('SET', valueKey, ARGV[1], 'PX', ARGV[2])
return nil
`;

/**
 * 原子标签失效脚本（C-01/C-03 修复 + 2026-10-19 返回值对齐）：SMEMBERS → 逐个 DEL 成员 → DEL 标签集合
 * 单次执行完成。与 SET_TAGS_LUA 全序串行后，失效期间完成登记的键要么已被删除、要么重新持有有效索引；
 * 脚本的**首个命令即读取**（SMEMBERS，类型不符在此失败），之后的写命令只有 DEL——不存在
 * 「写了一半遇到运行时错误」的中间态，因此失效故障时整体未发生（isolated，非回滚语义）。
 * 返回**实际删除的成员键数量**（累加每个 DEL 的返回值）——此前返回成员个数，在「幽灵索引」
 * （成员指向不存在的键）场景下会与 memory 驱动 / 端口契约（实际删除数）不一致。
 * KEYS[1]=标签映射键。cluster 跨 slot 限制同 SET_TAGS_LUA。
 */
const INVALIDATE_TAG_LUA = `
local members = redis.call('SMEMBERS', KEYS[1])
local removed = 0
for _, member in ipairs(members) do
  removed = removed + redis.call('DEL', member)
end
redis.call('DEL', KEYS[1])
return removed
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
  ) {
    // cluster 兼容性告警（ADR-0028）：多键 Lua（setWithTags / invalidateByTag）在跨 slot 时会被
    // Redis Cluster 以 CROSSSLOT 拒绝——标签原子协议当前只保证单实例/同 slot 语义。单实例 Redis
    // 无此限制（CI redis:7 service 已验证）；指向 Cluster 时显式告警，避免线上才踩。
    if (client.isCluster === true) {
      logger.warn('redis 客户端为集群实例：标签原子操作（setWithTags / invalidateByTag）的多键 Lua 在跨 slot 时将被拒绝（CROSSSLOT）；兼容策略与限制登记见 ADR-0028');
    }
  }

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

  /**
   * 带标签登记的单脚本写入：写前预检（2026-10-18）→ 登记索引 → 最后写值（2026-10-19 写序加固）。
   * 确定性错误（WRONGTYPE / 标签键撞值键）在零写入时失败；资源类故障的最坏残余为无害幽灵索引。
   */
  async setWithTags(
    key: string,
    value: string,
    ttlMs: number,
    tags: ReadonlyArray<{ tagKey: string; ttlMs: number }>,
  ): Promise<void> {
    this.assertTtl(ttlMs);
    if (tags.length === 0) {
      await this.set(key, value, ttlMs);
      return;
    }
    for (const tag of tags) this.assertTtl(tag.ttlMs);
    // KEYS[1]=值键，KEYS[2..n]=标签键；ARGV=[值, 值TTL, 各标签TTL...]（与 KEYS[2..n] 一一对齐）
    await this.client.eval(
      SET_TAGS_LUA,
      1 + tags.length,
      key,
      ...tags.map((tag) => tag.tagKey),
      value,
      Math.round(ttlMs),
      ...tags.map((tag) => Math.round(tag.ttlMs)),
    );
  }

  /** 原子标签失效：SMEMBERS + DEL 成员 + DEL 索引单条 Lua（C-01/C-03 修复） */
  async invalidateByTag(tagKey: string): Promise<number> {
    const result = await this.client.eval(INVALIDATE_TAG_LUA, 1, tagKey);
    return Number(result);
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
    let timer: NodeJS.Timeout | undefined;
    try {
      const quitting = this.client.quit();
      // 超时分支先行返回后 quit 仍可能失败：挂接兜底 catch，避免 unhandled rejection
      void quitting.catch(() => undefined);
      // quit 可能因连接半开挂住：超时分支 reject 触发强制断开（C-05 修复——
      // 原实现超时分支仅 resolve，disconnect 只在 quit 抛错时执行，注释承诺落空）
      await Promise.race([
        quitting,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`quit 超时（${CLOSE_TIMEOUT_MS}ms），强制断开`)), CLOSE_TIMEOUT_MS);
          timer.unref?.();
        }),
      ]);
    } catch {
      // 超时或 quit 在断连场景抛错：兜底强制断开
      this.client.disconnect();
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async size(): Promise<number> {
    // 说明：dbsize 为整库键数（无法按前缀过滤），此处作为容量观测的近似值——
    // 端口语义为「观测近似」，不保证 memory/redis 两种驱动的数值可比（见 store.port 注释）。
    // A-05 登记：redis-cluster 模式下 DBSIZE 为**单节点**键数（ioredis Cluster 路由到单个节点执行），
    // 不代表集群总键数；仅可用于容量趋势观测，跨节点求和需运维侧聚合，禁止业务判定。
    return this.client.dbsize();
  }

  /** 校验 TTL：禁止无过期写入 */
  private assertTtl(ttlMs: number): void {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) {
      throw new BizError(ErrorCode.CONFIG_INVALID_VALUE, `缓存 TTL 必须为正数（毫秒）：收到 ${ttlMs}；禁止无过期时间的缓存`);
    }
  }
}

/**
 * 解析令牌桶 Lua 返回值 [allowed, remaining, retryAfterMs]。
 * 逐项校验形状，不依赖 as 元组断言——异常形状按「拒绝 + 无等待建议」降级，不静默吞错。
 */
function parseTokenBucketResult(raw: unknown): TokenBucketTakeResult {
  if (!Array.isArray(raw) || raw.length < 3) {
    throw new BizError(ErrorCode.INTERNAL, `令牌桶脚本返回形状异常：期望 [allowed, remaining, retryAfterMs]，收到 ${JSON.stringify(raw)}`);
  }
  const [allowedRaw, remainingRaw, retryRaw] = raw as [unknown, unknown, unknown];
  const allowed = Number(allowedRaw);
  const remaining = Number(remainingRaw);
  const retry = Number(retryRaw);
  if (!Number.isFinite(allowed) || !Number.isFinite(remaining) || !Number.isFinite(retry)) {
    throw new BizError(ErrorCode.INTERNAL, `令牌桶脚本返回项非法：${JSON.stringify(raw)}`);
  }
  return { allowed: allowed === 1, remaining, retryAfterMs: retry };
}
