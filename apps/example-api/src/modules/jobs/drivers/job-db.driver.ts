/*
 * @file 任务中心 db 驱动（M10 E-01）
 * @description 登记与状态/产物落 `jobs` 表（JobStore），执行仍在「派发实例」后台进行——
 *   派发请求天然携带闭包（或经注册表重建），派发实例执行的同时把进度/终态/产物写库；
 *   其他实例的进度/下载/重跑请求全部读库，多副本下任意实例可达（AC1）。
 *   重跑跨实例：闭包不落盘，一律经 `JobRunnerRegistry` 按 type + params 重建；未注册类型
 *   给出可读 reason（STATE_NOT_ALLOWED），不静默失败。并发重跑竞态由 store 的条件更新消解。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Logger, getTraceId } from '@fw/logger';
import type {
  JobArtifact,
  JobCenterPort,
  JobCreateOptions,
  JobRunner,
  JobView,
} from '../job-center.port.js';
import { JobExecutor } from '../job-executor.js';
import { emitJobEvent } from '../job-events.js';
import { jobRowToView, type JobRecordRow, type JobStore } from '../jobs.store.js';

export { jobRowToView };

const logger = Logger.for('jobs');

/** 登记表保留上限（与 memory 驱动一致；只裁已结束任务） */
export const JOB_DB_MAX_ENTRIES = 200;

/** 注册表最小面（与 JobRunnerRegistry 结构兼容，便于单测注入桩） */
export interface RunnerRegistryLike {
  has(type: string): boolean;
  resolve(type: string, params: Record<string, unknown> | null | undefined): JobRunner | null;
}

/**
 * db 驱动：jobs 表持久化 + 派发实例执行
 */
@Injectable()
export class DbJobDriver implements JobCenterPort {
  readonly kind = 'db' as const;

  private readonly executor: JobExecutor;

  /**
   * @param store 任务存储
   * @param registry 执行体注册表（跨实例重跑的重建依据）
   * @param options 产物体积上限（M10/E-16，缺省 20MB）
   */
  constructor(
    private readonly store: JobStore,
    private readonly registry: RunnerRegistryLike,
    options: { maxArtifactChars?: number } = {},
  ) {
    this.executor = new JobExecutor(store, { maxArtifactChars: options.maxArtifactChars });
  }

  /** 派发：先落库（pending），再在本实例后台执行并把状态写回 */
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
    // 落库先于执行：即使进程在执行前崩溃，任务也有迹可查（memory 驱动做不到这一点）
    void this.store.insert(row).then(() => this.prune()).catch((error) => {
      logger.error('任务登记落库失败', { jobId: id, error: error instanceof Error ? error.message : String(error) });
    });

    // 执行体：优先闭包（派发实例语义与 memory 一致），缺省走注册表重建
    const runner = options.runner ?? this.registry.resolve(options.type, options.params);
    if (!runner) {
      // 编程错误：db 驱动下不留闭包的任务类型必须登记 factory —— 快速失败比落一个永远跑不了的任务好
      throw new Error(`任务类型 ${options.type} 未注册执行体工厂（db/bullmq 驱动要求登记 JobRunnerRegistry）`);
    }
    const snapshot = { ...view };
    void this.executor.execute(row, runner);
    logger.info('异步任务已派发', { jobId: id, type: view.type, ownerId: options.ownerId, driver: 'db', traceId: view.traceId });
    // E-12：派发即推（db 驱动跨实例语义下，SSE 由派发实例广播，订阅方可落任意实例）
    emitJobEvent('created', snapshot, options.ownerId);
    return snapshot;
  }

  /** 读库取视图（仅归属人；不匹配返回 null 由调用方转 404） */
  async get(id: string, ownerId: string): Promise<JobView | null> {
    const row = await this.store.findById(id);
    if (!row || row.ownerId !== ownerId) return null;
    return jobRowToView(row);
  }

  /** 重跑：经注册表按 type + params 重建执行体（跨实例语义的核心） */
  async retry(id: string, ownerId: string): Promise<{ view: JobView | null; reason?: string }> {
    const row = await this.store.findById(id);
    if (!row || row.ownerId !== ownerId) return { view: null };
    if (row.status === 'running' || row.status === 'pending') {
      return { view: jobRowToView(row), reason: '任务正在执行中，无需重跑' };
    }
    if (row.status === 'succeeded') {
      return { view: jobRowToView(row), reason: '任务已成功，无需重跑' };
    }
    const runner = this.registry.resolve(row.type, row.params);
    if (!runner) {
      return { view: jobRowToView(row), reason: '该任务类型未登记跨实例重跑能力，请联系管理员或重新派发' };
    }
    // 条件更新消竞态：并发重跑时只有一个调用方拿到重置后的行
    const reset = await this.store.resetForRetry(id);
    if (!reset) return { view: jobRowToView(row), reason: '任务已被其他实例重新派发' };
    const snapshot = jobRowToView(reset);
    void this.executor.execute(reset, runner);
    logger.info('异步任务重跑', { jobId: id, type: row.type, driver: 'db' });
    emitJobEvent('created', snapshot, ownerId);
    return { view: snapshot };
  }

  /** 读库取产物（仅归属人） */
  async artifact(id: string, ownerId: string): Promise<JobArtifact | null> {
    const row = await this.store.findById(id);
    if (!row || row.ownerId !== ownerId) return null;
    if (row.status !== 'succeeded' || !row.artifactContent || !row.artifactContentType || !row.fileName) return null;
    return { fileName: row.fileName, contentType: row.artifactContentType, content: row.artifactContent };
  }

  /** 裁剪已结束的最旧任务（失败静默——裁剪不影响正确性） */
  private prune(): void {
    void this.store.prune(JOB_DB_MAX_ENTRIES).catch(() => undefined);
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
