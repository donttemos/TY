/*
 * @file 审计归档查询与导出端点（M10 E-10）
 * @description 归档表（audit_log_archives）的两个冷数据出口：
 *   - `GET /api/v1/audit-archives`（需 audit:read）：分页查询，数据范围收敛与 /audit-logs 同源
 *     （self=仅本人；org/org_below=部门成员展开）——归档不是越权后门；
 *   - `GET /api/v1/audit-archives/export`（需 audit:export）：异步导出，派发到任务中心返回
 *     `jobId`（类型 `audit.archive.export`，进度/下载/重跑走 §3.11 的 /jobs/:id/*），
 *     CSV 形态与在线审计导出逐字节同构（复用 buildAuditCsv：UTF-8 BOM + CRLF + 引号转义）。
 *   排序沿用 AUDIT_SORT_FIELDS 白名单（未知字段 400，与在线表口径一致）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/auth
 */

import { Controller, Get, Inject, Query, Req } from '@nestjs/common';
import { PERM, Permissions, CurrentUser, resolveDataScopeFilter, DATA_SCOPE_ORG, AuditArchiveService, AuditService, type AuditAction, type AuditEventResult, type AuditLogRecord, type DataScopeOrgPort, type RequestUser } from '@fw/auth';
import { parseSortQuery, type PageResult, type Sort } from '@fw/db';
import { AUDIT_SORT_FIELDS, assertKnownFilterParams, buildAuditCsv, describeExportFilters, parseAuditEvents, parseAuditResult, parseTenantId } from './audit.controller.js';
import { JobRunnerRegistry } from '../jobs/job-runner.registry.js';
import { JobCenterService, type JobView } from '../jobs/job-center.service.js';
import type { JobArtifact, JobReporter } from '../jobs/job-center.port.js';
import { clientIp } from './auth.controller.js';
import type { Request } from 'express';

/** 归档导出任务类型（JobRunnerRegistry 登记键） */
export const AUDIT_ARCHIVE_EXPORT_TYPE = 'audit.archive.export';

/** 单次归档导出最大行数（与在线审计导出同口径，防产物超限） */
const EXPORT_MAX_ROWS = 5000;

/** 导出分页批大小 */
const EXPORT_PAGE_SIZE = 200;

/** 归档导出查询（执行体入参，JSON 序列化后可跨实例重建） */
interface ArchiveExportQuery {
  userId?: string;
  userIds?: string[];
  module?: string;
  action?: AuditAction;
  targetType?: string;
  targetId?: string;
  from?: Date;
  to?: Date;
  sort?: Sort<AuditLogRecord>;
  /** M12 W2 契约字段 + PRD-015 结果/租户过滤（与在线导出同口径） */
  traceId?: string;
  requestId?: string;
  familyId?: string;
  category?: string;
  events?: string[];
  result?: AuditEventResult;
  tenantId?: string;
}

/**
 * 审计归档控制器：/api/v1/audit-archives
 */
@Controller('/api/v1/audit-archives')
export class AuditArchiveController {
  constructor(
    private readonly archive: AuditArchiveService,
    @Inject(DATA_SCOPE_ORG) private readonly org: DataScopeOrgPort,
    private readonly jobs: JobCenterService,
    private readonly jobRegistry: JobRunnerRegistry,
    private readonly audit: AuditService,
  ) {
    // M10 E-01：登记归档导出的执行体工厂——db/bullmq 驱动下跨实例重跑经此处按 params 重建
    this.jobRegistry.register(AUDIT_ARCHIVE_EXPORT_TYPE, (params) => (report) => this.executeExport(rebuildExportQuery(params), report));
  }

  /** 归档审计分页查询（冷数据追溯；数据范围与在线审计同源收敛） */
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
    @Query('result') result?: string,
    @Query('tenant_id') tenantId?: string,
  ): Promise<PageResult<AuditLogRecord>> {
    // 与在线列表同一条白名单：未知参数 400，不静默忽略（M12 W2 约定）
    assertKnownFilterParams(request.query as Record<string, unknown>);
    const scope = await resolveDataScopeFilter(user, this.org);
    const parsedSort = parseSortQuery<AuditLogRecord>(sort, AUDIT_SORT_FIELDS);
    let scopeUserIds: string[] | undefined;
    if (scope.selfOnly) scopeUserIds = [user.id];
    else if (scope.departmentIds) scopeUserIds = await this.org.listUserIdsByDepartmentIds(scope.departmentIds);

    return this.archive.page({
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
      // 归档不是越权后门：过滤只做收窄，归属人集合仍按 dataScope 收敛
      traceId,
      requestId,
      familyId,
      category,
      event,
      result: parseAuditResult(result),
      tenantId: parseTenantId(tenantId),
    });
  }

  /**
   * 归档审计异步导出：与在线审计导出同机制（任务中心 + 归属人语义），
   * 数据范围在派发时收敛为具体 ID 固化进 params，跨实例重跑沿用派发时范围。
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
    @Query('result') result?: string,
    @Query('tenant_id') tenantId?: string,
  ): Promise<JobView> {
    // 与列表同一条白名单（此前归档导出未校验，未知参数会被静默忽略）
    assertKnownFilterParams(request.query as Record<string, unknown>);
    const scope = await resolveDataScopeFilter(user, this.org);
    const parsedSort = parseSortQuery<AuditLogRecord>(sort, AUDIT_SORT_FIELDS);
    let scopeUserIds: string[] | undefined;
    if (scope.selfOnly) scopeUserIds = [user.id];
    else if (scope.departmentIds) scopeUserIds = await this.org.listUserIdsByDepartmentIds(scope.departmentIds);

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
      events: parseAuditEvents(event) ?? null,
      result: parseAuditResult(result) ?? null,
      tenantId: parseTenantId(tenantId) ?? null,
      maxRows: EXPORT_MAX_ROWS,
    };

    const job = await this.jobs.create({
      type: AUDIT_ARCHIVE_EXPORT_TYPE,
      title: '审计归档导出',
      ownerId: operator,
      params,
      runner: (report) => this.executeExport(rebuildExportQuery(params), report),
    });
    // 冷数据导出同样留痕（与在线导出一致：谁、按什么条件、导的是归档）
    this.audit.recordEvent('audit.export', {
      userId: operator,
      targetId: job.id,
      targetLabel: `归档 · ${describeExportFilters({
        userId: params.userId as string | undefined,
        module: params.module as string | undefined,
        action: params.action as string | undefined,
        event: Array.isArray(params.events) ? (params.events as string[]).join(',') : undefined,
        result: params.result as string | undefined,
        tenantId: params.tenantId as string | undefined,
        from: params.from as string | undefined,
        to: params.to as string | undefined,
      })}`,
      after: { filters: params, scope: 'archive', maxRows: EXPORT_MAX_ROWS },
      ip: clientIp(request),
    });
    return job;
  }

  /** 执行归档导出（派发闭包与重跑工厂共用；逐页读归档表，CSV 与在线导出同构） */
  private async executeExport(query: ArchiveExportQuery, report: JobReporter): Promise<JobArtifact> {
    report(5, '统计待导出条数');
    const first = await this.archive.page({ ...query, page: 1, pageSize: EXPORT_PAGE_SIZE });
    const total = Math.min(first.total, EXPORT_MAX_ROWS);
    const rows: AuditLogRecord[] = [...first.items];

    let page = 2;
    while (rows.length < total) {
      const next = await this.archive.page({ ...query, page, pageSize: EXPORT_PAGE_SIZE });
      if (next.items.length === 0) break;
      rows.push(...next.items);
      report(5 + Math.round((Math.min(rows.length, total) / Math.max(total, 1)) * 85), `已读取 ${Math.min(rows.length, total)}/${total} 条`);
      page += 1;
    }

    report(95, '生成 CSV');
    const clipped = rows.slice(0, EXPORT_MAX_ROWS);
    return {
      fileName: `audit-archives-${new Date().toISOString().replace(/[:.]/g, '-')}.csv`,
      contentType: 'text/csv',
      content: buildAuditCsv(clipped),
    };
  }
}

/** null/undefined → undefined（params 反序列化后空值统一为 null） */
function strOrNull(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** 从持久化 params 重建导出查询（M10 E-01 同款；from/to 由 ISO 字符串还原 Date） */
function rebuildExportQuery(params: Record<string, unknown>): ArchiveExportQuery {
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
    events: Array.isArray(params.events) ? (params.events.filter((value) => typeof value === 'string') as string[]) : undefined,
    result: strOrNull(params.result) as AuditEventResult | undefined,
    tenantId: strOrNull(params.tenantId),
  };
}
