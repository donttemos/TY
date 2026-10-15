/*
 * @file 任务中心 bullmq 驱动（M10 E-01）
 * @description 登记与状态/产物落 `jobs` 表（与 db 驱动同源），执行经 `QueueService.dispatch`
 *   分发——队列自身驱动由 `MQ_DRIVER` 决定：bullmq = 真跨实例（任意副本消费执行），
 *   memory = 进程内（单实例形态下与 db 驱动等效）。消费侧注册 `job-center.execute` handler：
 *   读库 → 注册表重建 runner → JobExecutor 执行写库。
 *   派发期即校验注册表：闭包无法入队，未登记 factory 的任务类型直接拒绝派发（快速失败）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Logger, getTraceId } from '@fw/logger';
import type { JobHandle } from '@fw/queue';
import type {
  JobArtifact,
  JobCenterPort,
  JobCreateOptions,
  JobView,
} from '../job-center.port.js';
import type { JobRecordRow, JobStore } from '../jobs.store.js';
import { JOB_DB_MAX_ENTRIES, jobRowToView, type RunnerRegistryLike } from './job-db.driver.js';

const logger = Logger.for('jobs');

/** 执行分发队列的任务名（消费侧经 QueueService.register 注册同名 handler） */
export const JOB_CENTER_EXECUTE_HANDLER = 'job-center.execute';

/** 派发载荷（JSON 可序列化——闭包不可跨实例，执行体一律在消费侧重经注册表重建） */
export interface JobExecutePayload {
  jobId: string;
  type: string;
}

/** 队列派发最小面（与 QueueService 结构兼容，便于单测注入桩） */
export interface QueueDispatchLike {
  dispatch<T>(name: string, payload: T, options?: Record<string, unknown>): Promise<JobHandle>;
}

/**
 * bullmq 驱动：jobs 表登记 + 队列分发执行
 */
@Injectable()
export class BullmqJobDriver implements JobCenterPort {
  readonly kind = 'bullmq' as const;

  constructor(
    private readonly store: JobStore,
    private readonly registry: RunnerRegistryLike,
    private readonly queue: QueueDispatchLike,
  ) {}

  /** 派发：落库 → 注册表校验 → 入队（消费侧任意实例执行并写库） */
  create(options: JobCreateOptions): JobView {
    const now = new Date().toISOString();
    const id = `job-${randomUUID()}`;
    const view: JobView = {
      id,
      type: options.type,
      title: options.title,
      status: 'pending',
      progress: 0,
      message: '已派发，等待执行',
      error: null,
      traceId: options.traceId ?? safeTraceId(),
      fileName: null,
      createdAt: now,
      updatedAt: now,
    };
    const row: JobRecordRow = {
      id,
      type: options.type,
      title: options.title,
      status: 'pending',
      progress: 0,
      message: '已派发，等待执行',
      error: null,
      traceId: view.traceId,
      fileName: null,
      artifactContent: null,
      artifactContentType: null,
      ownerId: options.ownerId,
      params: options.params ?? null,
      createdAt: now,
      updatedAt: now,
    };
    // 闭包无法入队：bullmq 驱动的执行体只能来自注册表——缺登记属编程错误，快速失败
    if (!this.registry.has(options.type)) {
      throw new Error(`任务类型 ${options.type} 未注册执行体工厂（bullmq 驱动要求登记 JobRunnerRegistry）`);
    }
    void this.store
      .insert(row)
      .then(() => this.store.prune(JOB_DB_MAX_ENTRIES))
      .then(() => this.queue.dispatch(JOB_CENTER_EXECUTE_HANDLER, { jobId: id, type: options.type } satisfies JobExecutePayload))
      .catch((error) => {
        logger.error('任务派发入队失败', { jobId: id, error: error instanceof Error ? error.message : String(error) });
        // 入队失败把任务标失败（可重跑），不能让任务永远停在 pending
        void this.store
          .update(id, { status: 'failed', error: '派发入队失败，请重试', message: '执行失败，可重试' })
          .catch(() => undefined);
      });
    logger.info('异步任务已派发', { jobId: id, type: view.type, ownerId: options.ownerId, driver: 'bullmq', traceId: view.traceId });
    return { ...view };
  }

  /** 读库取视图（仅归属人；与 db 驱动同源） */
  async get(id: string, ownerId: string): Promise<JobView | null> {
    const row = await this.store.findById(id);
    if (!row || row.ownerId !== ownerId) return null;
    return jobRowToView(row);
  }

  /** 重跑：条件更新消竞态 → 重新入队（消费侧可能在任意实例） */
  async retry(id: string, ownerId: string): Promise<{ view: JobView | null; reason?: string }> {
    const row = await this.store.findById(id);
    if (!row || row.ownerId !== ownerId) return { view: null };
    if (row.status === 'running' || row.status === 'pending') {
      return { view: jobRowToView(row), reason: '任务正在执行中，无需重跑' };
    }
    if (row.status === 'succeeded') {
      return { view: jobRowToView(row), reason: '任务已成功，无需重跑' };
    }
    if (!this.registry.has(row.type)) {
      return { view: jobRowToView(row), reason: '该任务类型未登记跨实例重跑能力，请联系管理员或重新派发' };
    }
    const reset = await this.store.resetForRetry(id);
    if (!reset) return { view: jobRowToView(row), reason: '任务已被其他实例重新派发' };
    void this.queue
      .dispatch(JOB_CENTER_EXECUTE_HANDLER, { jobId: id, type: row.type } satisfies JobExecutePayload)
      .catch((error) => {
        logger.error('重跑入队失败', { jobId: id, error: error instanceof Error ? error.message : String(error) });
        void this.store
          .update(id, { status: 'failed', error: '重跑入队失败，请重试', message: '执行失败，可重试' })
          .catch(() => undefined);
      });
    logger.info('异步任务重跑', { jobId: id, type: row.type, driver: 'bullmq' });
    return { view: jobRowToView(reset) };
  }

  /** 读库取产物（仅归属人；与 db 驱动同源） */
  async artifact(id: string, ownerId: string): Promise<JobArtifact | null> {
    const row = await this.store.findById(id);
    if (!row || row.ownerId !== ownerId) return null;
    if (row.status !== 'succeeded' || !row.artifactContent || !row.artifactContentType || !row.fileName) return null;
    return { fileName: row.fileName, contentType: row.artifactContentType, content: row.artifactContent };
  }
}

/** 读取当前请求上下文的 traceId（无上下文时用时间戳兜底） */
function safeTraceId(): string {
  try {
    return getTraceId() || `job-${Date.now().toString(16)}`;
  } catch {
    return `job-${Date.now().toString(16)}`;
  }
}
