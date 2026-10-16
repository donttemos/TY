/*
 * @file 审计日志归档服务与端口（M10 E-10，PRD-010 AC7）
 * @description 审计日志无归档策略时单表无限增长，大体量会拖垮在线查询（81 号规划 A-7）。
 *   本文件提供框架级归档原语：
 *   - `AuditArchivePort`：存储侧端口（读旧批 / 幂等写归档 / 删在线 / 计数 / 归档分页查询），
 *     由业务项目以 Prisma 适配（example-api 参考实现），框架内不绑定具体库；
 *   - `AuditArchiveService.runOnce`：批量「先写归档、后删在线」的迁移循环——
 *     写失败即中止绝不删在线（fail-closed 不丢数据），写归档按主键 upsert 幂等
 *     （崩溃在写后删前，重跑覆盖同 id 不产生重复），保证最终一致；
 *   定时触发与分布式锁由 @fw/queue 的 @Cron（lock: true）承载，多副本单执行；
 *   保留天数 / 批大小为配置键（AUDIT_ARCHIVE_*，ENV_KEY_PATHS 登记）。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/auth
 */

import type { PageResult } from '@fw/db';
import type { AuditLogRecord, AuditQuery, ID } from './types.js';

/**
 * 审计归档存储端口
 *
 * 语义约定：
 * - `listAuditLogsOlderThan` 必须按 `createdAt asc, id asc` 稳定序返回（分批迁移的分页依据）；
 * - `writeArchivedAuditLogs` 必须按主键 upsert（幂等）：崩溃重跑覆盖同 id，不产生重复行；
 * - 删除只允许发生在写入成功之后（由 AuditArchiveService 保证，端口不做跨表事务假设）。
 */
export interface AuditArchivePort {
  /** 读取早于截止线（createdAt < cutoff）的审计记录，最多 limit 条 */
  listAuditLogsOlderThan(cutoff: Date, limit: number): Promise<AuditLogRecord[]>;
  /** 批量写入归档表（主键 upsert，幂等） */
  writeArchivedAuditLogs(rows: AuditLogRecord[]): Promise<void>;
  /** 按主键删除在线表记录，返回实际删除条数 */
  deleteAuditLogsByIds(ids: ID[]): Promise<number>;
  /** 在线表总行数（监控与「行数回落」断言用） */
  countAuditLogs(): Promise<number>;
  /** 归档表总行数 */
  countArchivedAuditLogs(): Promise<number>;
  /** 归档表分页查询（查询条件与 AuthStore.pageAuditLogs 同形，冷数据追溯用） */
  pageArchivedAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>>;
}

/** 归档运行入参 */
export interface AuditArchiveRunOptions {
  /** 迁移截止线：createdAt 早于该时刻的记录才迁移（严格小于，边界记录不动） */
  cutoff: Date;
  /** 单批条数（默认 1000）：控制单次事务压力，批间让出连接 */
  batchSize?: number;
  /** 单次 runOnce 最大批数（防单轮长占锁；不传 = 不限，跑完为止） */
  maxBatches?: number;
}

/** 归档运行结果 */
export interface AuditArchiveRunResult {
  /** 本轮实际迁出在线表的条数 */
  archived: number;
  /** 本轮批数 */
  batches: number;
  /** 最后一批条数（小于 batchSize 即在线表已无更早记录，本轮自然收敛） */
  lastBatchSize: number;
}

/** 默认单批条数 */
const DEFAULT_BATCH_SIZE = 1000;

/**
 * 审计日志归档服务：批量迁移「在线表 → 归档表」
 *
 * 迁移次序是数据安全的关键：每批先 `writeArchived`（upsert 幂等）成功后才 `deleteByIds`。
 * 任意一步失败立即中止，在线表数据不动——宁可下轮重跑，绝不先删后写。
 */
export class AuditArchiveService {
  /**
   * @param port 存储端口（业务项目提供 Prisma 实现）
   */
  constructor(private readonly port: AuditArchivePort) {}

  /**
   * 执行一轮归档：循环迁移直到无更早记录或达到 maxBatches
   * @param options 截止线 / 批大小 / 批数上限
   */
  async runOnce(options: AuditArchiveRunOptions): Promise<AuditArchiveRunResult> {
    const batchSize = Math.max(1, Math.floor(options.batchSize ?? DEFAULT_BATCH_SIZE));
    const maxBatches = Math.max(1, Math.floor(options.maxBatches ?? Number.MAX_SAFE_INTEGER));
    let archived = 0;
    let batches = 0;
    let lastBatchSize = 0;

    while (batches < maxBatches) {
      const rows = await this.port.listAuditLogsOlderThan(options.cutoff, batchSize);
      if (rows.length === 0) break;
      // 先写归档（upsert 幂等）：失败抛错中止，在线表未动，下轮重跑无副作用
      await this.port.writeArchivedAuditLogs(rows);
      const deleted = await this.port.deleteAuditLogsByIds(rows.map((row) => row.id));
      if (deleted === 0) {
        // 在线行已被并发方清走且写入已完成：视为本批已完成但无新增，终止防死循环
        break;
      }
      archived += deleted;
      batches += 1;
      lastBatchSize = rows.length;
      // 未满一批说明已取尽，无需再查
      if (rows.length < batchSize) break;
    }

    return { archived, batches, lastBatchSize };
  }

  /** 在线表 / 归档表行数快照（监控与冒烟断言「在线表行数回落」用） */
  async counts(): Promise<{ online: number; archived: number }> {
    const [online, archived] = await Promise.all([this.port.countAuditLogs(), this.port.countArchivedAuditLogs()]);
    return { online, archived };
  }

  /**
   * 归档表分页查询（冷数据追溯，条件语义与在线审计查询一致）
   * @param query 查询条件
   */
  async page(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
    return this.port.pageArchivedAuditLogs(query);
  }
}
