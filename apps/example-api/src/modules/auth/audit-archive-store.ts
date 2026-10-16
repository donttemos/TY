/*
 * @file 审计归档存储的 Prisma 实现（E-10 存储适配器）
 * @description 把 @fw/auth 的 AuditArchivePort 端口映射到 audit_log_archives 表（数据字典 §3.17）。
 *   关键语义（与 @fw/audit-archive 契约一致）：
 *   - listAuditLogsOlderThan 按 createdAt asc + id asc 稳定升序（分批迁移的分页依据）；
 *   - writeArchivedAuditLogs 按主键逐行 upsert（幂等）：崩溃重跑覆盖同 id 不产生重复——
 *     宁可多几次往返也不引入「先删归档再插」的丢数据窗口；批量大小由 AUDIT_ARCHIVE_BATCH_SIZE
 *     控制（默认 1000），归档任务每天至多迁「保留线外的存量 + 当日新增」，量级可预期；
 *   - 查询条件与 PrismaAuthStore.pageAuditLogs 同形（同白名单 / 同 tie-breaker），
 *     冷数据追溯与在线查询行为一致。
 *   全部为参数化查询，不涉及原生 SQL（dialect 白名单约束）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/auth
 */

import { Inject, Injectable } from '@nestjs/common';
import { DB_CLIENT, type ModelDelegate, type PrismaClientLike } from '@fw/db';
import type { PageResult } from '@fw/db';
import type { AuditArchivePort } from '@fw/auth';
import type { AuditLogRecord, AuditQuery, ID } from '@fw/auth';

/** audit_logs / audit_log_archives 行（两表同构，归档表多 archived_at） */
interface AuditLogRow {
  id: string;
  userId: string | null;
  module: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}

/** 单页条数上限（与 @fw/db 对齐） */
const PAGE_SIZE_MAX = 100;

/**
 * AuditArchivePort 的 Prisma 实现
 */
@Injectable()
export class PrismaAuditArchiveStore implements AuditArchivePort {
  /**
   * @param client DbModule 提供的插桩 PrismaClient
   */
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {}

  /** 取模型委托 */
  private delegate(model: string): ModelDelegate {
    return this.client[model] as ModelDelegate;
  }

  async listAuditLogsOlderThan(cutoff: Date, limit: number): Promise<AuditLogRecord[]> {
    const rows = (await this.delegate('auditLog').findMany({
      where: { createdAt: { lt: cutoff } },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: Math.max(1, Math.floor(limit)),
    })) as AuditLogRow[];
    return rows.map((row) => toAuditRecord(row));
  }

  async writeArchivedAuditLogs(rows: AuditLogRecord[]): Promise<void> {
    const delegate = this.delegate('auditLogArchive');
    for (const record of rows) {
      const data = {
        userId: record.userId,
        module: record.module,
        action: record.action,
        targetType: record.targetType,
        targetId: record.targetId,
        beforeValue: record.beforeValue ?? undefined,
        afterValue: record.afterValue ?? undefined,
        ip: record.ip,
        userAgent: record.userAgent,
        traceId: record.traceId,
        createdAt: record.createdAt,
      };
      // 主键 upsert：归档表只增不改不删，update 分支仅为崩溃重跑的覆盖路径兜底
      await delegate.upsert({ where: { id: record.id }, create: { id: record.id, ...data }, update: data });
    }
  }

  async deleteAuditLogsByIds(ids: ID[]): Promise<number> {
    if (ids.length === 0) return 0;
    const result = await this.delegate('auditLog').deleteMany({ where: { id: { in: ids } } });
    return result.count;
  }

  async countAuditLogs(): Promise<number> {
    return this.delegate('auditLog').count({});
  }

  async countArchivedAuditLogs(): Promise<number> {
    return this.delegate('auditLogArchive').count({});
  }

  async pageArchivedAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    const where: Record<string, unknown> = {};
    // 归档表同样受数据范围收敛：userIds 为数据范围展开的归属人集合，与 userId 取交集
    if (query.userIds !== undefined) {
      const ids = query.userId ? query.userIds.filter((id) => id === query.userId) : query.userIds;
      where.userId = { in: ids };
    } else if (query.userId) {
      where.userId = query.userId;
    }
    if (query.module) where.module = query.module;
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }

    // 与 pageAuditLogs 同规则：排序白名单在 HTTP 层解析，此处补 id asc tie-breaker（TC-ORM-002）
    const sortEntries = Object.entries(query.sort ?? {});
    const orderBy: Array<Record<string, string>> = sortEntries.length
      ? sortEntries.map(([field, direction]) => ({ [field]: direction }))
      : [{ createdAt: 'desc' }];
    if (!sortEntries.some(([field]) => field === 'id')) orderBy.push({ id: 'asc' });

    const [rows, total] = await Promise.all([
      this.delegate('auditLogArchive').findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<AuditLogRow[]>,
      this.delegate('auditLogArchive').count({ where }),
    ]);

    return {
      items: rows.map((row) => toAuditRecord(row)),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }
}

/** 行 → 领域对象（与 PrismaAuthStore.toAuditLog 同构） */
function toAuditRecord(row: AuditLogRow): AuditLogRecord {
  return {
    id: row.id,
    userId: row.userId,
    module: row.module,
    action: row.action as AuditLogRecord['action'],
    targetType: row.targetType,
    targetId: row.targetId,
    beforeValue: row.beforeValue ?? null,
    afterValue: row.afterValue ?? null,
    ip: row.ip,
    userAgent: row.userAgent,
    traceId: row.traceId,
    createdAt: row.createdAt,
  };
}
