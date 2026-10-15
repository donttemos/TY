/*
 * @file 任务中心 db 驱动单测（M10 E-01）
 * @description 覆盖多副本核心语义：登记落库、派发实例执行写库、跨实例读面（进度/产物/重跑）、
 *   注册表重建 runner、并发重跑竞态、未注册类型的可读失败。持久层用 MemoryJobStore
 *   （与 PrismaJobStore 同语义，Prisma 实现由迁移后的 sqlite 冒烟覆盖）——多实例用两个
 *   共享同一 store 的驱动实例模拟（A 实例派发，B 实例查询）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { describe, expect, it } from 'vitest';
import { DbJobDriver } from './drivers/job-db.driver.js';
import { MemoryJobStore } from './jobs.store.js';
import { JobRunnerRegistry } from './job-runner.registry.js';
import type { JobRunner } from './job-center.port.js';

/** 等待任务到达期望状态（执行在后台 void promise 上，轮询持久层） */
async function until(store: MemoryJobStore, jobId: string, status: string, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const row = await store.findById(jobId);
    if (row?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内到达状态 ${status}`);
}

describe('DbJobDriver（M10 E-01）', () => {
  it('create 落库 pending 并在派发实例执行到 succeeded，产物写库', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    const driver = new DbJobDriver(store, registry);
    const view = driver.create({
      type: 'demo.export',
      title: '演示导出',
      ownerId: 'u1',
      runner: async (report) => {
        report(50, '一半');
        return { fileName: 'a.csv', contentType: 'text/csv', content: 'x,y' };
      },
    });
    expect(view.status).toBe('pending');
    await until(store, view.id, 'succeeded');
    const row = await store.findById(view.id);
    expect(row?.progress).toBe(100);
    expect(row?.fileName).toBe('a.csv');
    expect(row?.artifactContent).toBe('x,y');
    expect(row?.artifactContentType).toBe('text/csv');
  });

  it('AC1 多副本：实例 B（同一持久层）可读进度、取产物、无需会话粘滞', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    const instanceA = new DbJobDriver(store, registry);
    const instanceB = new DbJobDriver(store, registry);
    const view = instanceA.create({
      type: 'demo.export',
      title: '演示导出',
      ownerId: 'u1',
      runner: async () => ({ fileName: 'b.csv', contentType: 'text/csv', content: 'data' }),
    });
    await until(store, view.id, 'succeeded');
    // B 实例读进度
    const progress = await instanceB.get(view.id, 'u1');
    expect(progress?.status).toBe('succeeded');
    expect(progress?.fileName).toBe('b.csv');
    // B 实例取产物
    const artifact = await instanceB.artifact(view.id, 'u1');
    expect(artifact?.content).toBe('data');
  });

  it('非归属人读不到任务（不泄露存在性）', async () => {
    const store = new MemoryJobStore();
    const driver = new DbJobDriver(store, new JobRunnerRegistry());
    const view = driver.create({
      type: 'demo.export',
      title: 't',
      ownerId: 'u1',
      runner: async () => null,
    });
    await until(store, view.id, 'succeeded');
    expect(await driver.get(view.id, 'u2')).toBeNull();
    expect(await driver.artifact(view.id, 'u2')).toBeNull();
  });

  it('AC1 跨实例重跑：B 实例经注册表重建 runner 重跑成功', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    let calls = 0;
    registry.register('demo.export', () => (async () => {
      calls += 1;
      if (calls === 1) throw new Error('第一次失败');
      return { fileName: 'ok.csv', contentType: 'text/csv', content: 'ok' };
    }) as JobRunner);
    const instanceA = new DbJobDriver(store, registry);
    const instanceB = new DbJobDriver(store, registry);
    const view = instanceA.create({ type: 'demo.export', title: 't', ownerId: 'u1' });
    await until(store, view.id, 'failed');
    // B 实例重跑（派发在 A，重跑在 B——注册表重建 runner）
    const retried = await instanceB.retry(view.id, 'u1');
    expect(retried.view?.status).toBe('pending');
    expect(retried.reason).toBeUndefined();
    await until(store, view.id, 'succeeded');
    expect(calls).toBe(2);
    expect((await store.findById(view.id))?.error).toBeNull();
  });

  it('重跑状态拒绝：succeeded 任务不重复跑；并发重跑只有一个调用方成功', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    registry.register('demo.export', () => (async () => ({ fileName: 'a', contentType: 'text/csv', content: 'x' })) as JobRunner);
    const driver = new DbJobDriver(store, registry);
    const view = driver.create({ type: 'demo.export', title: 't', ownerId: 'u1', runner: async () => ({ fileName: 'a', contentType: 'text/csv', content: 'x' }) });
    await until(store, view.id, 'succeeded');
    const denied = await driver.retry(view.id, 'u1');
    expect(denied.view?.status).toBe('succeeded');
    expect(denied.reason).toBe('任务已成功，无需重跑');

    // 并发重跑竞态：failed 任务只允许一个 resetForRetry 成功
    const failing = driver.create({ type: 'demo.export', title: 't', ownerId: 'u1', runner: async () => { throw new Error('boom'); } });
    await until(store, failing.id, 'failed');
    const first = await store.resetForRetry(failing.id);
    const second = await store.resetForRetry(failing.id);
    expect(first).not.toBeNull();
    expect(second).toBeNull();
  });

  it('未注册类型：派发缺 runner 直接抛错；重跑给可读 reason 而非静默失败', async () => {
    const store = new MemoryJobStore();
    const driver = new DbJobDriver(store, new JobRunnerRegistry());
    expect(() =>
      driver.create({ type: 'ghost.task', title: 't', ownerId: 'u1' }),
    ).toThrow(/未注册执行体工厂/);

    // 落一个 failed 行模拟历史任务（类型未注册），重跑应有可读 reason
    const failed = driver.create({ type: 'demo.export', title: 't', ownerId: 'u1', runner: async () => { throw new Error('x'); } });
    await until(store, failed.id, 'failed');
    const noRegistryDriver = new DbJobDriver(store, new JobRunnerRegistry());
    const result = await noRegistryDriver.retry(failed.id, 'u1');
    expect(result.reason).toContain('未登记跨实例重跑能力');
  });

  it('产物超上限：任务失败并给出可读原因（与 memory 驱动同语义）', async () => {
    const store = new MemoryJobStore();
    const driver = new DbJobDriver(store, new JobRunnerRegistry());
    const view = driver.create({
      type: 'demo.export',
      title: 't',
      ownerId: 'u1',
      runner: async () => ({ fileName: 'big.csv', contentType: 'text/csv', content: 'x'.repeat(21 * 1024 * 1024) }),
    });
    await until(store, view.id, 'failed');
    const row = await store.findById(view.id);
    expect(row?.error).toContain('20MB');
  });
});
