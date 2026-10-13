/*
 * @file 队列演示服务（M7 验收载体）
 * @description 队列自身由 app.module 中的 QueueModule.forRoot 装配（全局），本服务只消费注入的
 *   `QUEUE_SERVICE` / `QUEUE_SCHEDULER`，不做驱动选择——切换 memory/bullmq 改 .env 即可（AC-001）。
 *   对外提供派发与运维读写的薄封装，供 /api/v1/demo-queue/* 暴露给冒烟脚本。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/demo-queue
 */

import { Inject, Injectable } from '@nestjs/common';
import {
  QUEUE_SCHEDULER,
  QUEUE_SERVICE,
  type CronSnapshot,
  type DeadLetterRecord,
  type JobHandle,
  type JobOptions,
  type QueueMetricsSnapshot,
  type QueueService,
  type QueueStats,
} from '@fw/queue';
import type { CronScheduler } from '@fw/queue';
import { QueueLedger, type LedgerSnapshot } from './queue-ledger.js';

/**
 * 队列演示服务
 */
@Injectable()
export class DemoQueueService {
  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(QUEUE_SCHEDULER) private readonly scheduler: CronScheduler,
    private readonly ledger: QueueLedger,
  ) {}

  /**
   * 派发任务
   * @param name 任务名
   * @param payload 业务载荷
   * @param options 任务选项
   */
  async dispatch<T>(name: string, payload: T, options: JobOptions = {}): Promise<JobHandle> {
    return this.queue.dispatch(name, payload, options);
  }

  /** 队列状态与积压 */
  async stats(): Promise<QueueStats> {
    return this.queue.stats();
  }

  /** 指标快照 */
  metrics(): QueueMetricsSnapshot {
    return this.queue.metricsSnapshot();
  }

  /** 已注册任务名 */
  handlers(): string[] {
    return this.queue.registeredNames();
  }

  /** 定时任务快照 */
  crons(): { enabled: boolean; items: CronSnapshot[] } {
    return { enabled: this.scheduler.enabled, items: this.scheduler.snapshot() };
  }

  /**
   * 手动触发定时任务（仍走分布式锁）
   * @param name 任务名（缺省全部）
   */
  async tick(name?: string): Promise<Array<{ name: string; acquired: boolean }>> {
    return this.scheduler.tick(name);
  }

  /**
   * 死信列表
   * @param queue 队列名（缺省全部）
   */
  async deadLetters(queue?: string): Promise<DeadLetterRecord[]> {
    return this.queue.listDeadLetters(queue);
  }

  /**
   * 重放单条死信
   * @param id 任务 ID
   */
  async requeue(id: string): Promise<boolean> {
    return this.queue.requeueDeadLetter(id);
  }

  /**
   * 清理死信
   * @param queue 队列名（缺省全部）
   */
  async purge(queue?: string): Promise<number> {
    return this.queue.purgeDeadLetters(queue);
  }

  /**
   * 取消尚未执行的任务
   * @param id 任务 ID
   */
  async cancel(id: string): Promise<boolean> {
    return this.queue.cancel(id);
  }

  /** 暂停消费 */
  async pause(): Promise<void> {
    await this.queue.pause();
  }

  /** 恢复消费 */
  async resume(): Promise<void> {
    await this.queue.resume();
  }

  /** 清空等待中的任务 */
  async drain(): Promise<number> {
    return this.queue.drain();
  }

  /** 执行台账快照 */
  ledgerSnapshot(name?: string): LedgerSnapshot | LedgerSnapshot[] {
    return name ? this.ledger.get(name) : this.ledger.snapshot();
  }

  /** 清空台账与死信（冒烟分阶段复位） */
  async reset(): Promise<{ ledger: true; deadLetters: number }> {
    this.ledger.reset();
    const deadLetters = await this.queue.purgeDeadLetters();
    return { ledger: true, deadLetters };
  }
}
