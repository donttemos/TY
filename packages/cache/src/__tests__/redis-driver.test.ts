/*
 * @file redis 驱动单测（Fake 客户端）
 * @description 以 FakeRedisClient 验证 redis 与 redis-cluster 驱动的命令映射：SET PX/NX、MGET 空值归一化、
 *   集合登记、条件操作走 Lua、TTL 校验与 PONG 探测；使 TC-CACHE-001/009 可在无真实 Redis 的沙箱内闭环。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { describe, expect, it } from 'vitest';
import { RedisCacheStore } from '../drivers/redis.driver.js';
import { parseClusterNodes } from '../drivers/redis-client.js';
import { FakeRedisClient } from './test-helpers.js';

/** 构造「驱动 + Fake 客户端」组合 */
function makeStore(kind: 'redis' | 'redis-cluster' = 'redis'): { store: RedisCacheStore; client: FakeRedisClient } {
  const client = new FakeRedisClient();
  const store = new RedisCacheStore(client, kind);
  return { store, client };
}

describe('@fw/cache · redis 驱动', () => {
  it('字符串读写：null 归一化为 undefined', async () => {
    const { store } = makeStore();
    expect(await store.get('missing')).toBeUndefined();
    await store.set('k', 'v', 5000);
    expect(await store.get('k')).toBe('v');
  });

  it('SET NX 语义用于锁获取', async () => {
    const { store } = makeStore();
    expect(await store.setNx('lock', 'a', 5000)).toBe(true);
    expect(await store.setNx('lock', 'b', 5000)).toBe(false);
  });

  it('del / exists / expire / mget', async () => {
    const { store } = makeStore();
    await store.set('a', '1', 5000);
    await store.set('b', '2', 5000);
    expect(await store.exists('a')).toBe(true);
    expect(await store.mget(['a', 'b', 'c'])).toEqual(['1', '2', undefined]);
    expect(await store.expire('a', 5000)).toBe(true);
    expect(await store.del(['a', 'not-exist'])).toBe(1);
    expect(await store.del([])).toBe(0);
    expect(await store.mget([])).toEqual([]);
  });

  it('集合登记（SADD + PEXPIRE）与读取', async () => {
    const { store, client } = makeStore();
    await store.sadd('tag', ['k1', 'k2'], 60000);
    expect(await client.smembers('tag')).toEqual(['k1', 'k2']);
    expect(await store.smembers('tag')).toEqual(['k1', 'k2']);
    // TTL 必须被设置（防幽灵缓存）
    expect(await client.pexpire('tag', 1)).toBe(1);
    await store.sadd('empty-set', [], 60000);
    expect(await store.smembers('empty-set')).toEqual([]);
  });

  it('条件删除/续期走 Lua，令牌不匹配即失败（不误删他人锁）', async () => {
    const { store, client } = makeStore();
    await store.set('lock', 'token-a', 5000);
    expect(await store.compareAndDelete('lock', 'token-x')).toBe(false);
    expect(await store.compareAndExpire('lock', 'token-x', 5000)).toBe(false);
    expect(await store.compareAndExpire('lock', 'token-a', 5000)).toBe(true);
    expect(await store.compareAndDelete('lock', 'token-a')).toBe(true);
    expect(client.evalCalls).toBe(4);
  });

  it('集群驱动与单实例驱动行为一致（kind 仅用于观测区分）', async () => {
    const { store } = makeStore('redis-cluster');
    expect(store.kind).toBe('redis-cluster');
    await store.set('k', 'v', 5000);
    expect(await store.get('k')).toBe('v');
  });

  it('TTL 必须为正数（拒绝无过期写入）', async () => {
    const { store } = makeStore();
    await expect(store.set('k', 'v', 0)).rejects.toThrow(/TTL 必须为正数/);
    await expect(store.setNx('k', 'v', -1)).rejects.toThrow(/TTL 必须为正数/);
    await expect(store.sadd('t', ['k'], 0)).rejects.toThrow(/TTL 必须为正数/);
    await expect(store.compareAndExpire('k', 'v', 0)).rejects.toThrow(/TTL 必须为正数/);
  });

  it('ping / size / close 可用', async () => {
    const { store } = makeStore();
    expect(await store.ping()).toBe(true);
    await store.set('a', '1', 5000);
    expect(await store.size()).toBe(1);
    await store.close();
  });

  it('集群连接串解析支持带协议前缀与默认端口', () => {
    expect(parseClusterNodes('127.0.0.1:7000,redis://10.0.0.1:7001,host-only')).toEqual([
      { host: '127.0.0.1', port: 7000 },
      { host: '10.0.0.1', port: 7001 },
      { host: 'host-only', port: 6379 },
    ]);
  });
});
