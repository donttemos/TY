/*
 * @file 审计日志查询端点（PRD-003 §3.10 / TC-AUTH-011 / TC-WEB-004 后端）
 * @description GET /api/v1/audit-logs —— 需 audit:read；按人 / 模块 / 对象 / 时间区间分页查询。
 *   dataScope=self 时强制只返回本人操作记录（数据权限在查询层收敛，避免越权查看他人轨迹）。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/auth
 */

import { Controller, Get, Query } from '@nestjs/common';
import type { PageResult } from '@fw/db';
import {
  AuthService,
  CurrentUser,
  PERM,
  Permissions,
  resolveDataScope,
  type AuditAction,
  type AuditLogRecord,
  type RequestUser,
} from '@fw/auth';

/**
 * 审计日志控制器：/api/v1/audit-logs
 */
@Controller('/api/v1/audit-logs')
export class AuditController {
  constructor(private readonly auth: AuthService) {}

  /** 审计日志分页查询 */
  @Permissions(PERM.AUDIT_READ)
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('user_id') userId?: string,
    @Query('module') module?: string,
    @Query('action') action?: string,
    @Query('target_type') targetType?: string,
    @Query('target_id') targetId?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
  ): Promise<PageResult<AuditLogRecord>> {
    const scope = resolveDataScope(user);
    return this.auth.auditLogs({
      page: Number(page),
      pageSize: Number(pageSize),
      // dataScope=self：只允许查询本人记录，忽略传入的 user_id
      userId: scope.selfOnly ? user.id : userId,
      module,
      action: action as AuditAction | undefined,
      targetType,
      targetId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }
}
