/*
 * @file cron 调度器单测
 * @description 覆盖 PRD-007 FR-03 / TC-JOB-002：多个「实例」（各自持有独立调度器、共享同一守卫存储）
 *   同时触发时只允许一个真正执行；另覆盖 lock=false 的对比分支、手动 tick、runOnInit、
 *   执行失败与超时、快照字段与停机。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { MemoryGuardStore } from '../guard-store.js';
import { QueueMetrics } from '../metrics.js';
import { CronScheduler } from '../scheduler.js';
import { waitFor } from './test-helpers.js';

/** 构造共享守卫存储的调度器（模拟多副本共享同一 Redis 锁后端） */
function makeScheduler(guard: MemoryGuardStore, overrides: Partial<{ timeoutMs: number }> = {}): CronScheduler {
  return new CronScheduler({
    guard,
    metrics: new QueueMetrics(),
    enabled: true,
    defaultTimeoutMs: overrides.timeoutMs ?? 1000,
  });
}

describe('CronScheduler 注册与快照', () => {
  it('注册后快照包含表达式、锁开关与下次触发时刻', () => {
    const scheduler = makeScheduler(new MemoryGuardStore());
    scheduler.register('daily.settle', '0 2 * * *', () => undefined);
    const snapshot = scheduler.snapshot();
    expect(snapshot).toHaveLength(1);
    expect(snapshot[0].name).toBe('daily.settle');
    expect(snapshot[0].expression).toBe('0 2 * * *');
    expect(snapshot[0].lock).toBe(true);
    expect(snapshot[0].nextRunAt).toBeTruthy();
    expect(snapshot[0].runs).toBe(0);
    expect(scheduler.names()).toEqual(['daily.settle']);
    expect(scheduler.enabled).toBe(true);
  });

  it('lock 显式关闭时快照反映 lock=false；非法表达式在注册期抛错', () => {
    const scheduler = makeScheduler(new MemoryGuardStore());
    scheduler.register('no.lock', '*/5 * * * *', () => undefined, { lock: false });
    expect(scheduler.snapshot()[0].lock).toBe(false);
    expect(() => scheduler.register('bad', 'not a cron', () => undefined)).toThrow();
  });

  it('未启用时 start 不生效', async () => {
    const scheduler = new CronScheduler({ guard: new MemoryGuardStore(), metrics: new QueueMetrics(), enabled: false, defaultTimeoutMs: 100 });
    scheduler.register('a', '* * * * *', () => undefined);
    scheduler.start();
    expect(scheduler.snapshot()[0].runs).toBe(0);
    await scheduler.stop();
  });
});

describe('CronScheduler 分布式互斥（TC-JOB-002）', () => {
  it('三个实例共享同一锁后端时只执行一次', async () => {
    const guard = new MemoryGuardStore();
    let executions = 0;
    const schedulers = [makeScheduler(guard), makeScheduler(guard), makeScheduler(guard)];
    for (const scheduler of schedulers) {
      scheduler.register('report.daily', '0 3 * * *', () => void executions++);
    }

    const results = await Promise.all(schedulers.map((scheduler) => scheduler.tick('report.daily')));
    expect(executions).toBe(1);
    expect(results.filter((item) => item[0].acquired)).toHaveLength(1);
    expect(results.filter((item) => item[0].acquired === false)).toHaveLength(2);

    const snapshots = schedulers.map((scheduler) => scheduler.snapshot()[0]);
    expect(snapshots.reduce((acc, item) => acc + item.runs, 0)).toBe(1);
    expect(snapshots.reduce((acc, item) => acc + item.lockedOut, 0)).toBe(2);
  });

  it('lock=false 时三个实例都会执行（单实例部署才可关闭）', async () => {
    const guard = new MemoryGuardStore();
    let executions = 0;
    const schedulers = [makeScheduler(guard), makeScheduler(guard), makeScheduler(guard)];
    for (const scheduler of schedulers) {
      scheduler.register('local.job', '0 3 * * *', () => void executions++, { lock: false });
    }
    await Promise.all(schedulers.map((scheduler) => scheduler.tick('local.job')));
    expect(executions).toBe(3);
  });

  it('锁释放后可再次触发（下一次周期仍能执行）', async () => {
    const guard = new MemoryGuardStore();
    let executions = 0;
    const scheduler = makeScheduler(guard);
    scheduler.register('repeat.job', '* * * * *', () => void executions++);
    await scheduler.tick('repeat.job');
    await scheduler.tick('repeat.job');
    expect(executions).toBe(2);
    expect(scheduler.snapshot()[0].lockedOut).toBe(0);
  });

  it('手动 tick 指定不存在的任务返回空；不带名字时触发全部', async () => {
    const scheduler = makeScheduler(new MemoryGuardStore());
    let executions = 0;
    scheduler.register('a', '* * * * *', () => void executions++);
    scheduler.register('b', '* * * * *', () => void executions++);
    expect(await scheduler.tick('missing')).toEqual([]);
    const all = await scheduler.tick();
    expect(all.map((item) => item.name).sort()).toEqual(['a', 'b']);
    expect(executions).toBe(2);
  });
});

describe('CronScheduler 执行结果', () => {
  it('handler 抛错记录为 error 且计数仍递增', async () => {
    const scheduler = makeScheduler(new MemoryGuardStore());
    scheduler.register('boom', '* * * * *', () => {
      throw new Error('炸了');
    });
    await scheduler.tick('boom');
    const snapshot = scheduler.snapshot()[0];
    expect(snapshot.runs).toBe(1);
    expect(snapshot.lastResult).toBe('error');
    expect(snapshot.lastRunAt).toBeTruthy();
  });

  it('handler 超时记录为 error', async () => {
    const scheduler = makeScheduler(new MemoryGuardStore(), { timeoutMs: 30 });
    scheduler.register('slow', '* * * * *', () => new Promise<void>((resolve) => setTimeout(resolve, 200)));
    await scheduler.tick('slow');
    expect(scheduler.snapshot()[0].lastResult).toBe('error');
  });

  it('runOnInit 在 start 时立即执行一次', async () => {
    const scheduler = makeScheduler(new MemoryGuardStore());
    let executions = 0;
    scheduler.register('warmup', '0 0 1 1 *', () => void executions++, { runOnInit: true });
    scheduler.start();
    await waitFor(() => executions === 1, 'runOnInit 执行');
    await scheduler.stop();
  });

  it('start/stop 可重复调用，停机后不再触发', async () => {
    const scheduler = makeScheduler(new MemoryGuardStore());
    let executions = 0;
    scheduler.register('tick.me', '* * * * * *', () => void executions++); // 每秒
    scheduler.start();
    scheduler.start();
    await waitFor(() => executions >= 1, '周期触发', 3000);
    await scheduler.stop();
    await scheduler.stop();
    const frozen = executions;
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect(executions).toBe(frozen);
  });

  it('锁 TTL 缺省取 max(任务超时, 60) 秒', () => {
    const guard = new MemoryGuardStore();
    const acquire = guard.acquireLock.bind(guard);
    const captured: number[] = [];
    guard.acquireLock = async (key: string, ttl: number) => {
      captured.push(ttl);
      return acquire(key, ttl);
    };
    const scheduler = makeScheduler(guard, { timeoutMs: 5000 });
    scheduler.register('short', '* * * * *', () => undefined, { timeoutSeconds: 5 });
    scheduler.register('long', '* * * * *', () => undefined, { timeoutSeconds: 3600, lockTtlSeconds: 3600 });
    return Promise.all([scheduler.tick('short'), scheduler.tick('long')]).then(() => {
      expect(captured).toEqual([60, 3600]);
    });
  });
});
