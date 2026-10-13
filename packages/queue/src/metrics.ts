/*
 * @file 指标采集与 Prometheus 文本渲染
 * @description 入队数、成功/失败/死信数、幂等跳过数、超时数、cron 触发与抢锁失败数、平均耗时，
 *   以及**队列积压**（waiting / active / deadLetter）等实时量（PRD-007 FR-09）。
 *   指标只增不减；积压量由驱动统计提供，渲染时作为 gauge 输出。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import type { JobDriverName, QueueMetricsSnapshot, QueueStats } from './types.js';

/** 指标采集器：纯计数 + 耗时累加，进程内单例 */
export class QueueMetrics {
  private dispatched = 0;
  private succeeded = 0;
  private failed = 0;
  private deadLettered = 0;
  private idempotentSkipped = 0;
  private timedOut = 0;
  private cronTicked = 0;
  private cronLockedOut = 0;
  private latencyMs = 0;
  private executed = 0;

  /** 入队 +1 */
  dispatch(): void {
    this.dispatched++;
  }

  /**
   * 成功 +1 并累计耗时
   * @param durationMs 执行耗时（毫秒）
   */
  success(durationMs: number): void {
    this.succeeded++;
    this.observe(durationMs);
  }

  /**
   * 失败 +1 并累计耗时（每次重试失败各计一次）
   * @param durationMs 执行耗时（毫秒）
   */
  failure(durationMs: number): void {
    this.failed++;
    this.observe(durationMs);
  }

  /** 进入死信 +1 */
  deadLetter(): void {
    this.deadLettered++;
  }

  /** 幂等跳过 +1 */
  idempotent(): void {
    this.idempotentSkipped++;
  }

  /** 执行超时 +1 */
  timeout(): void {
    this.timedOut++;
  }

  /** cron 触发 +1 */
  cronTick(): void {
    this.cronTicked++;
  }

  /** cron 未拿到分布式锁跳过 +1 */
  cronLockOut(): void {
    this.cronLockedOut++;
  }

  /**
   * 记录一次执行耗时
   * @param durationMs 耗时（毫秒）
   */
  observe(durationMs: number): void {
    this.latencyMs += durationMs;
    this.executed++;
  }

  /**
   * 快照
   * @param driver 驱动名
   */
  snapshot(driver: JobDriverName): QueueMetricsSnapshot {
    return {
      driver,
      dispatched: this.dispatched,
      succeeded: this.succeeded,
      failed: this.failed,
      deadLettered: this.deadLettered,
      idempotentSkipped: this.idempotentSkipped,
      timedOut: this.timedOut,
      cronTicked: this.cronTicked,
      cronLockedOut: this.cronLockedOut,
      latencyMs: this.latencyMs,
      executed: this.executed,
    };
  }

  /**
   * 成功率：succeeded / (succeeded + failed)；无执行时返回 0
   * @param snapshot 指标快照
   */
  static successRate(snapshot: QueueMetricsSnapshot): number {
    const total = snapshot.succeeded + snapshot.failed;
    return total === 0 ? 0 : snapshot.succeeded / total;
  }

  /**
   * 渲染 Prometheus 文本格式（含积压 gauge，来自驱动实时统计）
   * @param snapshot 指标快照
   * @param stats 队列状态（可选；提供时输出积压相关 gauge）
   */
  static render(snapshot: QueueMetricsSnapshot, stats?: QueueStats): string {
    const lines: string[] = [];
    const gauge = (name: string, help: string, value: number): void => {
      lines.push(`# HELP fw_queue_${name} ${help}`);
      lines.push(`# TYPE fw_queue_${name} gauge`);
      lines.push(`fw_queue_${name} ${value}`);
    };
    lines.push('# HELP fw_queue_info 队列驱动信息');
    lines.push('# TYPE fw_queue_info gauge');
    lines.push(`fw_queue_info{driver="${snapshot.driver}"} 1`);
    gauge('dispatched_total', '入队总次数', snapshot.dispatched);
    gauge('succeeded_total', '任务执行成功总次数', snapshot.succeeded);
    gauge('failed_total', '任务执行失败总次数（含重试）', snapshot.failed);
    gauge('dead_lettered_total', '进入死信总次数', snapshot.deadLettered);
    gauge('idempotent_skipped_total', '因幂等键命中而跳过的次数', snapshot.idempotentSkipped);
    gauge('timeouts_total', '任务执行超时次数', snapshot.timedOut);
    gauge('cron_ticks_total', 'cron 触发总次数', snapshot.cronTicked);
    gauge('cron_locked_out_total', 'cron 因未拿到分布式锁而跳过的次数', snapshot.cronLockedOut);
    gauge('success_rate', '成功率 succeeded/(succeeded+failed)', Number(QueueMetrics.successRate(snapshot).toFixed(6)));
    gauge('avg_duration_ms', '平均任务耗时（毫秒）', snapshot.executed === 0 ? 0 : Number((snapshot.latencyMs / snapshot.executed).toFixed(3)));
    if (stats) {
      gauge('backlog', '积压量（waiting + active）', stats.totals.backlog);
      gauge('waiting', '等待执行的任务数', stats.totals.waiting);
      gauge('active', '执行中的任务数', stats.totals.active);
      gauge('completed', '已完成任务数', stats.totals.completed);
      gauge('dead_letter', '死信积压数', stats.totals.deadLetter);
      gauge('paused', '是否暂停（1 = 暂停）', stats.paused ? 1 : 0);
    }
    return `${lines.join('\n')}\n`;
  }
}
