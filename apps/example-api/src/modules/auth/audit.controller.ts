/*
 * @file 审计日志查询端点（PRD-003 §3.10 / TC-AUTH-011 / TC-WEB-004 后端）
 * @description GET /api/v1/audit-logs —— 需 audit:read；按人 / 模块 / 对象 / 时间区间分页查询。
 *   dataScope 四档在查询层收敛（M8 T-M8-04）：self=仅本人；org=本人部门成员；
 *   org_below=部门及下级成员；all=不限。范围外目标用户绝不返回轨迹。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-04：self 收敛之外支持 org / org_below（部门成员展开）
 * @module example-api/auth
 */

import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import type { PageResult } from '@fw/db';
import {
  AuthService,
  CurrentUser,
  DATA_SCOPE_ORG,
  PERM,
  Permissions,
  resolveDataScopeFilter,
  type AuditAction,
  type AuditLogRecord,
  type DataScopeOrgPort,
  type RequestUser,
} from '@fw/auth';
import { ADMIN_STORE } from '../admin/admin-store.js';
import type { AdminStore } from '../admin/admin-store.js';

/**
 * 审计日志控制器：/api/v1/audit-logs
 */
@Controller('/api/v1/audit-logs')
export class AuditController {
  constructor(
    private readonly auth: AuthService,
    @Inject(DATA_SCOPE_ORG) private readonly org: DataScopeOrgPort,
    @Inject(ADMIN_STORE) private readonly admin: AdminStore,
  ) {}

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
    const scope = await resolveDataScopeFilter(user, this.org);
    // 数据范围 → 归属人约束：self 只允许查询本人记录（忽略传入的 user_id）；
    // org / org_below 展开为部门成员集合（与传入 user_id 取交集）；all 不约束
    let scopeUserIds: string[] | undefined;
    if (scope.selfOnly) scopeUserIds = [user.id];
    else if (scope.departmentIds) scopeUserIds = await this.org.listUserIdsByDepartmentIds(scope.departmentIds);

    return this.auth.auditLogs({
      page: Number(page),
      pageSize: Number(pageSize),
      userId: scope.selfOnly ? user.id : userId,
      userIds: scope.selfOnly ? undefined : scopeUserIds,
      module,
      action: action as AuditAction | undefined,
      targetType,
      targetId,
      from: from ? new Date(from) : undefined,
      to: to ? new Date(to) : undefined,
    });
  }

  /**
   * 审计详情（字段级变更前后值）
   * dataScope 与列表同源收敛：self 档只看本人记录，范围外目标一律 404（不泄露存在性，fail-closed）。
   */
  @Permissions(PERM.AUDIT_READ)
  @Get(':id')
  async detail(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<AuditLogRecord> {
    const scope = await resolveDataScopeFilter(user, this.org);
    const record = await this.admin.findAuditLogById(id);
    if (!record) throw new BizError(ErrorCode.NOT_FOUND, '审计日志不存在');
    if (scope.selfOnly && record.userId !== user.id) {
      throw new BizError(ErrorCode.NOT_FOUND, '审计日志不存在');
    }
    return record;
  }
}
