/*
 * @file 任务中心 memory 驱动（N-02 原行为，M10 E-01 迁移为驱动）
 * @description 进程内存登记表——N-02 交付时的原始行为，M10 E-01 仅原样迁入驱动壳（逻辑零改动，
 *   既有单测兼容）：任务登记、产物、执行全部驻留本进程，与默认队列驱动 `memory` 的生命周期一致
 *   （PRD-007 §8：memory 驱动进程退出即丢任务）。多副本 / 跨重启保留场景请切 `db` / `bullmq` 驱动。
 * @modified 2026-10-15 donttemo M10 E-01：自 job-center.service.ts 原样迁入（实现 JobCenterPort），
 *   逻辑与 N-02 交付版逐字一致——「memory 驱动行为不变」是 E-01 的硬约束
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
  JobReporter,
  JobRunner,
  JobView,
} from '../job-center.port.js';

const logger = Logger.for('jobs');

/** 内部登记项 */
interface JobEntry {
  view: JobView;
  ownerId: string;
  runner: JobRunner;
  artifact: JobArtifact | null;
}

/** 单任务产物体积上限（字符数，约 20 MB 文本） */
const MAX_ARTIFACT_CHARS = 20 * 1024 * 1024;

/** 登记表保留上限（超出后丢弃最旧的已结束任务，防止长时间运行内存无界增长） */
const MAX_ENTRIES = 200;

/**
 * memory 驱动：进程内登记表（默认驱动，N-02 原行为）
 */
@Injectable()
export class MemoryJobDriver implements JobCenterPort {
  readonly kind = 'memory' as const;

  private readonly entries = new Map<string, JobEntry>();

  /** 派发任务：立即返回视图（status=pending），执行在后台进行 */
  create(options: JobCreateOptions): JobView {
    if (!options.runner) throw new Error('memory 驱动要求 create 提供 runner 闭包');
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
    this.entries.set(id, { view, ownerId: options.ownerId, runner: options.runner, artifact: null });
    this.prune();
    // 快照必须先于 execute 取：execute 会同步把状态推到 running（ runner 首次 await 前），
    // 后取快照会让「派发响应」变成 running，与「立即返回 pending」的契约不符
    const snapshot = { ...view };
    // 不 await：接口立即返回 jobId，执行在事件循环上继续（与「关闭弹窗任务继续」的前端语义一致）
    void this.execute(id);
    logger.info('异步任务已派发', { jobId: id, type: view.type, ownerId: options.ownerId, traceId: view.traceId });
    return snapshot;
  }

  /** 读取任务视图（仅归属人可见；不匹配返回 null，由调用方转 404 不泄露存在性） */
  get(id: string, ownerId: string): JobView | null {
    const entry = this.entries.get(id);
    if (!entry || entry.ownerId !== ownerId) return null;
    return { ...entry.view };
  }

  /**
   * 原地重跑（仅失败任务；成功任务不重复跑，避免重复产物）
   * @returns 更新后的视图；任务不存在 / 非归属人返回 null；状态不允许抛错标记
   */
  retry(id: string, ownerId: string): { view: JobView | null; reason?: string } {
    const entry = this.entries.get(id);
    if (!entry || entry.ownerId !== ownerId) return { view: null };
    if (entry.view.status === 'running' || entry.view.status === 'pending') {
      return { view: { ...entry.view }, reason: '任务正在执行中，无需重跑' };
    }
    if (entry.view.status === 'succeeded') {
      return { view: { ...entry.view }, reason: '任务已成功，无需重跑' };
    }
    entry.artifact = null;
    entry.view.error = null;
    entry.view.progress = 0;
    entry.view.message = '已重新派发';
    entry.view.status = 'pending';
    entry.view.updatedAt = new Date().toISOString();
    // 同 create：先取 pending 快照再启动执行，避免响应里带着 execute 同步推就的 running
    const snapshot = { ...entry.view };
    void this.execute(id);
    logger.info('异步任务重跑', { jobId: id, type: entry.view.type });
    return { view: snapshot };
  }

  /** 取任务产物（仅归属人） */
  artifact(id: string, ownerId: string): JobArtifact | null {
    const entry = this.entries.get(id);
    if (!entry || entry.ownerId !== ownerId) return null;
    return entry.artifact;
  }

  /** 执行任务（内部）：状态流转 + 进度上报 + 失败兜底 */
  private async execute(id: string): Promise<void> {
    const entry = this.entries.get(id);
    if (!entry) return;
    const report: JobReporter = (progress, message) => {
      const clamped = Number.isFinite(progress) ? Math.max(0, Math.min(100, Math.round(progress))) : 0;
      entry.view.progress = Math.max(entry.view.progress, clamped);
      if (message !== undefined) entry.view.message = message;
      entry.view.updatedAt = new Date().toISOString();
    };

    entry.view.status = 'running';
    entry.view.message = '执行中';
    entry.view.updatedAt = new Date().toISOString();
    try {
      const artifact = await entry.runner(report);
      if (artifact && artifact.content.length > MAX_ARTIFACT_CHARS) {
        throw new Error(`产物超过 ${Math.round(MAX_ARTIFACT_CHARS / 1024 / 1024)}MB 上限，请缩小导出范围后重试`);
      }
      if (artifact) {
        entry.artifact = artifact;
        entry.view.fileName = artifact.fileName;
      }
      entry.view.progress = 100;
      entry.view.status = 'succeeded';
      entry.view.message = artifact ? '已完成，可下载' : '已完成';
      entry.view.error = null;
      logger.info('异步任务完成', { jobId: id, type: entry.view.type, chars: artifact?.content.length ?? 0 });
    } catch (error) {
      entry.view.status = 'failed';
      entry.view.error = error instanceof Error ? error.message : String(error);
      entry.view.message = '执行失败，可重试';
      logger.error('异步任务失败', { jobId: id, type: entry.view.type, traceId: entry.view.traceId, error: entry.view.error });
    } finally {
      entry.view.updatedAt = new Date().toISOString();
    }
  }

  /** 裁剪登记表：先丢已结束的最旧项 */
  private prune(): void {
    if (this.entries.size <= MAX_ENTRIES) return;
    const finished = [...this.entries.values()]
      .filter((entry) => entry.view.status === 'succeeded' || entry.view.status === 'failed')
      .sort((a, b) => (a.view.createdAt < b.view.createdAt ? -1 : 1));
    for (const entry of finished) {
      if (this.entries.size <= MAX_ENTRIES) break;
      this.entries.delete(entry.view.id);
    }
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
