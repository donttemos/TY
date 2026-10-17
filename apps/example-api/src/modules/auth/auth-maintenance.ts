/*
 * @file 鉴权维护定时任务（M3 遗留项④ + M11.2 ADR-0021 两级清理）
 * @description 数据字典 §3.9：`refresh_tokens` 过期 30 天以上的记录由定时任务清理。
 *   依托 @fw/queue 的 @Cron 注册 `auth.refresh-cleanup`（每天 03:00，默认加分布式锁），
 *   **两级清理**（ADR-0021）：先 `cleanupReplacements()`（replacement 密文 grace 级清空，
 *   每次运行都执行——可恢复密文存在期收缩到 grace 窗口 + 一个调度周期），再 `cleanup()`
 *   （过期 30 天删行）。驱动切换 / 多副本部署无需改动本文件。最近一次运行结果经
 *   MaintenanceController 暴露，冒烟与运维可通过 demo-queue 的 cron-tick 手动触发（仍走分布式锁）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W3（PRD-012 OBS-18）：快照公共字段集统一（补 enabled）
 * @module example-api/auth
 */

import { Injectable } from '@nestjs/common';
import { loadEnv } from '@fw/config';
import { Cron } from '@fw/queue';
import { Logger } from '@fw/logger';
import { RefreshTokenService } from '@fw/auth';

const logger = Logger.for('auth.maintenance');

/** 过期记录保留天数（数据字典 §3.9：过期 30 天以上清理） */
export const REFRESH_TOKEN_RETENTION_DAYS = 30;

/** 清理运行快照 */
export interface RefreshCleanupSnapshot {
  /** 已注册的 cron 任务名 */
  name: string;
  /** cron 表达式 */
  expression: string;
  /** 任务调度是否启用（MQ_CRON_ENABLED；OBS-18 公共字段集） */
  enabled: boolean;
  /** 累计触发次数（含手动触发） */
  runs: number;
  /** 最近一次运行时间（ISO；未运行过为 null） */
  lastRunAt: string | null;
  /** 最近一次清理截止线（早于该时间即删除，ISO） */
  lastCutoff: string | null;
  /** 最近一次删除的过期记录条数（30 天线） */
  lastRemoved: number | null;
  /** 最近一次清空的 replacement 密文条数（grace 线，ADR-0021） */
  lastCiphersCleared: number | null;
  /** 最近一次运行耗时（毫秒） */
  lastDurationMs: number | null;
  /** 最近一次运行错误（无错误为 null） */
  lastError: string | null;
}

/**
 * 鉴权维护任务载体：@Cron 标注的方法由 QueueModule 启动期自动扫描注册
 */
@Injectable()
export class AuthMaintenanceJobs {
  private runs = 0;

  private lastRunAt: string | null = null;

  private lastCutoff: string | null = null;

  private lastRemoved: number | null = null;

  private lastCiphersCleared: number | null = null;

  private lastDurationMs: number | null = null;

  private lastError: string | null = null;

  constructor(private readonly refresh: RefreshTokenService) {}

  /** 每天 03:00 两级清理（加分布式锁，多副本只跑一次）：先清 replacement 密文（grace 线），再删过期记录（30 天线） */
  @Cron('0 3 * * *', { name: 'auth.refresh-cleanup', lock: true })
  async cleanupExpiredRefreshTokens(): Promise<void> {
    const cutoff = new Date(Date.now() - REFRESH_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    this.runs += 1;
    this.lastRunAt = new Date().toISOString();
    this.lastCutoff = cutoff.toISOString();
    const startedAt = Date.now();
    try {
      // 两级顺序（ADR-0021 决策 4）：密文回收在前（每次都跑），删行在后（30 天线）
      this.lastCiphersCleared = await this.refresh.cleanupReplacements(new Date());
      this.lastRemoved = await this.refresh.cleanup(cutoff);
      this.lastDurationMs = Date.now() - startedAt;
      this.lastError = null;
      logger.info('refresh 定时清理完成（两级）', {
        cutoff: this.lastCutoff,
        ciphersCleared: this.lastCiphersCleared,
        removed: this.lastRemoved,
        durationMs: this.lastDurationMs,
      });
    } catch (error) {
      // 清理失败不影响业务：保留错误快照供探查，等待下次调度
      this.lastError = error instanceof Error ? error.message : String(error);
      this.lastDurationMs = Date.now() - startedAt;
      logger.error('refresh 定时清理失败', { error: this.lastError });
    }
  }

  /** 最近运行快照（供查询端点与冒烟断言） */
  snapshot(): RefreshCleanupSnapshot {
    return {
      name: 'auth.refresh-cleanup',
      expression: '0 3 * * *',
      enabled: loadEnv().MQ_CRON_ENABLED,
      runs: this.runs,
      lastRunAt: this.lastRunAt,
      lastCutoff: this.lastCutoff,
      lastRemoved: this.lastRemoved,
      lastCiphersCleared: this.lastCiphersCleared,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
    };
  }
}
