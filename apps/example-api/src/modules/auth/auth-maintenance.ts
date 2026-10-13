/*
 * @file 鉴权维护定时任务（M3 遗留项④：refresh 过期记录定时清理）
 * @description 数据字典 §3.9：`refresh_tokens` 过期 30 天以上的记录由定时任务清理。
 *   依托 @fw/queue 的 @Cron 注册 `auth.refresh-cleanup`（每天 03:00，默认加分布式锁），
 *   复用 RefreshTokenService.cleanup()（即 store.purgeExpiredRefreshTokens），
 *   驱动切换 / 多副本部署无需改动本文件。最近一次运行结果经 MaintenanceController 暴露，
 *   冒烟与运维可通过 demo-queue 的 cron-tick 手动触发（仍走分布式锁）。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/auth
 */

import { Injectable } from '@nestjs/common';
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
  /** 累计触发次数（含手动触发） */
  runs: number;
  /** 最近一次运行时间（ISO；未运行过为 null） */
  lastRunAt: string | null;
  /** 最近一次清理截止线（早于该时间即删除，ISO） */
  lastCutoff: string | null;
  /** 最近一次清理条数 */
  lastRemoved: number | null;
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

  private lastError: string | null = null;

  constructor(private readonly refresh: RefreshTokenService) {}

  /** 每天 03:00 清理过期 30 天以上的刷新令牌记录（加分布式锁，多副本只跑一次） */
  @Cron('0 3 * * *', { name: 'auth.refresh-cleanup', lock: true })
  async cleanupExpiredRefreshTokens(): Promise<void> {
    const cutoff = new Date(Date.now() - REFRESH_TOKEN_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    this.runs += 1;
    this.lastRunAt = new Date().toISOString();
    this.lastCutoff = cutoff.toISOString();
    try {
      this.lastRemoved = await this.refresh.cleanup(cutoff);
      this.lastError = null;
      logger.info('refresh 过期记录定时清理完成', { cutoff: this.lastCutoff, removed: this.lastRemoved });
    } catch (error) {
      // 清理失败不影响业务：保留错误快照供探查，等待下次调度
      this.lastError = error instanceof Error ? error.message : String(error);
      logger.error('refresh 过期记录定时清理失败', { error: this.lastError });
    }
  }

  /** 最近运行快照（供查询端点与冒烟断言） */
  snapshot(): RefreshCleanupSnapshot {
    return {
      name: 'auth.refresh-cleanup',
      expression: '0 3 * * *',
      runs: this.runs,
      lastRunAt: this.lastRunAt,
      lastCutoff: this.lastCutoff,
      lastRemoved: this.lastRemoved,
      lastError: this.lastError,
    };
  }
}
