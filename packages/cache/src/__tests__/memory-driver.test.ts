/*
 * @file memory 驱动单测
 * @description 验证进程内驱动的行为契约：读写、TTL 惰性过期、非法 TTL 拒绝、SET NX、批量与条件操作、
 *   集合（标签映射）、LRU 容量淘汰与观测（TC-CACHE-001 memory 侧）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { describe, expect, it } from 'vitest';
import { MemoryCacheStore } from '../drivers/memory.driver.js';

/** 短睡眠（TTL 过期验证用） */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('@fw/cache · memory 驱动', () => {
  it('读写与 TTL 过期（惰性淘汰）', async () => {
    const store = new MemoryCacheStore();
    await store.set('k', 'v', 30);
    expect(await store.get('k')).toBe('v');
    await sleep(45);
    expect(await store.get('k')).toBeUndefined();
    expect(await store.exists('k')).toBe(false);
  });

  it('拒绝非正数 TTL（禁止无过期缓存）', async () => {
    const store = new MemoryCacheStore();
    await expect(store.set('k', 'v', 0)).rejects.toThrow(/TTL 必须为正数/);
    await expect(store.set('k', 'v', Number.POSITIVE_INFINITY)).rejects.toThrow(/TTL 必须为正数/);
  });

  it('SET NX 仅在键不存在时写入', async () => {
    const store = new MemoryCacheStore();
    expect(await store.setNx('lock', 'a', 1000)).toBe(true);
    expect(await store.setNx('lock', 'b', 1000)).toBe(false);
    expect(await store.get('lock')).toBe('a');
  });

  it('del / exists / expire / mget 行为一致', async () => {
    const store = new MemoryCacheStore();
    await store.set('a', '1', 1000);
    await store.set('b', '2', 1000);
    expect(await store.mget(['a', 'b', 'c'])).toEqual(['1', '2', undefined]);
    expect(await store.expire('a', 30)).toBe(true);
    expect(await store.expire('missing', 30)).toBe(false);
    await sleep(45);
    expect(await store.get('a')).toBeUndefined();
    expect(await store.del(['b', 'missing'])).toBe(1);
  });

  it('集合登记去重并按标签读取（标签失效基础）', async () => {
    const store = new MemoryCacheStore();
    await store.sadd('tag', ['k1', 'k2'], 1000);
    await store.sadd('tag', ['k2', 'k3'], 1000);
    expect((await store.smembers('tag')).sort()).toEqual(['k1', 'k2', 'k3']);
    expect(await store.smembers('absent')).toEqual([]);
  });

  it('条件删除与条件续期仅在值匹配时生效（锁安全释放）', async () => {
    const store = new MemoryCacheStore();
    await store.set('lock', 'token-a', 1000);
    expect(await store.compareAndExpire('lock', 'wrong', 1000)).toBe(false);
    expect(await store.compareAndDelete('lock', 'wrong')).toBe(false);
    expect(await store.compareAndExpire('lock', 'token-a', 50)).toBe(true);
    expect(await store.compareAndDelete('lock', 'token-a')).toBe(true);
    expect(await store.get('lock')).toBeUndefined();
  });

  it('容量超限按 LRU 淘汰，命中会刷新热度', async () => {
    const store = new MemoryCacheStore(2);
    await store.set('a', '1', 10_000);
    await store.set('b', '2', 10_000);
    // 访问 a 使其成为最近使用，写入 c 时淘汰 b
    expect(await store.get('a')).toBe('1');
    await store.set('c', '3', 10_000);
    expect(await store.get('b')).toBeUndefined();
    expect(await store.get('a')).toBe('1');
    expect(await store.get('c')).toBe('3');
    expect(store.evictedCount()).toBe(1);
    expect(await store.size()).toBe(2);
  });

  it('ping / close / size 可用', async () => {
    const store = new MemoryCacheStore();
    expect(await store.ping()).toBe(true);
    await store.set('x', '1', 1000);
    expect(await store.size()).toBe(1);
    await store.close();
    expect(await store.size()).toBe(0);
    expect(store.kind).toBe('memory');
  });
});
