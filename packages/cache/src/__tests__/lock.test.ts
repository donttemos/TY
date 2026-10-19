/*
 * @file 分布式锁单测
 * @description 验证互斥、等待获取、令牌安全的释放与续期、可重入深度、自动续期看门狗与 TTL 到期后的抢占
 *   （TC-CACHE-009：多实例同时触发定时任务，仅一个执行）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复配套：新增 C-02 回归（普通获取句柄先释放只减
 *   共享深度 / release 幂等）与 C-04 回归（短 TTL 看门狗先于过期续期 / onLost 失锁感知）。
 * @modified 2026-10-18 donttemo 复核修复配套（P2）：新增 acquire 入口参数校验回归——非法 ttlMs
 *   在重入/普通获取下行为一致、非法 waitMs 直接失败且不触碰存储。
 * @module @fw/cache
 */

import { describe, expect, it, vi } from 'vitest';
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

  it('C-02 回归：普通获取句柄先释放时只减共享深度，不再提前释放整把锁', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    // A 普通获取（depth 1），B 重入（depth 2）——修复前 A 释放会直接 compareAndDelete，
    // B 仍在业务代码中锁已被释放
    const a = await manager.acquire('lock:order', 5000);
    const b = await manager.acquire('lock:order', 5000, { reentrant: true });
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(await a!.release()).toBe(true);
    // 锁仍被 B 持有
    expect(await store.get('lock:order')).toBe(b!.token);
    expect(await b!.release()).toBe(true);
    expect(await store.exists('lock:order')).toBe(false);
  });

  it('C-02 回归：release 幂等——重复释放返回 false，不二次触碰存储', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const handle = await manager.acquire('lock:idem', 5000);
    expect(await handle!.release()).toBe(true);
    expect(await store.exists('lock:idem')).toBe(false);
    expect(await handle!.release()).toBe(false);
    // 其他实例可正常获取（未被误删/误占）
    const next = new LockManager(store, 5000);
    expect(await next.acquire('lock:idem', 5000)).not.toBeNull();
  });

  it('C-04 回归：TTL < 1s 时看门狗仍能在锁过期前续期', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    // 修复前看门狗周期 max(1000, TTL/3)=1000ms ≥ TTL，锁先过期再续期
    const handle = await manager.acquire('lock:short', 500, { autoRenew: true });
    expect(handle).not.toBeNull();
    await sleep(700);
    expect(await store.get('lock:short')).toBe(handle!.token);
    await handle!.release();
  });

  it('C-04 回归：续期失败后 onLost 回调触发（失锁可感知）', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const lost: string[] = [];
    const handle = await manager.acquire('lock:onlost', 600, { autoRenew: true, onLost: (reason) => lost.push(reason) });
    expect(handle).not.toBeNull();
    // 模拟失锁：锁被其他持有者占据（TTL 过期后抢占）
    await store.set('lock:onlost', 'other-owner', 600);
    await sleep(400);
    expect(lost).toEqual(['renew-failed']);
    // 看门狗已停表：不再继续续期
    await sleep(300);
    expect(lost).toHaveLength(1);
  });

  it('P2 复核（2026-10-18）：非法 ttlMs 在普通获取与重入获取下一致抛错，且不污染重入深度', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const hold = await manager.acquire('lock:ttl-check', 5000, { reentrant: true });
    expect(hold).not.toBeNull();
    // 修复前：重入分支直接建句柄、不经过驱动侧 TTL 校验 → 非法 TTL 静默成功
    for (const bad of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      await expect(manager.acquire('lock:ttl-check', bad, { reentrant: true })).rejects.toThrow(/锁 TTL 必须为正数/);
      await expect(new LockManager(store, 5000).acquire('lock:ttl-check', bad)).rejects.toThrow(/锁 TTL 必须为正数/);
    }
    // 校验先于状态变更：深度仍为 1，令牌与存储值未变
    expect(await store.get('lock:ttl-check')).toBe(hold!.token);
    expect(await hold!.release()).toBe(true);
    expect(await store.exists('lock:ttl-check')).toBe(false);
  });

  it('P2 复核（2026-10-18）：非法 waitMs 抛错（不进入轮询、不触碰存储）', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    await expect(manager.acquire('lock:wait-bad', 5000, { waitMs: -1 })).rejects.toThrow(/waitMs/);
    await expect(manager.acquire('lock:wait-bad', 5000, { waitMs: Number.NaN })).rejects.toThrow(/waitMs/);
    expect(await store.exists('lock:wait-bad')).toBe(false);
  });

  it('C-04 补充：续期返回 false 后看门狗停表，不再持续续期', async () => {
    vi.useFakeTimers();
    try {
      const store = new MemoryCacheStore();
      const renewSpy = vi.spyOn(store, 'compareAndExpire').mockResolvedValue(false);
      const manager = new LockManager(store, 1500);
      const handle = await manager.acquire('lock:renew-stop', 1500, { autoRenew: true });
      await vi.advanceTimersByTimeAsync(1000);
      expect(renewSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(renewSpy).toHaveBeenCalledTimes(1);
      await handle!.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it('令牌隔离：释放后旧句柄 renew 不得续期已被第三方取得的新锁', async () => {
    const store = new MemoryCacheStore();
    const manager = new LockManager(store, 5000);
    const first = await manager.acquire('lock:isolate', 5000);
    expect(first).not.toBeNull();
    await first!.release();
    const third = new LockManager(store, 5000);
    const second = await third.acquire('lock:isolate', 5000);
    expect(second).not.toBeNull();
    // 旧句柄 renew：令牌不匹配 → false，新持有者的锁不受影响
    expect(await first!.renew()).toBe(false);
    expect(await store.get('lock:isolate')).toBe(second!.token);
    await second!.release();
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
