/*
 * @file 单测：队列管理端点与指标端点
 * @description 直接实例化控制器（不经 HTTP 层）验证方法契约：状态/指标/处理器名/cron 快照、
 *   手动触发、死信列表与重放/清理、暂停恢复与清空，以及 /metrics/queue 的文本渲染与 Content-Type。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { afterEach, describe, expect, it } from 'vitest';
import { QueueAdminController } from '../admin.controller.js';
import { QueueMetricsController, QUEUE_METRICS_PATH } from '../metrics.controller.js';
import { CronScheduler } from '../scheduler.js';
import { createQueueFixture, waitFor, type QueueFixture } from './test-helpers.js';

let fixture: QueueFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

/** 轮询异步条件 */
async function waitForAsync(condition: () => Promise<boolean>, label: string, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}`);
}

/** 构造管理/指标控制器（共用同一 fixture 的队列与守卫） */
function makeController(overrides = {}): {
  admin: QueueAdminController;
  metrics: QueueMetricsController;
  scheduler: CronScheduler;
  fx: QueueFixture;
} {
  fixture = createQueueFixture(overrides);
  const scheduler = new CronScheduler({
    guard: fixture.guard,
    metrics: fixture.metrics,
    enabled: true,
    defaultTimeoutMs: 1000,
  });
  return {
    admin: new QueueAdminController(fixture.queue, scheduler),
    metrics: new QueueMetricsController(fixture.queue),
    scheduler,
    fx: fixture,
  };
}

describe('QueueAdminController', () => {
  it('stats / handlers / metrics 反映注册与运行状态', async () => {
    const { admin, fx } = makeController();
    fx.queue.register('demo', async () => undefined);
    await fx.queue.start();

    expect(admin.handlers()).toEqual({ names: ['demo'] });
    const stats = await admin.stats();
    expect(stats.driver).toBe('memory');
    expect(stats.queues).toEqual([]);
    const snapshot = admin.metrics();
    expect(snapshot.driver).toBe('memory');
    expect(snapshot.dispatched).toBe(0);
  });

  it('crons 快照与手动 tick（仍走锁）', async () => {
    const { admin, scheduler } = makeController();
    let runs = 0;
    scheduler.register('daily', '0 3 * * *', () => {
      runs++;
    });

    const listing = admin.crons();
    expect(listing.enabled).toBe(true);
    expect(listing.items.map((item) => item.name)).toEqual(['daily']);

    const result = await admin.tick('daily');
    expect(result.results).toEqual([{ name: 'daily', acquired: true }]);
    expect(runs).toBe(1);

    // 不存在的任务：tick 返回空结果
    expect((await admin.tick('missing')).results).toEqual([]);
  });

  it('死信列表 / 单条重放（含不存在的情形）', async () => {
    const { admin, fx } = makeController();
    fx.queue.register('boom', () => {
      throw new Error('炸了');
    });
    await fx.queue.start();
    await fx.queue.dispatch('boom', { a: 1 }, { attempts: 1 });

    await waitForAsync(async () => (await admin.deadLetters()).total >= 1, '死信归档');
    const list = await admin.deadLetters();
    expect(list.total).toBe(1);
    expect(list.items[0]!.name).toBe('boom');
    expect(list.items[0]!.reason).toContain('炸了');

    const id = list.items[0]!.id;
    expect(await admin.requeue(id)).toEqual({ id, requeued: true });
    expect(await admin.requeue('not-exist')).toEqual({ id: 'not-exist', requeued: false });
  });

  it('pause / resume 切换暂停态；drain 清空等待队列', async () => {
    const { admin, fx } = makeController({ concurrency: 1 });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    fx.queue.register('slow', () => gate);
    await fx.queue.start();
    for (let i = 0; i < 3; i++) await fx.queue.dispatch('slow', { i });

    await waitFor(() => fx.driver.pendingCount() >= 2, '任务排队');
    const drained = await admin.drain();
    expect(drained.removed).toBeGreaterThanOrEqual(2);
    release?.();

    await admin.pause();
    expect((await admin.stats()).paused).toBe(true);
    await admin.resume();
    expect((await admin.stats()).paused).toBe(false);
  });
});

describe('QueueMetricsController', () => {
  it('渲染 Prometheus 文本并设置 Content-Type', async () => {
    fixture = createQueueFixture();
    const controller = new QueueMetricsController(fixture.queue);
    let contentType = '';
    const res = { type: (value: string): void => void (contentType = value) };

    const text = await controller.render(res);
    expect(contentType).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(text).toContain('fw_queue_info{driver="memory"} 1');
    expect(QUEUE_METRICS_PATH).toBe('/metrics/queue');
  });
});
