/*
 * @file 审计日志查询端点（admin 模板）
 * @description GET /api/v1/audit-logs —— 需 audit:read；按人 / 模块 / 对象 / 时间区间分页查询，
 *   支持 sort 白名单排序（parseSortQuery）。dataScope 四档在查询层收敛：self=仅本人；
 *   org=本人部门成员；org_below=部门及下级成员；all=不限。范围外目标用户绝不返回轨迹。
 *   （示例工程的异步导出走任务中心，模板骨架不含 @fw/queue，故未携带 export 端点；接入
 *   @fw/queue 后参照 example-api 的 audit.controller.ts 补 export 即可。）
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-14）：审计查询/导出增 trace_id/request_id/family_id/category/event 过滤 + 未知过滤参数 400
 * @module __APP_NAME__/auth
 */
import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type PageResult } from '@fw/db';
import {
  AuthService,
  CurrentUser,
  DATA_SCOPE_ORG,
  PERM,
  Permissions,
  auditRegistryVersion,
  listAuditEvents,
  resolveDataScopeFilter,
  type AuditAction,
  type AuditEventDefinition,
  type AuditEventResult,
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
 * 审计过滤参数白名单（M12 W2 OBS-14）
 *
 * 键为 HTTP 查询参数名。白名单外的过滤字段一律 400 —— 不静默忽略（列表参数白名单解析既有约定），
 * 防止「调用方以为在过滤实际全量返回」的排障陷阱。
 */
export const AUDIT_FILTER_PARAMS = [
  'page',
  'pageSize',
  'user_id',
  'module',
  'action',
  'target_type',
  'target_id',
  'from',
  'to',
  'sort',
  'trace_id',
  'request_id',
  'family_id',
  'category',
  'event',
  // PRD-015（M15）：结果与租户维度过滤
  'result',
  'tenant_id',
  // mock 失败演示路径专用透传参数（simulate=fail；smoke-mock 用，后端忽略该值）
  'simulate',
] as const;

/** 结果枚举（PRD-015 FR-15-05 四态） */
const AUDIT_RESULTS: readonly AuditEventResult[] = ['success', 'denied', 'failed', 'unknown'];
/** 事件多值过滤上限（防止把 URL 当查询语言） */
const AUDIT_EVENTS_MAX = 20;

/**
 * 解析结果过滤参数（非法取值 400，不静默忽略）
 * @param value 查询参数
 */
export function parseAuditResult(value?: string): AuditEventResult | undefined {
  if (!value) return undefined;
  if (!(AUDIT_RESULTS as readonly string[]).includes(value)) {
    throw new BizError(ErrorCode.BAD_REQUEST, `非法 result：${value}（允许：${AUDIT_RESULTS.join(' / ')}）`);
  }
  return value as AuditEventResult;
}

/**
 * 解析事件过滤参数（逗号分隔多值，≤20）——「按风险筛选」由前端注册表展开
 * @param value 查询参数
 */
export function parseAuditEvents(value?: string): string[] | undefined {
  if (!value) return undefined;
  const codes = [...new Set(value.split(',').map((item) => item.trim()).filter((item) => item.length > 0))];
  if (codes.length === 0) return undefined;
  if (codes.length > AUDIT_EVENTS_MAX) {
    throw new BizError(ErrorCode.BAD_REQUEST, `event 多值上限 ${AUDIT_EVENTS_MAX}，当前 ${codes.length}`);
  }
  return codes;
}

/**
 * 解析租户过滤参数（十进制字符串；'0' 表示未知/存量）
 * @param value 查询参数
 */
export function parseTenantId(value?: string): string | undefined {
  if (!value) return undefined;
  if (!/^\d+$/.test(value)) {
    throw new BizError(ErrorCode.BAD_REQUEST, `非法 tenant_id：${value}（应为十进制数字字符串）`);
  }
  return value;
}

/** 白名单校验：未知过滤参数直接 400（反向验证：不静默忽略） */
export function assertKnownFilterParams(query: Record<string, unknown>): void {
  for (const key of Object.keys(query)) {
    if (!(AUDIT_FILTER_PARAMS as readonly string[]).includes(key)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `未知过滤参数：${key}（允许：${AUDIT_FILTER_PARAMS.join(' / ')}）`);
    }
  }
}

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
    @Req() request: Request,
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
    @Query('trace_id') traceId?: string,
    @Query('request_id') requestId?: string,
    @Query('family_id') familyId?: string,
    @Query('category') category?: string,
    @Query('event') event?: string,
    @Query('result') result?: string,
    @Query('tenant_id') tenantId?: string,
  ): Promise<PageResult<AuditLogRecord>> {
    assertKnownFilterParams(request.query as Record<string, unknown>);
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
      traceId,
      requestId,
      familyId,
      category,
      events: parseAuditEvents(event),
      // PRD-015：结果与租户过滤（与 dataScope 取交集，不放大可见范围）
      result: parseAuditResult(result),
      tenantId: parseTenantId(tenantId),
    });
  }

  /**
   * 事件注册表（PRD-015 FR-15-01，ADR-0032 R1）
   *
   * 路由必须声明在 `:id` 之前，否则 `events` 会被当作 id 命中详情分支。
   */
  @Permissions(PERM.AUDIT_READ)
  @Get('events')
  listEvents(): { version: string; items: readonly AuditEventDefinition[] } {
    return { version: auditRegistryVersion(), items: listAuditEvents() };
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
