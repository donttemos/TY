/*
 * @file 任务中心持久层（M10 E-01）
 * @description db / bullmq 驱动共用的任务登记存储：`JobStore` 端口 + 内存实现（单测）+
 *   Prisma 实现（生产，`jobs` 表，数据字典 §3.15）。Prisma 实现沿用本仓「本地投影 + delegate」
 *   约定（不直接依赖 @prisma/client 生成类型），与 PrismaTenantStore 同形。
 *   写路径全部按主键定位；裁剪语义与 memory 驱动一致——只丢「已结束」的最旧任务，
 *   running / pending 任务永不裁剪（进度面还在被轮询）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import type { JobStatus } from './job-center.port.js';

/** 持久层任务行（与 jobs 表列一一对应） */
export interface JobRecordRow {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  traceId: string | null;
  fileName: string | null;
  artifactContent: string | null;
  artifactContentType: string | null;
  ownerId: string;
  params: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

/** 进度面可变字段 */
export interface JobProgressPatch {
  status?: JobStatus;
  progress?: number;
  message?: string | null;
  error?: string | null;
  fileName?: string | null;
  artifactContent?: string | null;
  artifactContentType?: string | null;
}

/** 任务登记存储端口（db / bullmq 驱动的持久面） */
export interface JobStore {
  /** 新增任务行（create 落库） */
  insert(row: JobRecordRow): Promise<void>;
  /** 按主键读行（不存在返回 null） */
  findById(id: string): Promise<JobRecordRow | null>;
  /** 更新进度 / 终态字段（按主键） */
  update(id: string, patch: JobProgressPatch): Promise<void>;
  /**
   * 重跑前的原子重置：仅当任务仍处于 failed 时把状态重置为 pending 并清空产物/错误，
   * 返回重置后的行；已被并发重跑（状态不再是 failed）返回 null —— 用条件更新消掉
   * 「两个实例同时点重跑」的竞态（多副本下必然出现）。
   */
  resetForRetry(id: string): Promise<JobRecordRow | null>;
  /** 裁剪：删除最旧的已结束任务直到总数 ≤ maxEntries（无任务可删时静默返回） */
  prune(maxEntries: number): Promise<void>;
  /** 当前登记总数（裁剪判断用） */
  count(): Promise<number>;
}

/** 内存实现：单测与无 DB 场景（语义与 Prisma 版逐字一致，双实现对撞由单测保证） */
export class MemoryJobStore implements JobStore {
  private readonly rows = new Map<string, JobRecordRow>();

  async insert(row: JobRecordRow): Promise<void> {
    this.rows.set(row.id, { ...row });
  }

  async findById(id: string): Promise<JobRecordRow | null> {
    const row = this.rows.get(id);
    return row ? { ...row } : null;
  }

  async update(id: string, patch: JobProgressPatch): Promise<void> {
    const row = this.rows.get(id);
    if (!row) return;
    Object.assign(row, patch, { updatedAt: new Date().toISOString() });
  }

  async resetForRetry(id: string): Promise<JobRecordRow | null> {
    const row = this.rows.get(id);
    if (!row || row.status !== 'failed') return null;
    row.status = 'pending';
    row.progress = 0;
    row.message = '已重新派发';
    row.error = null;
    row.fileName = null;
    row.artifactContent = null;
    row.artifactContentType = null;
    row.updatedAt = new Date().toISOString();
    return { ...row };
  }

  async prune(maxEntries: number): Promise<void> {
    if (this.rows.size <= maxEntries) return;
    const finished = [...this.rows.values()]
      .filter((row) => row.status === 'succeeded' || row.status === 'failed')
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : 1));
    for (const row of finished) {
      if (this.rows.size <= maxEntries) break;
      this.rows.delete(row.id);
    }
  }

  async count(): Promise<number> {
    return this.rows.size;
  }
}

/** Prisma jobs 表行投影（Date → ISO 由本层统一转换，调用面只见字符串） */
interface JobPrismaRow {
  id: string;
  type: string;
  title: string;
  status: string;
  progress: number;
  message: string | null;
  error: string | null;
  traceId: string | null;
  fileName: string | null;
  artifactContent: string | null;
  artifactContentType: string | null;
  ownerId: string;
  params: unknown;
  createdAt: Date;
  updatedAt: Date;
}

/** 行 → 记录投影 */
function toRecord(row: JobPrismaRow): JobRecordRow {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    status: (['pending', 'running', 'succeeded', 'failed'].includes(row.status) ? row.status : 'failed') as JobStatus,
    progress: row.progress,
    message: row.message,
    error: row.error,
    traceId: row.traceId,
    fileName: row.fileName,
    artifactContent: row.artifactContent,
    artifactContentType: row.artifactContentType,
    ownerId: row.ownerId,
    params: (row.params ?? null) as Record<string, unknown> | null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** delegate 形状（本地投影，避免依赖生成类型） */
interface JobDelegate {
  create(args: { data: Record<string, unknown> }): Promise<JobPrismaRow>;
  findUnique(args: { where: { id: string } }): Promise<JobPrismaRow | null>;
  update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<JobPrismaRow>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
  findMany(args: Record<string, unknown>): Promise<JobPrismaRow[]>;
  count(args?: Record<string, unknown>): Promise<number>;
  delete(args: { where: { id: string } }): Promise<unknown>;
}

/**
 * Prisma 实现：jobs 表（数据字典 §3.15）
 */
@Injectable()
export class PrismaJobStore implements JobStore {
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {}

  private get delegate(): JobDelegate {
    return (this.client as unknown as Record<string, JobDelegate>).jobRecord;
  }

  async insert(row: JobRecordRow): Promise<void> {
    await this.delegate.create({
      data: {
        id: row.id,
        type: row.type,
        title: row.title,
        status: row.status,
        progress: row.progress,
        message: row.message,
        error: row.error,
        traceId: row.traceId,
        fileName: row.fileName,
        artifactContent: row.artifactContent,
        artifactContentType: row.artifactContentType,
        ownerId: row.ownerId,
        params: row.params === null || row.params === undefined ? undefined : JSON.stringify(row.params),
        createdAt: new Date(row.createdAt),
        updatedAt: new Date(row.updatedAt),
      },
    });
  }

  async findById(id: string): Promise<JobRecordRow | null> {
    const row = await this.delegate.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async update(id: string, patch: JobProgressPatch): Promise<void> {
    const data: Record<string, unknown> = { updatedAt: new Date() };
    if (patch.status !== undefined) data.status = patch.status;
    if (patch.progress !== undefined) data.progress = patch.progress;
    if (patch.message !== undefined) data.message = patch.message;
    if (patch.error !== undefined) data.error = patch.error;
    if (patch.fileName !== undefined) data.fileName = patch.fileName;
    if (patch.artifactContent !== undefined) data.artifactContent = patch.artifactContent;
    if (patch.artifactContentType !== undefined) data.artifactContentType = patch.artifactContentType;
    await this.delegate.update({ where: { id }, data });
  }

  async resetForRetry(id: string): Promise<JobRecordRow | null> {
    // 条件更新消竞态：只有仍处于 failed 的行会被重置，并发重跑方拿到 count=0 → 返回 null
    const { count } = await this.delegate.updateMany({
      where: { id, status: 'failed' },
      data: {
        status: 'pending',
        progress: 0,
        message: '已重新派发',
        error: null,
        fileName: null,
        artifactContent: null,
        artifactContentType: null,
        updatedAt: new Date(),
      },
    });
    if (count === 0) return null;
    const row = await this.delegate.findUnique({ where: { id } });
    return row ? toRecord(row) : null;
  }

  async prune(maxEntries: number): Promise<void> {
    let remaining = await this.delegate.count();
    if (remaining <= maxEntries) return;
    const finished = await this.delegate.findMany({
      where: { status: { in: ['succeeded', 'failed'] } },
      orderBy: { createdAt: 'asc' },
    });
    for (const row of finished) {
      if (remaining <= maxEntries) break;
      await this.delegate.delete({ where: { id: row.id } });
      remaining -= 1;
    }
  }

  async count(): Promise<number> {
    return this.delegate.count();
  }
}
