/*
 * @file 审计日志归档服务单测（M10 E-10 / PRD-010 AC7）
 * @description 覆盖归档核心语义：按截止线批量迁移、严格小于边界不迁、分批推进、
 *   先写后删的 fail-closed（写归档失败绝不删在线）、崩溃重跑幂等（归档已写入但在线未删的
 *   中间态可安全重放）、maxBatches 上限、删零中止防死循环、计数与分页透传。
 *   端口用内存桩（与 Prisma 适配同语义：list 稳定升序 / write 主键 upsert），锁语义由
 *   @fw/queue 的 cron 分布式锁承载（既有 TC-JOB-002 覆盖），本文件不重复。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { AuditArchiveService } from '../audit-archive.js';
import type { AuditArchivePort } from '../audit-archive.js';
import type { AuditLogRecord, AuditQuery, ID } from '../types.js';
import type { PageResult } from '@fw/db';

/** 构造一条审计记录（字段与在线表落盘形态一致） */
function row(id: string, createdAt: string, module = 'order'): AuditLogRecord {
  return {
    id,
    userId: 'u-1',
    module,
    action: 'update',
    category: 'data',
    event: `${module}.update`,
    result: 'success',
    familyId: null,
    jti: null,
    requestId: null,
    targetType: 'order',
    targetId: `t-${id}`,
    beforeValue: { status: 'pending' },
    afterValue: { status: 'paid' },
    ip: '10.0.0.1',
    userAgent: 'vitest',
    traceId: `trace-${id}`,
    createdAt: new Date(createdAt),
  };
}

/**
 * 内存桩端口：list 按 createdAt asc + id asc 稳定升序；
 * write 按主键 upsert（覆盖同 id）；其余语义与 Prisma 适配一致。
 * `writeError` 可注入写归档失败；`deleteReturns` 可注入删除返回 0 的异常场景。
 */
function stubPort(online: AuditLogRecord[], archived: AuditLogRecord[] = [], options: { writeError?: Error; deleteReturns?: number } = {}): AuditArchivePort & { deletedIds: ID[][] } {
  return {
    deletedIds: [],
    async listAuditLogsOlderThan(cutoff: Date, limit: number) {
      return online
        .filter((r) => r.createdAt < cutoff)
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : 1))
        .slice(0, limit);
    },
    async writeArchivedAuditLogs(rows: AuditLogRecord[]) {
      if (options.writeError) throw options.writeError;
      for (const r of rows) {
        const idx = archived.findIndex((a) => a.id === r.id);
        if (idx >= 0) archived[idx] = r;
        else archived.push(r);
      }
    },
    async deleteAuditLogsByIds(ids: ID[]) {
      this.deletedIds.push([...ids]);
      if (options.deleteReturns !== undefined) return options.deleteReturns;
      let removed = 0;
      for (const id of ids) {
        const idx = online.findIndex((r) => r.id === id);
        if (idx >= 0) {
          online.splice(idx, 1);
          removed += 1;
        }
      }
      return removed;
    },
    async countAuditLogs() {
      return online.length;
    },
    async countArchivedAuditLogs() {
      return archived.length;
    },
    async pageArchivedAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
      const items = archived.filter((r) => (query.module ? r.module === query.module : true));
      return { items, total: items.length, page: query.page, pageSize: query.pageSize, hasMore: false };
    },
  };
}

describe('AuditArchiveService（M10 E-10）', () => {
  const cutoff = new Date('2026-10-15T00:00:00.000Z');

  it('按截止线迁移：早于截止线的记录全部进归档表，在线表行数回落，字段逐项保留', async () => {
    const port = stubPort([row('a1', '2026-09-01T00:00:00.000Z'), row('a2', '2026-09-15T00:00:00.000Z'), row('b1', '2026-10-14T23:59:59.999Z'), row('keep1', cutoff.toISOString()), row('keep2', '2026-10-20T00:00:00.000Z')]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff });
    expect(result).toEqual({ archived: 3, batches: 1, lastBatchSize: 3 });
    const counts = await service.counts();
    expect(counts).toEqual({ online: 2, archived: 3 });
    // 迁移的行字段逐项一致（id / createdAt / 脱敏前后值 / traceId）
    const page = await service.page({ page: 1, pageSize: 10, module: 'order' });
    const ids = page.items.map((r) => r.id).sort();
    expect(ids).toEqual(['a1', 'a2', 'b1']);
    expect(page.items[0].traceId).toBe('trace-a1');
    expect(page.items[0].afterValue).toEqual({ status: 'paid' });
  });

  it('边界严格小于：createdAt 恰等于截止线的记录不迁移', async () => {
    const port = stubPort([row('edge', cutoff.toISOString())]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff });
    expect(result.archived).toBe(0);
    expect(await service.counts()).toEqual({ online: 1, archived: 0 });
  });

  it('分批推进：单批 batchSize 取尽为止，批序按 createdAt 升序', async () => {
    const rows = ['2026-08-01', '2026-08-02', '2026-08-03', '2026-08-04', '2026-08-05'].map((d, i) => row(`old${i}`, `${d}T00:00:00.000Z`));
    const port = stubPort([...rows]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff, batchSize: 2 });
    expect(result).toEqual({ archived: 5, batches: 3, lastBatchSize: 1 });
    // 三批删除均按升序稳定序（分批迁移的分页依据）
    expect(port.deletedIds.map((ids) => ids.length)).toEqual([2, 2, 1]);
    expect(await service.counts()).toEqual({ online: 0, archived: 5 });
  });

  it('maxBatches 上限：单轮最多迁 N 批，其余留给下一轮（长任务不独占锁）', async () => {
    const rows = [1, 2, 3, 4, 5].map((i) => row(`old${i}`, `2026-08-0${i}T00:00:00.000Z`));
    const port = stubPort([...rows]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff, batchSize: 2, maxBatches: 1 });
    expect(result).toEqual({ archived: 2, batches: 1, lastBatchSize: 2 });
    expect(await service.counts()).toEqual({ online: 3, archived: 2 });
  });

  it('fail-closed：写归档失败立即中止，在线表一条不删（绝不先删后写）', async () => {
    const port = stubPort([row('a1', '2026-09-01T00:00:00.000Z'), row('a2', '2026-09-02T00:00:00.000Z')], [], { writeError: new Error('archive 表不可写') });
    const service = new AuditArchiveService(port);
    await expect(service.runOnce({ cutoff, batchSize: 1 })).rejects.toThrow('archive 表不可写');
    expect(port.deletedIds).toEqual([]);
    expect(await service.counts()).toEqual({ online: 2, archived: 0 });
  });

  it('崩溃重跑幂等：归档已写入但在线未删（写后删前的中间态），重跑覆盖同 id 且不产生重复', async () => {
    const old1 = row('a1', '2026-09-01T00:00:00.000Z');
    const port = stubPort([old1], [old1]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff });
    expect(result).toEqual({ archived: 1, batches: 1, lastBatchSize: 1 });
    expect(await service.counts()).toEqual({ online: 0, archived: 1 });
  });

  it('删零中止：删除返回 0 时终止循环防死循环', async () => {
    const port = stubPort([row('a1', '2026-09-01T00:00:00.000Z')], [], { deleteReturns: 0 });
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff, batchSize: 1000 });
    expect(result.archived).toBe(0);
    expect(result.batches).toBe(0);
    expect(port.deletedIds.length).toBe(1);
  });

  it('空表：无更早记录时零批零迁移', async () => {
    const port = stubPort([]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff });
    expect(result).toEqual({ archived: 0, batches: 0, lastBatchSize: 0 });
  });

  it('batchSize 非法取值收敛为 1（防御性，不抛错不空转）', async () => {
    const port = stubPort([row('a1', '2026-09-01T00:00:00.000Z'), row('a2', '2026-09-02T00:00:00.000Z')]);
    const service = new AuditArchiveService(port);
    const result = await service.runOnce({ cutoff, batchSize: 0 });
    expect(result.archived).toBe(2);
    expect(result.batches).toBe(2);
  });
});
