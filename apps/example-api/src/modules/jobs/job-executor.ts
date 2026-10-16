/*
 * @file 任务执行器（M10 E-01）
 * @description db / bullmq 驱动共用的「执行 + 写库」逻辑：状态流转（pending→running→终态）、
 *   进度上报写库、产物落库、失败兜底。db 驱动在派发实例直接调它；bullmq 驱动在消费者侧
 *   （`job-center.execute` handler）调它——同一份写库语义，两条执行路径行为一致。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Logger } from '@fw/logger';
import { emitJobEvent } from './job-events.js';
import type { JobReporter, JobRunner } from './job-center.port.js';
import { jobRowToView, type JobRecordRow, type JobStore } from './jobs.store.js';

const logger = Logger.for('jobs');

/** 单任务产物体积上限默认值（字符数，约 20 MB 文本；M10/E-16 起可经 JOB_ARTIFACT_MAX_MB 配置） */
const DEFAULT_MAX_ARTIFACT_CHARS = 20 * 1024 * 1024;

/** 任务执行器构造选项 */
export interface JobExecutorOptions {
  /** 单任务产物体积上限（字符数；缺省 20MB，与 memory 驱动同口径） */
  maxArtifactChars?: number;
}

/**
 * 任务执行器：执行 runner 并把状态/进度/产物持久化
 */
export class JobExecutor {
  /** 单任务产物体积上限（字符数；M10/E-16 JOB_ARTIFACT_MAX_MB） */
  private readonly maxArtifactChars: number;

  /**
   * @param store 任务存储
   * @param options 产物体积上限（缺省 20MB，与 N-02 交付行为一致）
   */
  constructor(
    private readonly store: JobStore,
    options: JobExecutorOptions = {},
  ) {
    this.maxArtifactChars = options.maxArtifactChars ?? DEFAULT_MAX_ARTIFACT_CHARS;
  }

  /**
   * 执行任务并把全过程写库
   * @param row 任务行（执行期间就地更新进度，供日志与重试面引用）
   * @param runner 执行体
   */
  async execute(row: JobRecordRow, runner: JobRunner): Promise<void> {
    const report: JobReporter = (progress, message) => {
      const clamped = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
      row.progress = Math.max(row.progress, clamped);
      if (message !== undefined) row.message = message;
      row.updatedAt = new Date().toISOString();
      void this.store.update(row.id, { progress: row.progress, message: row.message }).catch(() => undefined);
      // E-12：进度推进即时推
      emitJobEvent('progress', jobRowToView(row), row.ownerId);
    };

    row.status = 'running';
    row.message = '执行中';
    row.updatedAt = new Date().toISOString();
    await this.store.update(row.id, { status: 'running', message: '执行中' }).catch(() => undefined);
    emitJobEvent('progress', jobRowToView(row), row.ownerId);
    try {
      const artifact = await runner(report);
      if (artifact && artifact.content.length > this.maxArtifactChars) {
        throw new Error(`产物超过 ${Math.round(this.maxArtifactChars / 1024 / 1024)}MB 上限，请缩小导出范围后重试`);
      }
      row.progress = 100;
      row.status = 'succeeded';
      row.message = artifact ? '已完成，可下载' : '已完成';
      row.error = null;
      if (artifact) {
        row.fileName = artifact.fileName;
        row.artifactContent = artifact.content;
        row.artifactContentType = artifact.contentType;
      }
      await this.store.update(row.id, {
        status: 'succeeded',
        progress: 100,
        message: row.message,
        error: null,
        fileName: row.fileName,
        artifactContent: row.artifactContent,
        artifactContentType: row.artifactContentType,
      });
      row.updatedAt = new Date().toISOString();
      emitJobEvent('finished', jobRowToView(row), row.ownerId);
      logger.info('异步任务完成', { jobId: row.id, type: row.type, chars: artifact?.content.length ?? 0 });
    } catch (error) {
      row.status = 'failed';
      row.error = error instanceof Error ? error.message : String(error);
      row.message = '执行失败，可重试';
      await this.store.update(row.id, { status: 'failed', error: row.error, message: row.message });
      row.updatedAt = new Date().toISOString();
      emitJobEvent('finished', jobRowToView(row), row.ownerId);
      logger.error('异步任务失败', { jobId: row.id, type: row.type, traceId: row.traceId, error: row.error });
    } finally {
      row.updatedAt = new Date().toISOString();
    }
  }
}
