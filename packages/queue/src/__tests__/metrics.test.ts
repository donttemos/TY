/*
 * @file 单测：指标采集与 Prometheus 渲染
 * @description 覆盖计数累加、耗时观测、成功率边界（无执行/全成功/混合）、快照字段，
 *   以及 Prometheus 文本渲染（含驱动 info、积压 gauge 与暂停标记）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { QueueMetrics } from '../metrics.js';
import type { QueueStats } from '../types.js';

describe('QueueMetrics', () => {
  it('计数与耗时累加，快照字段一一对应', () => {
    const m = new QueueMetrics();
    m.dispatch();
    m.dispatch();
    m.success(30);
    m.failure(10);
    m.deadLetter();
    m.idempotent();
    m.timeout();
    m.cronTick();
    m.cronLockOut();
    const snap = m.snapshot('memory');
    expect(snap).toMatchObject({
      driver: 'memory',
      dispatched: 2,
      succeeded: 1,
      failed: 1,
      deadLettered: 1,
      idempotentSkipped: 1,
      timedOut: 1,
      cronTicked: 1,
      cronLockedOut: 1,
      latencyMs: 40,
      executed: 2,
    });
  });

  it('successRate：无执行返回 0；全成功为 1；混合按比例', () => {
    const empty = new QueueMetrics();
    expect(QueueMetrics.successRate(empty.snapshot('memory'))).toBe(0);

    const allOk = new QueueMetrics();
    allOk.success(1);
    allOk.success(1);
    expect(QueueMetrics.successRate(allOk.snapshot('memory'))).toBe(1);

    const mixed = new QueueMetrics();
    mixed.success(1);
    mixed.success(1);
    mixed.success(1);
    mixed.failure(1);
    expect(QueueMetrics.successRate(mixed.snapshot('memory'))).toBeCloseTo(0.75, 6);
  });

  it('observe 可独立累计（不改变成功/失败计数）', () => {
    const m = new QueueMetrics();
    m.observe(5);
    m.observe(15);
    const snap = m.snapshot('bullmq');
    expect(snap.executed).toBe(2);
    expect(snap.latencyMs).toBe(20);
    expect(snap.succeeded).toBe(0);
  });

  it('render 输出驱动 info、关键计数与成功率/平均耗时', () => {
    const m = new QueueMetrics();
    m.dispatch();
    m.success(20);
    const text = QueueMetrics.render(m.snapshot('memory'));
    expect(text).toContain('fw_queue_info{driver="memory"} 1');
    expect(text).toContain('fw_queue_dispatched_total 1');
    expect(text).toContain('fw_queue_succeeded_total 1');
    expect(text).toContain('fw_queue_success_rate 1');
    expect(text).toContain('fw_queue_avg_duration_ms 20');
    expect(text.endsWith('\n')).toBe(true);
  });

  it('render 传入 stats 时输出积压与暂停 gauge；无执行时平均耗时为 0', () => {
    const m = new QueueMetrics();
    const stats: QueueStats = {
      driver: 'memory',
      paused: true,
      consuming: false,
      queues: [],
      totals: { waiting: 3, active: 2, completed: 7, deadLetter: 1, backlog: 5 },
    };
    const text = QueueMetrics.render(m.snapshot('memory'), stats);
    expect(text).toContain('fw_queue_backlog 5');
    expect(text).toContain('fw_queue_waiting 3');
    expect(text).toContain('fw_queue_active 2');
    expect(text).toContain('fw_queue_completed 7');
    expect(text).toContain('fw_queue_dead_letter 1');
    expect(text).toContain('fw_queue_paused 1');
    expect(text).toContain('fw_queue_avg_duration_ms 0');
  });
});
