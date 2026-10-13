/*
 * @file 单测：执行守卫存储（幂等标记 + 分布式锁）
 * @description 覆盖 MemoryGuardStore（TTL 过期、锁互斥与释放、reset）与 CacheGuardStore
 *   （键前缀、distributed 判定、锁获取失败、透传 ping），确保 cron 集群单跑与幂等的底层语义正确。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import type { CacheService, LockHandle } from '@fw/cache';
import { CacheGuardStore, MemoryGuardStore } from '../guard-store.js';

describe('MemoryGuardStore', () => {
  it('幂等标记写入后可命中，TTL 到期后失效', async () => {
    let clock = 1000;
    const store = new MemoryGuardStore(() => clock);
    expect(await store.hasMarker('k')).toBe(false);
    await store.markDone('k', 2);
    expect(await store.hasMarker('k')).toBe(true);
    clock += 1999;
    expect(await store.hasMarker('k')).toBe(true);
    clock += 1;
    expect(await store.hasMarker('k')).toBe(false);
  });

  it('互斥锁：未释放前二次获取失败，释放后可再次获取', async () => {
    const store = new MemoryGuardStore();
    const first = await store.acquireLock('lock', 10);
    expect(first).not.toBeNull();
    expect(await store.acquireLock('lock', 10)).toBeNull();
    expect(await first!.release()).toBe(true);
    const second = await store.acquireLock('lock', 10);
    expect(second).not.toBeNull();
    await second!.release();
  });

  it('锁 TTL 到期后可被重新获取；对已过期锁的释放返回 false', async () => {
    let clock = 0;
    const store = new MemoryGuardStore(() => clock);
    const handle = await store.acquireLock('lock', 1);
    expect(handle).not.toBeNull();
    expect(await store.acquireLock('lock', 1)).toBeNull();

    clock += 1001;
    // TTL 到期：锁可被重新获取
    expect(await store.acquireLock('lock', 1)).not.toBeNull();

    // 已过期的句柄释放无效（不误删他人持有的锁）
    const expired = await store.acquireLock('other', 1);
    clock += 1001;
    expect(await expired!.release()).toBe(false);
  });

  it('distributed=false 且 ping 恒真、reset 清空状态', async () => {
    const store = new MemoryGuardStore();
    expect(store.distributed).toBe(false);
    expect(await store.ping()).toBe(true);
    await store.markDone('k', 10);
    expect(await store.hasMarker('k')).toBe(true);
    store.reset();
    expect(await store.hasMarker('k')).toBe(false);
  });
});

/** 缓存服务结构桩（仅覆盖 CacheGuardStore 用到的成员） */
function makeCache(driver: 'memory' | 'redis'): CacheService {
  const values = new Map<string, unknown>();
  const locks = new Map<string, LockHandle>();
  const stub = {
    driver,
    async get<T>(key: string): Promise<T | undefined> {
      return values.get(key) as T | undefined;
    },
    async set(key: string, value: unknown): Promise<void> {
      values.set(key, value);
    },
    async lock(key: string): Promise<LockHandle | null> {
      if (locks.has(key)) return null;
      const handle = {
        key,
        token: 'stub',
        ttlMs: 60_000,
        reentrant: false,
        async release(): Promise<boolean> {
          locks.delete(key);
          return true;
        },
        async renew(): Promise<boolean> {
          return true;
        },
      } as unknown as LockHandle;
      locks.set(key, handle);
      return handle;
    },
    async ping(): Promise<boolean> {
      return true;
    },
  };
  return stub as unknown as CacheService;
}

describe('CacheGuardStore', () => {
  it('distributed 随缓存驱动变化（memory=false / redis=true）', () => {
    expect(new CacheGuardStore(makeCache('memory')).distributed).toBe(false);
    expect(new CacheGuardStore(makeCache('redis')).distributed).toBe(true);
  });

  it('幂等标记走缓存键且带前缀隔离', async () => {
    const cache = makeCache('redis');
    const store = new CacheGuardStore(cache, 'fw:q');
    expect(await store.hasMarker('order:1')).toBe(false);
    await store.markDone('order:1', 60);
    expect(await store.hasMarker('order:1')).toBe(true);
    // 不同前缀之间互不可见
    expect(await new CacheGuardStore(cache, 'fw:other').hasMarker('order:1')).toBe(false);
  });

  it('acquireLock 命中返回可释放句柄，重复获取返回 null', async () => {
    const store = new CacheGuardStore(makeCache('redis'));
    const handle = await store.acquireLock('daily', 60);
    expect(handle).not.toBeNull();
    expect(await store.acquireLock('daily', 60)).toBeNull();
    expect(await handle!.release()).toBe(true);
    expect(await store.acquireLock('daily', 60)).not.toBeNull();
  });

  it('ping 透传缓存服务', async () => {
    expect(await new CacheGuardStore(makeCache('redis')).ping()).toBe(true);
  });
});
