/*
 * @file redis 驱动单测（Fake 客户端）
 * @description 以 FakeRedisClient 验证 redis 与 redis-cluster 驱动的命令映射：SET PX/NX、MGET 空值归一化、
 *   集合登记、条件操作走 Lua、TTL 校验与 PONG 探测；使 TC-CACHE-001/009 可在无真实 Redis 的沙箱内闭环。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复配套：集合登记断言改「单条 Lua 原子」；
 *   parseClusterNodes 用例覆盖凭据段（密码不进 host）
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复配套：新增 setWithTags / invalidateByTag
 *   原子脚本用例（C-01/C-03/A-04）与 close() 超时强制断开用例（C-05）。
 * @module @fw/cache
 */

import { describe, expect, it, vi } from 'vitest';
import { RedisCacheStore } from '../drivers/redis.driver.js';
import { parseClusterNodes } from '../drivers/redis-client.js';
import type { RedisClientLike } from '../drivers/redis-client.js';
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

  it('集合登记走单条 Lua（SADD + PEXPIRE 原子），TTL 同步生效（防幽灵缓存）', async () => {
    const { store, client } = makeStore();
    await store.sadd('tag', ['k1', 'k2'], 60000);
    expect(await client.smembers('tag')).toEqual(['k1', 'k2']);
    expect(await store.smembers('tag')).toEqual(['k1', 'k2']);
    // 原子性证明：SADD 与 PEXPIRE 在同一条脚本内完成（非两步命令——中间崩溃集合会失去 TTL 永存）
    expect(client.evalCalls).toBe(1);
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

  it('C-01/A-04 回归：setWithTags 单条 Lua 原子完成写值与多标签登记', async () => {
    const { store, client } = makeStore();
    await store.setWithTags('k', 'v', 5000, [
      { tagKey: 'tag:1', ttlMs: 60_000 },
      { tagKey: 'tag:2', ttlMs: 120_000 },
    ]);
    // 单次 eval（原子性证明），值与两个标签集合同时落位
    expect(client.evalCalls).toBe(1);
    expect(await store.get('k')).toBe('v');
    expect(await store.smembers('tag:1')).toEqual(['k']);
    expect(await store.smembers('tag:2')).toEqual(['k']);
    // 各标签 TTL 独立生效
    expect(await client.pexpire('tag:1', 1)).toBe(1);
    expect(await client.pexpire('tag:2', 1)).toBe(1);
    // 无标签时退化为普通 SET（不再走 Lua）
    const before = client.evalCalls;
    await store.setWithTags('k2', 'v2', 5000, []);
    expect(client.evalCalls).toBe(before);
    expect(await store.get('k2')).toBe('v2');
  });

  it('C-01/C-03 回归：invalidateByTag 单条 Lua 原子删除成员与索引并返回数量', async () => {
    const { store, client } = makeStore();
    await store.setWithTags('k1', 'v1', 5000, [{ tagKey: 'tag', ttlMs: 60_000 }]);
    await store.setWithTags('k2', 'v2', 5000, [{ tagKey: 'tag', ttlMs: 60_000 }]);
    await store.set('keep', 'v', 5000);
    const before = client.evalCalls;
    expect(await store.invalidateByTag('tag')).toBe(2);
    expect(client.evalCalls).toBe(before + 1);
    expect(await store.get('k1')).toBeUndefined();
    expect(await store.get('k2')).toBeUndefined();
    expect(await store.smembers('tag')).toEqual([]);
    expect(await store.get('keep')).toBe('v');
    // 索引已删：再次失效返回 0
    expect(await store.invalidateByTag('tag')).toBe(0);
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

  it('C-05 回归：quit 挂起超时后强制 disconnect（优雅停机不被阻塞）', async () => {
    vi.useFakeTimers();
    try {
      const disconnect = vi.fn();
      const hangingClient = {
        quit: () => new Promise(() => undefined), // 永不 resolve（模拟连接半开）
        disconnect,
      } as unknown as RedisClientLike;
      const store = new RedisCacheStore(hangingClient);
      const closing = store.close();
      await vi.advanceTimersByTimeAsync(3000);
      await closing;
      expect(disconnect).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it('C-05 回归：quit 正常完成时清理超时定时器、不触发 disconnect', async () => {
    vi.useFakeTimers();
    try {
      const disconnect = vi.fn();
      const client = {
        quit: async () => 'OK',
        disconnect,
      } as unknown as RedisClientLike;
      const store = new RedisCacheStore(client);
      await store.close();
      await vi.advanceTimersByTimeAsync(5000);
      expect(disconnect).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it('集群连接串解析支持协议前缀、默认端口与凭据段（密码不进 host）', () => {
    const plain = parseClusterNodes('127.0.0.1:7000,redis://10.0.0.1:7001,host-only');
    expect(plain.nodes).toEqual([
      { host: '127.0.0.1', port: 7000 },
      { host: '10.0.0.1', port: 7001 },
      { host: 'host-only', port: 6379 },
    ]);
    expect(plain.password).toBeUndefined();

    // redis://:pwd@host:port —— 此前把用户信息段当进 host 解析，得到空 host，集群直接连不上
    const withPwd = parseClusterNodes('redis://:s3cret@10.0.0.1:7000,redis://10.0.0.2:7001');
    expect(withPwd.nodes).toEqual([
      { host: '10.0.0.1', port: 7000 },
      { host: '10.0.0.2', port: 7001 },
    ]);
    expect(withPwd.password).toBe('s3cret');

    // redis://user:pwd@host —— Redis 忽略用户名，密码取冒号后段
    const withUser = parseClusterNodes('redis://default:pw@10.0.0.1:7000');
    expect(withUser.nodes).toEqual([{ host: '10.0.0.1', port: 7000 }]);
    expect(withUser.password).toBe('pw');
  });
});
