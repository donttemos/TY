/*
 * @file 队列管理端点
 * @description 供管理后台队列页（T-M7-06 / L4）消费的运维面：积压与状态查看、死信列表与重放、
 *   死信清理、队列暂停/恢复、等待队列清空、定时任务快照与手动触发（PRD-007 FR-09 / §7 AC）。
 *   权限：查看需 `system:queue:list`，变更需 `system:queue:manage`（与 C-08 `QUEUE_PERMISSIONS` 同源）；
 *   鉴权由 @fw/auth 的全局 RBAC 守卫统一拦截，未接入鉴权的应用这些元数据不生效。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { Controller, Delete, Get, Inject, Param, Post, Query } from '@nestjs/common';
import { Permissions } from '@fw/auth';
import { QUEUE_SCHEDULER, QUEUE_SERVICE } from './tokens.js';
import type { QueueService } from './queue.service.js';
import type { CronScheduler } from './scheduler.js';
import type { CronSnapshot, DeadLetterRecord, QueueStats } from './types.js';

/** 查看权限码（与 C-08 契约一致） */
export const QUEUE_PERM_LIST = 'system:queue:list';

/** 变更权限码（与 C-08 契约一致） */
export const QUEUE_PERM_MANAGE = 'system:queue:manage';

/** 死信列表响应 */
export interface DeadLetterListResponse {
  /** 总数 */
  total: number;
  /** 明细 */
  items: DeadLetterRecord[];
}

/**
 * 队列管理控制器：路径前缀 /api/v1/admin/queue
 */
@Controller('/api/v1/admin/queue')
export class QueueAdminController {
  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(QUEUE_SCHEDULER) private readonly scheduler: CronScheduler,
  ) {}

  /** 队列状态与积压：驱动、暂停态、各队列 waiting/active/completed/deadLetter */
  @Get('stats')
  @Permissions(QUEUE_PERM_LIST)
  async stats(): Promise<QueueStats> {
    return this.queue.stats();
  }

  /** 指标快照（成功率、平均耗时、幂等跳过、cron 抢锁失败等） */
  @Get('metrics')
  @Permissions(QUEUE_PERM_LIST)
  metrics(): ReturnType<QueueService['metricsSnapshot']> {
    return this.queue.metricsSnapshot();
  }

  /** 已注册的任务名（排查「任务未注册」问题） */
  @Get('handlers')
  @Permissions(QUEUE_PERM_LIST)
  handlers(): { names: string[] } {
    return { names: this.queue.registeredNames() };
  }

  /** 定时任务快照（表达式、下次触发、本实例执行次数与抢锁失败次数） */
  @Get('crons')
  @Permissions(QUEUE_PERM_LIST)
  crons(): { enabled: boolean; items: CronSnapshot[] } {
    return { enabled: this.scheduler.enabled, items: this.scheduler.snapshot() };
  }

  /** 手动触发定时任务（运维按钮；仍走分布式锁） */
  @Post('crons/:name/tick')
  @Permissions(QUEUE_PERM_MANAGE)
  async tick(@Param('name') name: string): Promise<{ results: Array<{ name: string; acquired: boolean }> }> {
    return { results: await this.scheduler.tick(name) };
  }

  /**
   * 死信列表
   * @param queue 队列名（可选）
   */
  @Get('dead-letters')
  @Permissions(QUEUE_PERM_LIST)
  async deadLetters(@Query('queue') queue?: string): Promise<DeadLetterListResponse> {
    const items = await this.queue.listDeadLetters(queue);
    return { total: items.length, items };
  }

  /**
   * 重放单条死信
   * @param id 任务 ID
   */
  @Post('dead-letters/:id/requeue')
  @Permissions(QUEUE_PERM_MANAGE)
  async requeue(@Param('id') id: string): Promise<{ id: string; requeued: boolean }> {
    return { id, requeued: await this.queue.requeueDeadLetter(id) };
  }

  /**
   * 清理死信
   * @param queue 队列名（可选）
   */
  @Delete('dead-letters')
  @Permissions(QUEUE_PERM_MANAGE)
  async purge(@Query('queue') queue?: string): Promise<{ removed: number }> {
    return { removed: await this.queue.purgeDeadLetters(queue) };
  }

  /**
   * 暂停消费
   * @param queue 队列名（可选）
   */
  @Post('pause')
  @Permissions(QUEUE_PERM_MANAGE)
  async pause(@Query('queue') queue?: string): Promise<{ paused: true }> {
    await this.queue.pause(queue);
    return { paused: true };
  }

  /**
   * 恢复消费
   * @param queue 队列名（可选）
   */
  @Post('resume')
  @Permissions(QUEUE_PERM_MANAGE)
  async resume(@Query('queue') queue?: string): Promise<{ resumed: true }> {
    await this.queue.resume(queue);
    return { resumed: true };
  }

  /**
   * 清空等待中的任务
   * @param queue 队列名（可选）
   */
  @Delete('drain')
  @Permissions(QUEUE_PERM_MANAGE)
  async drain(@Query('queue') queue?: string): Promise<{ removed: number }> {
    return { removed: await this.queue.drain(queue) };
  }
}
