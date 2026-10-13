/*
 * @file 鉴权维护查询端点
 * @description GET /api/v1/auth-maintenance/refresh-cleanup —— 暴露 refresh 过期记录清理任务
 *   （auth.refresh-cleanup，M3 遗留项④）的注册信息与最近一次运行快照。框架自检路由，标 @Public()。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/auth
 */

import { Controller, Get } from '@nestjs/common';
import { Public } from '@fw/auth';
import { AuthMaintenanceJobs, type RefreshCleanupSnapshot } from './auth-maintenance.js';

/**
 * 鉴权维护控制器：路径前缀 /api/v1/auth-maintenance
 */
@Public()
@Controller('/api/v1/auth-maintenance')
export class MaintenanceController {
  constructor(private readonly jobs: AuthMaintenanceJobs) {}

  /** refresh 过期清理任务快照 */
  @Get('refresh-cleanup')
  refreshCleanup(): RefreshCleanupSnapshot {
    return this.jobs.snapshot();
  }
}
