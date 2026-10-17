/*
 * @file 真实 Redis 单实例集成测试（回归测试设计 §9.4 / v0.6.0 发版后补齐）
 * @description Fake 客户端只能验证驱动调用映射与内存模型语义，**不能证明 Redis 服务端自身的
 *   原子性与类型系统行为**（store-contract.test.ts 注释已登记该边界）。本文件连真实 Redis
 *   单实例，验证四类只有真服务端才能证明的契约：
 *   ① 标签原子协议（setWithTags / invalidateByTag 的 Lua 在真实服务端执行：写值+登记单次原子、
 *      读成员+删成员+删索引单次原子、失效-写入并发不变式）；
 *   ② 锁 CAS（SET NX 竞争单胜者、compareAndDelete/Expire 令牌隔离、重入与反序释放）；
 *   ③ 真服务器端 TTL 过期（非驱动惰性删除）；
 *   ④ 故障路径（WRONGTYPE 类型错误、连接中断后 fail-open 降级 / fail-closed 拒绝、
 *      连接被外部 kill 后自动重连韧性）。
 *   门控：环境变量 `CACHE_REDIS_INTEGRATION_URL` 未设置时整组 skip（本地默认无 Redis）；
 *   CI base 作业以 redis:7-alpine service 容器提供并设置该变量。
 *   关停用例（⑤）另需 `CACHE_REDIS_INTEGRATION_ALLOW_SHUTDOWN=true` 才执行——它会 SHUTDOWN
 *   目标实例，对共享的本地 Redis 是破坏性操作，默认跳过；CI 的 service 容器一次性，设置执行。
 *   已知限制：redis-cluster 跨 slot 多键 Lua（CROSSSLOT）无法在单实例上验证——cluster 兼容
 *   策略与限制登记见 ADR-0028。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/cache
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import Redis from 'ioredis';
import { CacheUnavailableError } from '../errors.js';
import { CacheService } from '../cache.service.js';
import { LockManager } from '../lock.js';
import { RedisCacheStore } from '../drivers/redis.driver.js';
import { makeOptions } from './test-helpers.js';

const REDIS_URL = process.env.CACHE_REDIS_INTEGRATION_URL;

/** 未设置门控变量时整组跳过（本地无 Redis 的默认形态） */
const integration = REDIS_URL ? describe : describe.skip;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let client: Redis;
let killer: Redis;
/** 每轮运行唯一前缀，避免与其他测试/遗留键相互干扰 */
let prefix: string;

integration('真实 Redis 单实例集成（CACHE_REDIS_INTEGRATION_URL）', () => {
  beforeAll(async () => {
    client = new Redis(REDIS_URL as string, { lazyConnect: false });
    await client.ping();
    prefix = `it-${Date.now().toString(36)}`;
  });

  afterAll(async () => {
    // 清场：删除本组写入的键（SHUTDOWN 失败路径执行后连接已断，try/catch 兜底）
    try {
      const stale = await client.keys(`${prefix}:*`);
      if (stale.length > 0) await client.del(...stale);
      await client.quit();
    } catch {
      /* 失败路径用例已关停 Redis，忽略 */
    }
    try {
      await killer?.quit();
    } catch {
      /* 同上 */
    }
  });

  // ---------- ① 标签写入：Lua 在真实服务端单次完成写值 + 登记 ----------

  it('setWithTags：值与标签登记单条 Lua 原子完成，TTL 分别生效', async () => {
    const store = new RedisCacheStore(client);
    const valueKey = `${prefix}:tag-write:v1`;
    const tagKey = `${prefix}:__tag__:t1`;
    const tagKey2 = `${prefix}:__tag__:t2`;

    await store.setWithTags(valueKey, 'v1', 5000, [
      { tagKey, ttlMs: 10_000 },
      { tagKey: tagKey2, ttlMs: 10_000 },
    ]);

    expect(await store.get(valueKey)).toBe('v1');
    expect(await store.smembers(tagKey)).toEqual([valueKey]);
    expect(await store.smembers(tagKey2)).toEqual([valueKey]);
    // 真服务端 PEXPIRE：值 TTL ≈ 5s、集合 TTL ≈ 10s（均未立即过期）
    const valueTtl = await client.pttl(valueKey);
    const tagTtl = await client.pttl(tagKey);
    expect(valueTtl).toBeGreaterThan(0);
    expect(valueTtl).toBeLessThanOrEqual(5000);
    expect(tagTtl).toBeGreaterThan(5000);
    expect(tagTtl).toBeLessThanOrEqual(10_000);
  });

  it('真服务器端 TTL 过期：值与标签索引同步消失（非驱动惰性删除）', async () => {
    const store = new RedisCacheStore(client);
    const valueKey = `${prefix}:expire:v1`;
    const tagKey = `${prefix}:__tag__:expire-tag`;
    await store.setWithTags(valueKey, 'v', 150, [{ tagKey, ttlMs: 150 }]);
    expect(await store.get(valueKey)).toBe('v');

    await sleep(300);
    expect(await store.get(valueKey)).toBeUndefined();
    expect(await store.smembers(tagKey)).toEqual([]);
    expect(await store.exists(tagKey)).toBe(false);
  });

  // ---------- ② 标签失效：Lua 原子删成员 + 删索引；并发不变式 ----------

  it('invalidateByTag：删成员与索引、返回数量、二次失效为 0、无关键不动', async () => {
    const store = new RedisCacheStore(client);
    const k1 = `${prefix}:inv:k1`;
    const k2 = `${prefix}:inv:k2`;
    const keep = `${prefix}:inv:keep`;
    const tagKey = `${prefix}:__tag__:inv-tag`;
    await store.setWithTags(k1, 'v1', 10_000, [{ tagKey, ttlMs: 30_000 }]);
    await store.setWithTags(k2, 'v2', 10_000, [{ tagKey, ttlMs: 30_000 }]);
    await store.set(keep, 'v', 10_000);

    expect(await store.invalidateByTag(tagKey)).toBe(2);
    expect(await store.get(k1)).toBeUndefined();
    expect(await store.get(k2)).toBeUndefined();
    expect(await store.smembers(tagKey)).toEqual([]);
    expect(await store.get(keep)).toBe('v');
    // 索引已删：再次失效返回 0（不再有孤儿删除动作）
    expect(await store.invalidateByTag(tagKey)).toBe(0);
  });

  it('失效 × 写入并发不变式（真服务端原子性）：无孤儿键、无幽灵索引', async () => {
    const storeA = new RedisCacheStore(client);
    const storeB = new RedisCacheStore(client);
    // 多轮交错压测：两条 Lua 在服务端全序串行，任一交叉结果都必须满足不变式
    for (let round = 0; round < 5; round += 1) {
      const tagKey = `${prefix}:__tag__:race-${round}`;
      const oldKey = `${prefix}:race-${round}:old`;
      const newKey = `${prefix}:race-${round}:new`;
      await storeA.setWithTags(oldKey, 'old', 10_000, [{ tagKey, ttlMs: 30_000 }]);

      const invalidation = storeA.invalidateByTag(tagKey);
      const write = storeB.setWithTags(newKey, 'new', 10_000, [{ tagKey, ttlMs: 30_000 }]);
      const [removed] = await Promise.all([invalidation, write]);

      const newExists = await storeB.exists(newKey);
      const members = await storeB.smembers(tagKey);
      // 不变式：键存在 ⟺ 仍被索引追踪（任一方向失衡即为孤儿/幽灵）
      expect(newExists).toBe(members.includes(newKey));
      // 返回值自洽：删除数 = 失效时刻确实存在的成员数
      expect(removed).toBeGreaterThanOrEqual(0);
      expect(removed).toBeLessThanOrEqual(2);
      // 旧键必被清（失效覆盖写入前状态）
      expect(await storeB.exists(oldKey)).toBe(false);
    }
  });

  // ---------- ③ 锁操作：SET NX / CAS 的真实语义 ----------

  it('SET NX 竞争：两个独立客户端只有一个取得锁', async () => {
    const storeA = new RedisCacheStore(client);
    const storeB = new RedisCacheStore(client);
    const lockKey = `${prefix}:lock:nx-race`;
    const managerA = new LockManager(storeA, 5000);
    const managerB = new LockManager(storeB, 5000);

    const [a, b] = await Promise.all([managerA.acquire(lockKey, 5000), managerB.acquire(lockKey, 5000)]);
    const winners = [a, b].filter((h) => h !== null);
    expect(winners).toHaveLength(1);

    await winners[0]!.release();
    // 释放后第三方可取得
    const third = await managerB.acquire(lockKey, 5000);
    expect(third).not.toBeNull();
    await third!.release();
  });

  it('CAS 令牌语义：renew/compareAndDelete 不匹配即失败，释放幂等', async () => {
    const store = new RedisCacheStore(client);
    const lockKey = `${prefix}:lock:cas`;
    const manager = new LockManager(store, 5000);
    const handle = await manager.acquire(lockKey, 5000);
    expect(handle).not.toBeNull();

    expect(await store.compareAndExpire(lockKey, 'other-token', 5000)).toBe(false);
    expect(await handle!.renew()).toBe(true);
    expect(await store.compareAndDelete(lockKey, 'other-token')).toBe(false);
    expect(await store.get(lockKey)).toBe(handle!.token);

    await handle!.release();
    await handle!.release(); // 幂等：重复释放不炸
    expect(await store.get(lockKey)).toBeUndefined();

    // 令牌隔离：锁被第三方占据后，旧令牌 renew 失败
    const manager2 = new LockManager(store, 5000);
    const h2 = await manager2.acquire(lockKey, 5000);
    expect(h2).not.toBeNull();
    expect(await handle!.renew()).toBe(false);
    expect(await store.get(lockKey)).toBe(h2!.token);
    await h2!.release();
  });

  // ---------- ④ 故障路径：类型错误 / 连接中断 / 外部 kill 重连 ----------

  it('WRONGTYPE：真服务端类型错误显式抛错，原数据不被静默覆盖', async () => {
    const store = new RedisCacheStore(client);
    const strKey = `${prefix}:wrongtype:str`;
    const setKey = `${prefix}:wrongtype:set`;
    await store.set(strKey, 'original', 10_000);
    await store.sadd(setKey, ['m'], 10_000);

    await expect(store.smembers(strKey)).rejects.toThrow();
    await expect(store.sadd(strKey, ['x'], 10_000)).rejects.toThrow();
    await expect(store.get(setKey)).rejects.toThrow();
    await expect(store.compareAndDelete(setKey, 't')).rejects.toThrow();
    // 原数据完好
    expect(await store.get(strKey)).toBe('original');
    expect(await store.smembers(setKey)).toEqual(['m']);
  });

  it('连接被外部 kill 后自动重连，后续命令继续成功（韧性）', async () => {
    const storeClient = new Redis(REDIS_URL as string);
    const store = new RedisCacheStore(storeClient);
    const key = `${prefix}:resilience`;
    await store.set(key, 'v1', 10_000);

    killer = new Redis(REDIS_URL as string);
    const connId = await storeClient.call('CLIENT', 'ID');
    // CLIENT KILL ID 返回「杀掉的连接数」（Redis 8 实测为 1，非 'OK' 状态回复）
    expect(await killer.call('CLIENT', 'KILL', 'ID', String(connId))).toBe(1);
    await sleep(200);

    // ioredis 对意外断连自动重连：命令在重连后成功（无需人工干预）
    // 注意：RedisCacheStore.set 返回 void（端口签名），断言「不拒绝 + 值确实写入」即为重连成功
    await expect(store.set(key, 'v2', 10_000)).resolves.toBeUndefined();
    expect(await store.get(key)).toBe('v2');
    await storeClient.quit();
  });

  // ---------- ⑤ Redis 关停后的降级契约（默认不执行：破坏性；CI 容器设 ALLOW_SHUTDOWN） ----------

  const shutdownCase = process.env.CACHE_REDIS_INTEGRATION_ALLOW_SHUTDOWN === 'true' ? it : it.skip;

  shutdownCase('依赖不可用：fail-open 降级返回空 / fail-closed 抛 CacheUnavailableError', async () => {
    // 关停 Redis（SHUTDOWN 的回复随连接断开丢失，promise 永不 settle——用超时赛跑兜底）
    await Promise.race([client.call('SHUTDOWN', 'NOSAVE').catch(() => undefined), sleep(500)]);
    await sleep(1000);

    const downClient = new Redis(REDIS_URL as string, {
      connectTimeout: 1000,
      maxRetriesPerRequest: 1,
      retryStrategy: () => null,
      // 关停即拒：不排队等重连，让故障路径立即以拒绝形态到达调用方
      enableOfflineQueue: false,
    });
    const downStore = new RedisCacheStore(downClient);

    const openCache = new CacheService({ store: downStore, options: makeOptions({ prefix, failOpen: true }) });
    expect(await openCache.get('any-key')).toBeUndefined();
    expect(openCache.metricsSnapshot().errors).toBeGreaterThan(0);

    const closedCache = new CacheService({ store: downStore, options: makeOptions({ prefix, failOpen: false }) });
    await expect(closedCache.get('any-key')).rejects.toThrow(CacheUnavailableError);

    // 锁在依赖不可用时同样拒绝（CacheService.lock 的 fail-closed 语义）
    await expect(closedCache.lock('any-lock')).rejects.toThrow(CacheUnavailableError);

    try {
      downClient.disconnect();
    } catch {
      /* 已断开 */
    }
  });
});
