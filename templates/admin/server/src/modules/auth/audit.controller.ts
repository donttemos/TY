/*
 * @file 审计日志查询端点（admin 模板）
 * @description GET /api/v1/audit-logs —— 需 audit:read；按人 / 模块 / 对象 / 时间区间分页查询，
 *   支持 sort 白名单排序（parseSortQuery）。dataScope 四档在查询层收敛：self=仅本人；
 *   org=本人部门成员；org_below=部门及下级成员；all=不限。范围外目标用户绝不返回轨迹。
 *   （示例工程的异步导出走任务中心，模板骨架不含 @fw/queue，故未携带 export 端点；接入
 *   @fw/queue 后参照 example-api 的 audit.controller.ts 补 export 即可。）
 * @author donttemo
 * @created 2026-10-15
 * @module __APP_NAME__/auth
 */
import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type PageResult } from '@fw/db';
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
 * 审计日志可排序字段白名单：键为 HTTP 参数名（snake_case），值为实体字段名。
 * 白名单外字段一律 400 —— 既避免把任意 query 参数拼进 orderBy，也避免通过排序推断未暴露字段。
 */
export const AUDIT_SORT_FIELDS = {
  id: 'id',
  module: 'module',
  action: 'action',
  target_type: 'targetType',
  created_at: 'createdAt',
} as const;

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
    @Query('sort') sort?: string,
  ): Promise<PageResult<AuditLogRecord>> {
    const scope = await resolveDataScopeFilter(user, this.org);
    // 排序解析放在数据范围解析之后、查询之前：非法 sort（未知字段 / 非法方向 / 超上限）直接 400
    const parsedSort = parseSortQuery<AuditLogRecord>(sort, AUDIT_SORT_FIELDS);
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
      sort: parsedSort,
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
