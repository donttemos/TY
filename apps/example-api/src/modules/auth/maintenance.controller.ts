/*
 * @file 鉴权维护查询端点
 * @description GET /api/v1/auth-maintenance/refresh-cleanup —— 暴露 refresh 过期记录清理任务
 *   （auth.refresh-cleanup，M3 遗留项④）的注册信息与最近一次运行快照；
 *   GET /api/v1/auth-maintenance/audit-archive —— 暴露审计归档任务（audit.archive，M10 E-10）
 *   的配置与最近一次运行快照（保留线 / 迁移条数 / 在线与归档表行数）。框架自检路由，标 @Public()。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-10：新增审计归档任务快照端点
 * @module example-api/auth
 */

import { Controller, Get } from '@nestjs/common';
import { Public } from '@fw/auth';
import { AuthMaintenanceJobs, type RefreshCleanupSnapshot } from './auth-maintenance.js';
import { AuditArchiveJobs, type AuditArchiveSnapshot } from './audit-archive.jobs.js';

/**
 * 鉴权维护控制器：路径前缀 /api/v1/auth-maintenance
 */
@Public()
@Controller('/api/v1/auth-maintenance')
export class MaintenanceController {
  constructor(
    private readonly jobs: AuthMaintenanceJobs,
    private readonly archiveJobs: AuditArchiveJobs,
  ) {}

  /** refresh 过期清理任务快照 */
  @Get('refresh-cleanup')
  refreshCleanup(): RefreshCleanupSnapshot {
    return this.jobs.snapshot();
  }

  /** 审计归档任务快照（M10 E-10） */
  @Get('audit-archive')
  auditArchive(): AuditArchiveSnapshot {
    return this.archiveJobs.snapshot();
  }
}
