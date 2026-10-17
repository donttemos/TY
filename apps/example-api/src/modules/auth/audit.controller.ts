/*
 * @file 审计日志查询端点（PRD-003 §3.10 / TC-AUTH-011 / TC-WEB-004 后端）
 * @description GET /api/v1/audit-logs —— 需 audit:read；按人 / 模块 / 对象 / 时间区间分页查询。
 *   dataScope 四档在查询层收敛（M8 T-M8-04）：self=仅本人；org=本人部门成员；
 *   org_below=部门及下级成员；all=不限。范围外目标用户绝不返回轨迹。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-04：self 收敛之外支持 org / org_below（部门成员展开）
 * @modified 2026-10-14 donttemo BUG-15：GET /audit-logs 支持 `sort=<snake_case 字段>:<asc|desc>`（api-spec §1.5），
 *   经 @fw/db 的 parseSortQuery 按 AUDIT_SORT_FIELDS 白名单解析后透传存储层；未知字段 / 非法方向 / 超上限一律 400
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-14）：审计查询/导出增 trace_id/request_id/family_id/category/event 过滤 + 未知过滤参数 400
 * @modified 2026-10-15 donttemo N-02：新增 GET /audit-logs/export（需 audit:export）——异步导出，
 *   派发到任务中心返回 jobId（进度 / 下载 / 重跑走 /jobs/:id/*）；同样受 dataScope 收敛。
 *   路由刻意声明在 @Get(':id') 之前，否则 'export' 会被当作 id 命中详情分支。
 * @module example-api/auth
 */

import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type PageResult, type Sort } from '@fw/db';
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
import { JobRunnerRegistry } from '../jobs/job-runner.registry.js';
import { JobCenterService, type JobView } from '../jobs/job-center.service.js';
import type { JobArtifact, JobReporter } from '../jobs/job-center.port.js';
import type { Request } from 'express';

/**
 * 审计日志可排序字段白名单（api-spec §1.5，BUG-15）
 *
 * 键为 HTTP 参数名（snake_case），值为实体字段名。白名单外字段一律 400 ——
 * 既避免把任意 query 参数拼进 orderBy，也避免通过排序推断未暴露字段。
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
] as const;

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
    private readonly jobs: JobCenterService,
    private readonly jobRegistry: JobRunnerRegistry,
  ) {
    // M10 E-01：登记审计导出的执行体工厂——db/bullmq 驱动下跨实例重跑经此处按 params 重建
    // runner（闭包不落盘）；memory 驱动下派发仍走闭包，此登记不参与执行路径
    this.jobRegistry.register('audit.export', (params) => (report) => this.executeExport(rebuildExportQuery(params), report));
  }

  /** 审计日志分页查询 */
  @Permissions(PERM.AUDIT_READ)
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
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
  ): Promise<PageResult<AuditLogRecord>> {
    // M12 W2 OBS-14：未知过滤参数 400（不静默忽略）
    assertKnownFilterParams(request.query as Record<string, unknown>);
    const scope = await resolveDataScopeFilter(user, this.org);
    // 排序解析放在数据范围解析之后、查询之前：非法 sort（未知字段 / 非法方向 / 超上限）直接 400（BUG-15）
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
      event,
    });
  }

  /**
   * 审计日志异步导出（N-02）
   *
   * 与列表同源的数据范围与筛选条件，结果以 CSV 落进任务中心：
   * 立即返回 `jobId`（不等导出完成），前端任务条轮询 `GET /jobs/:id/progress`，
   * 完成后走 `GET /jobs/:id/download` 取文件。
   *
   * 单次导出上限 `EXPORT_MAX_ROWS`：审计表随时间线性增长，无上限的导出既拖垮请求，
   * 也会把产物顶到内存上限（任务中心对超过 ~20MB 的产物直接失败并给出可读原因）。
   *
   * 路由必须声明在 `@Get(':id')` 之前：Nest 按声明顺序匹配，否则 `export` 会被当成 id。
   */
  @Permissions(PERM.AUDIT_EXPORT)
  @Get('export')
  async export(
    @CurrentUser() user: RequestUser,
    @CurrentUser('id') operator: string,
    @Req() request: Request,
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
  ): Promise<JobView> {
    assertKnownFilterParams(request.query as Record<string, unknown>);
    const scope = await resolveDataScopeFilter(user, this.org);
    const parsedSort = parseSortQuery<AuditLogRecord>(sort, AUDIT_SORT_FIELDS);
    let scopeUserIds: string[] | undefined;
    if (scope.selfOnly) scopeUserIds = [user.id];
    else if (scope.departmentIds) scopeUserIds = await this.org.listUserIdsByDepartmentIds(scope.departmentIds);

    // M10 E-01：完整查询条件固化进 params（JSON 可序列化）——跨实例重跑按它重建同一查询。
    // dataScope 已在此刻收敛为具体 ID（self → userId；org/org_below → userIds），重跑沿用派发时范围。
    const params: Record<string, unknown> = {
      userId: scope.selfOnly ? user.id : userId,
      userIds: scope.selfOnly ? undefined : scopeUserIds,
      module: module ?? null,
      action: action ?? null,
      targetType: targetType ?? null,
      targetId: targetId ?? null,
      from: from ?? null,
      to: to ?? null,
      sort: parsedSort ?? null,
      traceId: traceId ?? null,
      requestId: requestId ?? null,
      familyId: familyId ?? null,
      category: category ?? null,
      event: event ?? null,
      maxRows: EXPORT_MAX_ROWS,
    };

    return this.jobs.create({
      type: 'audit.export',
      title: '审计日志导出',
      ownerId: operator,
      params,
      runner: (report) => this.executeExport(rebuildExportQuery(params), report),
    });
  }

  /**
   * 执行审计导出（派发闭包与重跑工厂共用的执行体）
   *
   * 单次导出上限 `EXPORT_MAX_ROWS`：审计表随时间线性增长，无上限的导出既拖垮请求，
   * 也会把产物顶到内存上限（任务中心对超过 ~20MB 的产物直接失败并给出可读原因）。
   */
  private async executeExport(query: ExportQuery, report: JobReporter): Promise<JobArtifact> {
    report(5, '统计待导出条数');
    const first = await this.auth.auditLogs({ ...query, page: 1, pageSize: EXPORT_PAGE_SIZE });
    const total = Math.min(first.total, EXPORT_MAX_ROWS);
    const rows: AuditLogRecord[] = [...first.items];

    let page = 2;
    while (rows.length < total) {
      const next = await this.auth.auditLogs({ ...query, page, pageSize: EXPORT_PAGE_SIZE });
      if (next.items.length === 0) break;
      rows.push(...next.items);
      report(5 + Math.round((Math.min(rows.length, total) / Math.max(total, 1)) * 85), `已读取 ${Math.min(rows.length, total)}/${total} 条`);
      page += 1;
    }

    report(95, '生成 CSV');
    const clipped = rows.slice(0, EXPORT_MAX_ROWS);
    const content = buildAuditCsv(clipped);
    return {
      fileName: `audit-logs-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
      contentType: 'text/csv',
      content,
    };
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

/** 单次导出最大行数（防止无限拉取与产物超限） */
const EXPORT_MAX_ROWS = 5000;

/** 导出分页批大小（与 api-spec §1.5 的 pageSize 上限一致） */
const EXPORT_PAGE_SIZE = 200;

/** 审计导出查询（执行体入参，与 AuthService.auditLogs 的查询面一致；JSON 序列化后可跨实例重建） */
interface ExportQuery {
  userId?: string;
  userIds?: string[];
  module?: string;
  action?: AuditAction;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  sort?: Sort<AuditLogRecord>;
  traceId?: string;
  requestId?: string;
  familyId?: string;
  category?: string;
  event?: string;
}

/** null/undefined → undefined（params 反序列化后空值统一为 null） */
function strOrNull(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/**
 * 从持久化 params 重建导出查询（M10 E-01：跨实例重跑的执行依据）
 *
 * params 在派发时已把 dataScope 收敛为具体 ID（self → userId；org/org_below → userIds 数组），
 * 重建即还原派发时的可见范围；from/to 由 ISO 字符串还原为 Date。
 */
function rebuildExportQuery(params: Record<string, unknown>): ExportQuery {
  return {
    userId: strOrNull(params.userId),
    userIds: Array.isArray(params.userIds) ? (params.userIds.filter((v) => typeof v === 'string') as string[]) : undefined,
    module: strOrNull(params.module),
    action: strOrNull(params.action) as AuditAction | undefined,
    targetType: strOrNull(params.targetType),
    targetId: strOrNull(params.targetId),
    from: strOrNull(params.from) ? new Date(params.from as string) : undefined,
    to: strOrNull(params.to) ? new Date(params.to as string) : undefined,
    sort: (params.sort ?? undefined) as Sort<AuditLogRecord> | undefined,
    traceId: strOrNull(params.traceId),
    requestId: strOrNull(params.requestId),
    familyId: strOrNull(params.familyId),
    category: strOrNull(params.category),
    event: strOrNull(params.event),
  };
}

/** CSV 单元格转义：包引号 + 内部引号翻倍；换行统一为空格避免破坏行结构 */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  const text = typeof value === 'string' ? value : JSON.stringify(value) ?? String(value);
  return `"${text.replace(/"/g, '""').replace(/[\r\n]+/g, ' ')}"`;
}

/**
 * 组装审计 CSV
 *
 * 带 UTF-8 BOM：Excel 直接打开中文列头不乱码（这是导出功能最常见的落地问题）。
 */
export function buildAuditCsv(rows: AuditLogRecord[]): string {
  const header = ['id', 'createdAt', 'userId', 'module', 'action', 'targetType', 'targetId', 'ip', 'traceId', 'requestId', 'familyId', 'category', 'event', 'before', 'after'];
  const lines = [header.join(',')];
  for (const row of rows) {
    lines.push(
      [
        csvCell(row.id),
        csvCell(row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt),
        csvCell(row.userId),
        csvCell(row.module),
        csvCell(row.action),
        csvCell(row.targetType),
        csvCell(row.targetId),
        csvCell(row.ip),
        csvCell(row.traceId),
        csvCell(row.requestId),
        csvCell(row.familyId),
        csvCell(row.category),
        csvCell(row.event),
        csvCell(row.beforeValue),
        csvCell(row.afterValue),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
