/*
 * @file QueueService 单测
 * @description 覆盖 FR-01/FR-05/NFR：处理器注册与实例扫描、派发选项合并与校验、
 *   执行上下文（attempt / maxAttempts / traceId / jobId）、单任务超时、
 *   幂等（显式 idempotencyKey 与 @Idempotent 推导）、未注册任务的终态失败、
 *   死信告警回调与管理面代理（统计 / 重放 / 清理 / 暂停 / 清空 / 取消）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { Job, JobHandler, Idempotent } from '../decorators.js';
import { JobOptionError } from '../errors.js';
import type { JobContext } from '../types.js';
import { createQueueFixture, waitFor } from './test-helpers.js';
/** 演示处理器（复用实例注册路径） */
@JobHandler('demo.scan')
class ScannedJob implements Job<{ id: string }> {
  /** 收到的载荷 */
  readonly seen: Array<{ id: string; attempt: number }> = [];

  /**
   * 记录载荷与执行次数
   * @param payload 载荷
   * @param ctx 上下文
   */
  async handle(payload: { id: string }, ctx: JobContext<{ id: string }>): Promise<void> {
    this.seen.push({ id: payload.id, attempt: ctx.attempt });
  }
}

/** 幂等处理器（未显式给 key，按载荷哈希推导） */
@Idempotent({ ttlSeconds: 60 })
@JobHandler('demo.idempotent')
class IdempotentJob implements Job<{ orderId: string }> {
  /** 执行次数 */
  runs = 0;

  /**
   * 计数
   * @param payload 载荷
   */
  async handle(payload: { orderId: string }): Promise<void> {
    void payload;
    this.runs++;
  }
}

describe('QueueService 注册与派发', () => {
  it('注册实例后按任务名执行，并传递完整上下文', async () => {
    const { queue, stop } = createQueueFixture();
    const instance = new ScannedJob();
    expect(queue.registerInstance(instance)).toBe('demo.scan');
    expect(queue.registeredNames()).toEqual(['demo.scan']);
    expect(queue.has('demo.scan')).toBe(true);

    let captured: JobContext<{ id: string }> | undefined;
    queue.register('demo.manual', (_payload, ctx) => void (captured = ctx as JobContext<{ id: string }>));
    await queue.start();

    const handle = await queue.dispatch('demo.scan', { id: 'a1' });
    await waitFor(() => instance.seen.length === 1, '处理器执行');
    expect(instance.seen[0]).toEqual({ id: 'a1', attempt: 1 });
    expect(handle.queue).toBe('default');
    expect(handle.id).toMatch(/^job-/);
    expect(handle.runAt.getTime()).toBeLessThanOrEqual(Date.now() + 5);

    await queue.dispatch('demo.manual', {}, { queue: 'reports' });
    await waitFor(() => captured !== undefined, '第二个处理器执行');
    expect(captured?.jobId).toMatch(/^job-/);
    expect(captured?.maxAttempts).toBe(4);
    expect(captured?.traceId.length).toBeGreaterThan(0);
    captured?.logger.info('任务内日志');
    await stop();
  });

  it('未标注 @JobHandler 的实例返回 undefined', () => {
    const { queue, stop } = createQueueFixture();
    class Plain {}
    expect(queue.registerInstance(new Plain())).toBeUndefined();
    void stop();
  });

  it('任务类缺少 handle 时装配期报错', () => {
    const { queue, stop } = createQueueFixture();
    @JobHandler('demo.bad')
    class BadJob {}
    expect(() => queue.registerInstance(new BadJob())).toThrow(JobOptionError);
    void stop();
  });

  it('选项校验：非法 attempts / timeout / 空任务名', async () => {
    const { queue, stop } = createQueueFixture();
    queue.register('demo', () => undefined);
    await expect(queue.dispatch('demo', {}, { attempts: 0 })).rejects.toThrow(JobOptionError);
    await expect(queue.dispatch('demo', {}, { timeoutSeconds: -1 })).rejects.toThrow(JobOptionError);
    await expect(queue.dispatch('', {})).rejects.toThrow(JobOptionError);
    expect(() => queue.register('', () => undefined)).toThrow(JobOptionError);
    await stop();
  });

  it('delay 与 runAt：延时任务不立即执行', async () => {
    const { queue, stop } = createQueueFixture();
    let runs = 0;
    queue.register('demo.delay', () => void runs++);
    await queue.start();
    await queue.dispatch('demo.delay', {}, { delay: '25ms' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(runs).toBe(0);
    await waitFor(() => runs === 1, '延时任务执行');

    const runAt = new Date(Date.now() + 20);
    const handle = await queue.dispatch('demo.delay', {}, { runAt });
    expect(handle.runAt.getTime()).toBe(runAt.getTime());
    await waitFor(() => runs === 2, 'runAt 任务执行');
    await stop();
  });

  it('非法 delay 串被拒绝（错误码 1001）', async () => {
    const { queue, stop } = createQueueFixture();
    await expect(queue.dispatch('demo', {}, { delay: 'soon' })).rejects.toThrow(/delay 格式非法/);
    await stop();
  });
});

describe('QueueService 失败与幂等', () => {
  it('执行超时按失败处理并计数（NFR：单任务默认 60s 可配）', async () => {
    const { queue, metrics, stop } = createQueueFixture();
    queue.register('demo.slow', async () => new Promise((resolve) => setTimeout(resolve, 200)));
    await queue.start();
    await queue.dispatch('demo.slow', {}, { timeoutSeconds: 0.05, attempts: 1 });
    await waitFor(() => metrics.snapshot('memory').timedOut > 0, '超时计数');
    const snapshot = metrics.snapshot('memory');
    expect(snapshot.failed).toBe(1);
    expect(snapshot.deadLettered).toBe(1);
    await stop();
  });

  it('未注册任务直接进死信（终态失败）', async () => {
    const { queue, driver, metrics, stop } = createQueueFixture();
    await queue.start();
    await queue.dispatch('not.registered', { a: 1 });
    await waitFor(() => metrics.snapshot('memory').deadLettered === 1, '进入死信');
    const dead = await driver.listDeadLetters();
    expect(dead[0].reason).toContain('任务未注册处理器');
    await stop();
  });

  it('显式 idempotencyKey：同一键只执行一次（TC-JOB-006）', async () => {
    const { queue, metrics, stop } = createQueueFixture();
    const runs: string[] = [];
    queue.register('demo.idem', (payload: { key: string }) => void runs.push(payload.key));
    await queue.start();
    await queue.dispatch('demo.idem', { key: 'k1' }, { idempotencyKey: 'order-1' });
    await waitFor(() => runs.length === 1, '首次执行');
    await queue.dispatch('demo.idem', { key: 'k2' }, { idempotencyKey: 'order-1' });
    await queue.dispatch('demo.idem', { key: 'k3' }, { idempotencyKey: 'order-1' });
    await waitFor(() => metrics.snapshot('memory').idempotentSkipped >= 2, '幂等跳过计数');
    expect(runs).toEqual(['k1']);
    await stop();
  });

  it('不同幂等键互不影响', async () => {
    const { queue, stop } = createQueueFixture();
    const runs: string[] = [];
    queue.register('demo.idem2', (payload: { key: string }) => void runs.push(payload.key));
    await queue.start();
    await queue.dispatch('demo.idem2', { key: 'a' }, { idempotencyKey: 'k-a' });
    await queue.dispatch('demo.idem2', { key: 'b' }, { idempotencyKey: 'k-b' });
    await waitFor(() => runs.length === 2, '两次执行');
    expect(runs.sort()).toEqual(['a', 'b']);
    await stop();
  });

  it('失败任务不写幂等标记，同样幂等键的下一次派发仍可执行', async () => {
    const { queue, metrics, stop } = createQueueFixture();
    let fail = true;
    let runs = 0;
    queue.register('demo.idem3', () => {
      if (fail) throw new Error('先失败');
      runs++;
    });
    await queue.start();
    // attempts=1：首次即失败并归档死信（确定性，不依赖退避时序）
    await queue.dispatch('demo.idem3', {}, { idempotencyKey: 'retry-1', attempts: 1 });
    await waitFor(() => metrics.snapshot('memory').deadLettered === 1, '首次失败进死信');
    expect(runs).toBe(0);

    // 修复后同键再派发：因上次失败未写幂等标记，仍会真正执行
    fail = false;
    await queue.dispatch('demo.idem3', {}, { idempotencyKey: 'retry-1', attempts: 1 });
    await waitFor(() => runs === 1, '修复后同键仍可执行');
    expect(metrics.snapshot('memory').idempotentSkipped).toBe(0);
    await stop();
  });

  it('@Idempotent 未显式给 key 时按载荷哈希去重', async () => {
    const { queue, metrics, stop } = createQueueFixture();
    const instance = new IdempotentJob();
    queue.registerInstance(instance);
    await queue.start();
    await queue.dispatch('demo.idempotent', { orderId: 'o-9' });
    await waitFor(() => instance.runs === 1, '首次执行');
    await queue.dispatch('demo.idempotent', { orderId: 'o-9' });
    await waitFor(() => metrics.snapshot('memory').idempotentSkipped >= 1, '幂等跳过');
    expect(instance.runs).toBe(1);
    // 载荷不同 → 键不同 → 会执行
    await queue.dispatch('demo.idempotent', { orderId: 'o-10' });
    await waitFor(() => instance.runs === 2, '不同载荷照常执行');
    await stop();
  });

  it('死信告警回调被触发，且回调抛错不影响队列', async () => {
    const alerts: string[] = [];
    const reasons: string[] = [];
    const fixture = createQueueFixture({}, {}, (record, reason) => {
      alerts.push(record.id);
      reasons.push(reason);
      throw new Error('webhook 不可用'); // 告警通道故障不得影响队列
    });
    fixture.queue.register('demo.alert', () => {
      throw new Error('炸了');
    });
    await fixture.queue.start();
    await fixture.queue.dispatch('demo.alert', {}, { attempts: 1 });
    await waitFor(() => alerts.length === 1, '告警回调');
    expect(alerts[0]).toMatch(/^job-/);
    expect(reasons[0]).toContain('炸了');
    expect(fixture.metrics.snapshot('memory').deadLettered).toBe(1);
    await fixture.stop();
  });
});

describe('QueueService 管理面代理（FR-09）', () => {
  it('stats / deadLetters / requeue / purge / pause / resume / drain / cancel', async () => {
    const fixture = createQueueFixture();
    const { queue, driver } = fixture;
    let fail = true;
    let okRuns = 0;
    queue.register('demo.fail', () => {
      if (fail) throw new Error('失败');
    });
    queue.register('demo.ok', () => void okRuns++);
    await queue.start();

    await queue.dispatch('demo.fail', {}, { attempts: 1, queue: 'exports' });
    await waitFor(() => fixture.metrics.snapshot('memory').deadLettered === 1, '进入死信');

    const stats = await queue.stats();
    expect(stats.driver).toBe('memory');
    expect(stats.queues.map((item) => item.name)).toContain('exports');
    const dead = await queue.listDeadLetters('exports');
    expect(dead).toHaveLength(1);
    expect(dead[0].payload).toEqual({});

    fail = false;
    expect(await queue.requeueDeadLetter(dead[0].id)).toBe(true);
    await waitFor(() => driver.pendingCount() === 0, '重放完成');
    expect(await queue.purgeDeadLetters()).toBe(0);

    await queue.pause();
    await queue.dispatch('demo.ok', {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(okRuns).toBe(0); // 暂停期间不消费
    await queue.resume();
    await waitFor(() => okRuns >= 1, '恢复后执行');
    expect((await queue.stats()).totals.completed).toBeGreaterThanOrEqual(1);

    const cancelTarget = await queue.dispatch('demo.ok', {});
    expect(await queue.cancel(cancelTarget.id)).toBe(true);

    await queue.pause();
    await queue.dispatch('demo.ok', {});
    expect(await queue.drain()).toBe(1);
    await queue.resume();
    expect(await queue.ping()).toBe(true);
    await fixture.stop();
  });

  it('shutdown 返回在途任务数并停止消费', async () => {
    const fixture = createQueueFixture({ shutdownTimeoutMs: 30 });
    fixture.queue.register('demo.slow', async () => new Promise((resolve) => setTimeout(resolve, 300)));
    await fixture.queue.start();
    await fixture.queue.dispatch('demo.slow', {});
    await waitFor(() => fixture.driver.pendingCount() === 0, '任务已被取出');
    const inflight = await fixture.queue.shutdown();
    expect(inflight).toBe(1);
    expect(fixture.driver.pendingCount()).toBe(1);
  });
});
