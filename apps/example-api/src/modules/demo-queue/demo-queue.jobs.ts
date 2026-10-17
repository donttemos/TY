/*
 * @file 队列演示任务（M7 验收载体）
 * @description 用真实业务形态覆盖 PRD-007 的验收点：
 *   - `demo.echo`：正常成功，验证入队/执行/上下文（TC-JOB-001）；
 *   - `demo.flaky`：前 N 次故意失败，验证重试与退避序列（TC-JOB-003）；
 *   - `demo.permanent`：抛 `PermanentJobError`，验证终态失败直接进死信（TC-JOB-004）；
 *   - `demo.slow`：按载荷 sleep，验证并发上限与限速（TC-JOB-007）；
 *   - `demo.idempotent`：配合 `idempotencyKey` 验证幂等只执行一次（TC-JOB-006）；
 *   - `DemoCronJobs`：`@Cron` 每 5 秒写入台账，验证定时任务调度与手动触发（TC-JOB-002）。
 *   全部为 Nest provider：注册进模块后由 QueueModule 启动期自动扫描，无需手写注册代码（AC-003）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module example-api/demo-queue
 */

import { Injectable } from '@nestjs/common';
import { Cron, JobHandler, PermanentJobError, type Job, type JobContext } from '@fw/queue';
import { setTimeout as sleep } from 'node:timers/promises';
import { QueueLedger } from './queue-ledger.js';

/**
 * 正常任务：记录载荷摘要，供冒烟断言「入队即执行」
 */
@Injectable()
@JobHandler('demo.echo')
export class DemoEchoJob implements Job<{ value: string }> {
  constructor(private readonly ledger: QueueLedger) {}

  handle(payload: { value: string }, ctx: JobContext<{ value: string }>): void {
    this.ledger.record('demo.echo', 0, { value: payload.value, attempt: ctx.attempt, queue: ctx.queue, hasTraceId: ctx.traceId.length > 0 });
  }
}

/**
 * 可重试任务：第 `attempt <= failTimes` 次抛错，之后成功
 */
@Injectable()
@JobHandler('demo.flaky')
export class DemoFlakyJob implements Job<{ failTimes: number }> {
  constructor(private readonly ledger: QueueLedger) {}

  handle(payload: { failTimes: number }, ctx: JobContext<{ failTimes: number }>): void {
    if (ctx.attempt <= (payload.failTimes ?? 0)) {
      throw new Error(`第 ${ctx.attempt} 次故意失败（共需失败 ${payload.failTimes} 次）`); // fw-allow-raw-throw: 演示任务本体——故意失败驱动重试/死信演示，非业务错误
    }
    this.ledger.record('demo.flaky', 0, { attempt: ctx.attempt, maxAttempts: ctx.maxAttempts });
  }
}

/**
 * 终态失败任务：抛 `PermanentJobError`，驱动不再重试，直接归档死信
 */
@Injectable()
@JobHandler('demo.permanent')
export class DemoPermanentJob implements Job<{ reason?: string }> {
  constructor(private readonly ledger: QueueLedger) {}

  handle(payload: { reason?: string }, ctx: JobContext<{ reason?: string }>): never {
    this.ledger.record('demo.permanent.attempted', 0, { attempt: ctx.attempt });
    throw new PermanentJobError(payload.reason ?? '业务明确拒绝，重试无意义');
  }
}

/**
 * 慢任务：按载荷耗时，用于观测并发上限与令牌桶限速
 */
@Injectable()
@JobHandler('demo.slow')
export class DemoSlowJob implements Job<{ ms?: number; tag?: string }> {
  constructor(private readonly ledger: QueueLedger) {}

  async handle(payload: { ms?: number; tag?: string }): Promise<void> {
    this.ledger.enter('demo.slow');
    const start = Date.now();
    try {
      await sleep(payload.ms ?? 50);
      this.ledger.record('demo.slow', Date.now() - start, { tag: payload.tag ?? null });
    } finally {
      this.ledger.leave('demo.slow');
    }
  }
}

/**
 * 幂等任务：同 `idempotencyKey` 在窗口期内只执行一次
 */
@Injectable()
@JobHandler('demo.idempotent')
export class DemoIdempotentJob implements Job<{ orderId: string }> {
  constructor(private readonly ledger: QueueLedger) {}

  handle(payload: { orderId: string }): void {
    this.ledger.record('demo.idempotent', 0, { orderId: payload.orderId });
  }
}

/**
 * 定时任务载体：`@Cron` 标注的方法由 QueueModule 启动期扫描注册
 */
@Injectable()
export class DemoCronJobs {
  constructor(private readonly ledger: QueueLedger) {}

  /** 每 5 秒一次（6 段表达式含秒），台账计数即触发次数 */
  @Cron('*/5 * * * * *', { name: 'demo.tick', lock: true })
  tick(): void {
    this.ledger.record('demo.tick', 0);
  }

  /** 每天 03:00（5 段表达式），仅验证注册与快照，不在冒烟中等待触发 */
  @Cron('0 3 * * *', { name: 'demo.nightly', lock: true })
  nightly(): void {
    this.ledger.record('demo.nightly', 0);
  }
}
