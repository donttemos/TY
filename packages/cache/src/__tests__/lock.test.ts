/*
 * @file 分布式锁单测
 * @description 验证互斥、等待获取、令牌安全的释放与续期、可重入深度、自动续期看门狗与 TTL 到期后的抢占
 *   （TC-CACHE-009：多实例同时触发定时任务，仅一个执行）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { describe, expect, it } from 'vitest';
import { LockManager } from '../lock.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';

/** 短睡眠 */
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('@fw/cache · 分布式锁', () => {
  it('互斥：同一锁只能被一个持有者拿到（3 实例竞争只有 1 个成功）', async () => {
    const store = new MemoryCacheStore();
    const managers = [new LockManager(store, 1000), new LockManager(store, 1000), new LockManager(store, 1000)];
    const handles = await Promise.all(managers.map((manager) => manager.acquire('cron:daily')));
    expect(handles.filter((handle) => handle !== null)).toHaveLength(1);
    await handles.find((handle) => handle !== null)!.release();
  });

  it('waitMs 内等待获取，前任释放后成功接手', async () => {
    const store = new MemoryCacheStore();
    const first = new LockManager(store, 5000);
    const second = new LockManager(store, 5000);
    const hold = await first.acquire('lock:wait');
    expect(hold).not.toBeNull();
    setTimeout(() => {
      void hold!.release();
    }, 40);
    const acquired = await second.acquire('lock:wait', 5000, { waitMs: 500 });
    expect(acquired).not.toBeNull();
    await acquired!.release();
  });

  it('等待超时返回 null（不阻塞调用方）', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const hold = await manager.acquire('lock:timeout');
    const other = new LockManager(store, 5000);
    const started = Date.now();
    expect(await other.acquire('lock:timeout', 5000, { waitMs: 60 })).toBeNull();
    expect(Date.now() - started).toBeGreaterThanOrEqual(50);
    await hold!.release();
  });

  it('释放校验令牌：TTL 到期后新持有者持锁，旧持有者释放失败（不误删）', async () => {
    const store = new MemoryCacheStore();
    const ownerA = new LockManager(store, 30);
    const ownerB = new LockManager(store, 5000);
    const handleA = await ownerA.acquire('lock:ttl');
    await sleep(60);
    const handleB = await ownerB.acquire('lock:ttl');
    expect(handleB).not.toBeNull();
    expect(await handleA!.release()).toBe(false);
    expect(await store.get('lock:ttl')).toBe(handleB!.token);
    await handleB!.release();
  });

  it('可重入：同持有者重复获取只加深度，逐次释放', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const outer = await manager.acquire('lock:reentrant', 5000, { reentrant: true });
    const inner = await manager.acquire('lock:reentrant', 5000, { reentrant: true });
    expect(inner).not.toBeNull();
    expect(inner!.reentrant).toBe(true);
    expect(inner!.token).toBe(outer!.token);
    expect(await inner!.release()).toBe(true);
    // 深度回到 1，锁仍被持有
    expect(await store.exists('lock:reentrant')).toBe(true);
    expect(await outer!.release()).toBe(true);
    expect(await store.exists('lock:reentrant')).toBe(false);
  });

  it('非重入模式下同持有者再次获取失败', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const hold = await manager.acquire('lock:plain', 5000);
    expect(await manager.acquire('lock:plain', 5000)).toBeNull();
    await hold!.release();
  });

  it('renew 只在令牌匹配时成功（长任务续期）', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const handle = await manager.acquire('lock:renew', 5000);
    expect(await handle!.renew()).toBe(true);
    await store.set('lock:renew', 'other-token', 5000);
    expect(await handle!.renew()).toBe(false);
  });

  it('autoRenew 看门狗在 TTL 到期后仍保持锁，release 后停止续期', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 1200);
    const handle = await manager.acquire('lock:watchdog', 1200, { autoRenew: true });
    expect(handle).not.toBeNull();
    await sleep(1500);
    // 若未续期，1200ms 后应已过期
    expect(await store.get('lock:watchdog')).toBe(handle!.token);
    expect(await handle!.release()).toBe(true);
    expect(await store.get('lock:watchdog')).toBeUndefined();
  });
});
