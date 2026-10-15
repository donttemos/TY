/*
 * @file 任务中心 bullmq 驱动单测（M10 E-01）
 * @description 覆盖：派发期注册表校验（闭包无法入队）、落库 + 入队载荷、入队失败兜底
 *   （任务标失败可重跑，不滞留 pending）、跨实例重跑重新入队。QueueService 用 dispatch 桩
 *   （真实 bullmq 路径由 @fw/queue 自身单测与 CI redis 覆盖）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { describe, expect, it } from 'vitest';
import { BullmqJobDriver, JOB_CENTER_EXECUTE_HANDLER, type JobExecutePayload } from './drivers/job-bullmq.driver.js';
import { MemoryJobStore } from './jobs.store.js';
import { JobRunnerRegistry } from './job-runner.registry.js';

/** dispatch 桩：记录载荷，可注入失败 */
function stubQueue(fail = false) {
  const dispatched: { name: string; payload: unknown }[] = [];
  return {
    dispatched,
    async dispatch(name: string, payload: unknown): Promise<{ id: string }> {
      if (fail) throw new Error('redis down');
      dispatched.push({ name, payload });
      return { id: 'q-1' };
    },
  };
}

describe('BullmqJobDriver（M10 E-01）', () => {
  it('create：落库 pending 并把执行载荷入队（注册表已登记类型）', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    registry.register('demo.export', () => (async () => null));
    const queue = stubQueue();
    const driver = new BullmqJobDriver(store, registry, queue);
    const view = driver.create({ type: 'demo.export', title: 't', ownerId: 'u1', params: { rows: 3 } });
    expect(view.status).toBe('pending');
    // 入队在 insert 的 promise 链上异步进行，等一拍再断言
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(queue.dispatched).toHaveLength(1);
    expect(queue.dispatched[0].name).toBe(JOB_CENTER_EXECUTE_HANDLER);
    const payload = queue.dispatched[0].payload as JobExecutePayload;
    expect(payload.jobId).toBe(view.id);
    expect(payload.type).toBe('demo.export');
    const row = await store.findById(view.id);
    expect(row?.status).toBe('pending');
    expect(row?.params).toEqual({ rows: 3 });
  });

  it('create：未注册类型直接拒绝（闭包无法入队，快速失败优于永不执行的任务）', () => {
    const driver = new BullmqJobDriver(new MemoryJobStore(), new JobRunnerRegistry(), stubQueue());
    expect(() => driver.create({ type: 'ghost.task', title: 't', ownerId: 'u1' })).toThrow(/未注册执行体工厂/);
  });

  it('入队失败兜底：任务标 failed 可重跑，不滞留 pending', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    registry.register('demo.export', () => (async () => null));
    const driver = new BullmqJobDriver(store, registry, stubQueue(true));
    const view = driver.create({ type: 'demo.export', title: 't', ownerId: 'u1' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    const row = await store.findById(view.id);
    expect(row?.status).toBe('failed');
    expect(row?.error).toContain('派发入队失败');
  });

  it('跨实例重跑：条件重置后重新入队；非归属人 404 语义保持', async () => {
    const store = new MemoryJobStore();
    const registry = new JobRunnerRegistry();
    registry.register('demo.export', () => (async () => null));
    const queue = stubQueue();
    const driver = new BullmqJobDriver(store, registry, queue);
    const view = driver.create({ type: 'demo.export', title: 't', ownerId: 'u1' });
    await store.update(view.id, { status: 'failed', error: 'x', message: '执行失败，可重试' });
    const retried = await driver.retry(view.id, 'u1');
    expect(retried.view?.status).toBe('pending');
    // 重跑应再次入队（消费侧可能在任意实例）
    expect(queue.dispatched).toHaveLength(2);
    const row = await store.findById(view.id);
    expect(row?.status).toBe('pending');
    // 非归属人：view=null（调用方转 404，不泄露存在性）
    expect(await driver.retry(view.id, 'u2')).toEqual({ view: null });
  });
});
