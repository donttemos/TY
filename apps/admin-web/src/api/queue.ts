/*
 * @file 队列管理 API（C-06 契约 §3.8 / C-08 Job 契约）
 * @description 队列状态与积压、指标快照、已注册任务名、定时任务快照与手动触发、死信列表 / 重放 / 清理、
 *   暂停恢复与清空等待。查看类端点需 `system:queue:list`，变更类需 `system:queue:manage`。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type {
  CronListResult,
  CronTickResult,
  DeadLetterListResult,
  DeadLetterRequeueResult,
  QueueHandlersResult,
  QueueMetrics,
  QueueStats,
} from './types';

/** 队列状态与积压 */
export function fetchQueueStats(): Promise<QueueStats> {
  return request.get<QueueStats>('/admin/queue/stats');
}

/** 指标快照（成功率、平均耗时、幂等跳过、cron 抢锁失败等） */
export function fetchQueueMetrics(): Promise<QueueMetrics> {
  return request.get<QueueMetrics>('/admin/queue/metrics');
}

/** 已注册任务名（排查「任务未注册」） */
export function fetchQueueHandlers(): Promise<QueueHandlersResult> {
  return request.get<QueueHandlersResult>('/admin/queue/handlers');
}

/** 定时任务快照 */
export function fetchCrons(): Promise<CronListResult> {
  return request.get<CronListResult>('/admin/queue/crons');
}

/**
 * 手动触发定时任务（仍走分布式锁）
 * @param name 任务名
 */
export function tickCron(name: string): Promise<CronTickResult> {
  return request.post<CronTickResult>(`/queue/crons/${encodeURIComponent(name)}/tick`);
}

/**
 * 死信列表
 * @param queue 队列名（可选）
 */
export function fetchDeadLetters(queue?: string): Promise<DeadLetterListResult> {
  return request.get<DeadLetterListResult>('/admin/queue/dead-letters', { params: queue ? { queue } : undefined });
}

/**
 * 重放单条死信
 * @param id 任务 ID
 */
export function requeueDeadLetter(id: string): Promise<DeadLetterRequeueResult> {
  return request.post<DeadLetterRequeueResult>(`/queue/dead-letters/${encodeURIComponent(id)}/requeue`);
}

/**
 * 清理死信
 * @param queue 队列名（可选）
 */
export function purgeDeadLetters(queue?: string): Promise<{ removed: number }> {
  return request.delete<{ removed: number }>('/admin/queue/dead-letters', { params: queue ? { queue } : undefined });
}

/** 暂停消费 */
export function pauseQueue(): Promise<{ paused: true }> {
  return request.post<{ paused: true }>('/admin/queue/pause');
}

/** 恢复消费 */
export function resumeQueue(): Promise<{ resumed: true }> {
  return request.post<{ resumed: true }>('/admin/queue/resume');
}

/**
 * 清空等待中的任务
 * @param queue 队列名（可选）
 */
export function drainQueue(queue?: string): Promise<{ removed: number }> {
  return request.delete<{ removed: number }>('/admin/queue/drain', { params: queue ? { queue } : undefined });
}
