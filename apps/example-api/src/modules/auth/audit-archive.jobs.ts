/*
 * @file 审计归档定时任务（M10 E-10 / PRD-010 AC7）
 * @description 依托 @fw/queue 的 @Cron 注册 `audit.archive`（每天 02:00，默认加分布式锁，
 *   多副本只跑一次——与 auth.refresh-cleanup 同机制，TC-JOB-002 口径）。
 *   保留天数 / 单批条数从配置键读取（AUDIT_ARCHIVE_RETENTION_DAYS / AUDIT_ARCHIVE_BATCH_SIZE），
 *   执行期经 loadEnv() 读取（配合配置中心热更白名单外的「重启生效」口径，见 docs/60 §3）。
 *   迁移循环本体在 @fw/auth 的 AuditArchiveService（先写归档 upsert、后删在线，fail-closed），
 *   本类只做调度、快照与错误兜底：失败不影响业务，保留错误快照等下一轮调度。
 *   最近一次运行快照经 MaintenanceController 暴露；手动触发走 demo-queue 的 cron-tick。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-17 donttemo M12 W3（PRD-012 OBS-18）：快照公共字段集统一（补 enabled/lastDurationMs）
 * @module example-api/auth
 */

import { Injectable } from '@nestjs/common';
import { Cron } from '@fw/queue';
import { Logger } from '@fw/logger';
import { loadEnv } from '@fw/config';
import { AuditArchiveService, type AuditArchiveRunResult } from '@fw/auth';

const logger = Logger.for('auth.audit-archive');

/** 归档 cron 任务名（分布式锁键 cron:audit.archive） */
export const AUDIT_ARCHIVE_CRON_NAME = 'audit.archive';

/** 归档 cron 表达式：每天 02:00（避开 03:00 的 refresh 清理窗口） */
export const AUDIT_ARCHIVE_CRON_EXPRESSION = '0 2 * * *';

/** 归档运行快照 */
export interface AuditArchiveSnapshot {
  /** 已注册的 cron 任务名 */
  name: string;
  /** cron 表达式 */
  expression: string;
  /** 任务调度是否启用（MQ_CRON_ENABLED；OBS-18 公共字段集） */
  enabled: boolean;
  /** 当前生效的保留天数 */
  retentionDays: number;
  /** 当前生效的单批条数 */
  batchSize: number;
  /** 累计触发次数（含手动触发） */
  runs: number;
  /** 最近一次运行时间（ISO；未运行过为 null） */
  lastRunAt: string | null;
  /** 最近一次运行耗时（毫秒；OBS-18 公共字段集统一，未运行过为 null） */
  lastDurationMs: number | null;
  /** 最近一次迁移截止线（早于该时间的记录迁入归档表，ISO） */
  lastCutoff: string | null;
  /** 最近一次迁出在线表的条数 */
  lastArchived: number | null;
  /** 最近一次运行后的在线表 / 归档表行数（「在线表行数回落」断言依据） */
  lastCounts: { online: number; archived: number } | null;
  /** 最近一次运行错误（无错误为 null） */
  lastError: string | null;
}

/**
 * 审计归档任务载体：@Cron 标注的方法由 QueueModule 启动期自动扫描注册
 */
@Injectable()
export class AuditArchiveJobs {
  private runs = 0;

  private lastRunAt: string | null = null;

  private lastCutoff: string | null = null;

  private lastArchived: number | null = null;

  private lastCounts: { online: number; archived: number } | null = null;

  private lastDurationMs: number | null = null;

  private lastError: string | null = null;

  constructor(private readonly archive: AuditArchiveService) {}

  /** 每天 02:00 把早于保留线的审计记录迁入归档表（加分布式锁，多副本只跑一次） */
  @Cron(AUDIT_ARCHIVE_CRON_EXPRESSION, { name: AUDIT_ARCHIVE_CRON_NAME, lock: true })
  async archiveOldAuditLogs(): Promise<void> {
    const env = loadEnv();
    const retentionDays = env.AUDIT_ARCHIVE_RETENTION_DAYS;
    const batchSize = env.AUDIT_ARCHIVE_BATCH_SIZE;
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    this.runs += 1;
    this.lastRunAt = new Date().toISOString();
    this.lastCutoff = cutoff.toISOString();
    const startedAt = Date.now();
    try {
      const result: AuditArchiveRunResult = await this.archive.runOnce({ cutoff, batchSize });
      this.lastArchived = result.archived;
      this.lastCounts = await this.archive.counts();
      this.lastDurationMs = Date.now() - startedAt;
      this.lastError = null;
      logger.info('审计归档定时任务完成', {
        cutoff: this.lastCutoff,
        archived: result.archived,
        batches: result.batches,
        online: this.lastCounts.online,
        archivedTotal: this.lastCounts.archived,
      });
    } catch (error) {
      // 归档失败不影响业务：在线数据未动（先写后删的 fail-closed），保留错误快照等待下次调度
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastDurationMs = Date.now() - startedAt;
      logger.error('审计归档定时任务失败', { cutoff: this.lastCutoff, error: this.lastError });
    }
  }

  /** 最近运行快照（供查询端点与冒烟断言） */
  snapshot(): AuditArchiveSnapshot {
    return {
      name: AUDIT_ARCHIVE_CRON_NAME,
      expression: AUDIT_ARCHIVE_CRON_EXPRESSION,
      enabled: loadEnv().MQ_CRON_ENABLED,
      retentionDays: loadEnv().AUDIT_ARCHIVE_RETENTION_DAYS,
      batchSize: loadEnv().AUDIT_ARCHIVE_BATCH_SIZE,
      runs: this.runs,
      lastRunAt: this.lastRunAt,
      lastDurationMs: this.lastDurationMs,
      lastCutoff: this.lastCutoff,
      lastArchived: this.lastArchived,
      lastCounts: this.lastCounts,
      lastError: this.lastError,
    };
  }
}
