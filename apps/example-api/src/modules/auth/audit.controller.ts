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
 * @modified 2026-10-20 donttemo M15 安全加固：CSV 单元格编码改走 @fw/auth 的 escapeCsvCell——
 *   新增公式注入防护（= + - @ / 制表符前缀加单引号），存量引号转义与列序不变。
 * @modified 2026-10-21 donttemo P1 越权修复：detail() 原先只判 selfOnly，org / org_below 档可凭 ID
 *   直读列表里看不见的记录；改为与 list / export 共用 resolveDataScopeActors 的归属人集合，
 *   范围外与不存在统一 404（不泄露存在性）
 * @modified 2026-10-21 donttemo P1 租户隔离分维：list / export / detail 在归属人范围之外**另加租户范围**——
 *   普通请求强制使用服务端解析出的当前租户（客户端 tenant_id 只能收窄、与他租户不一致即 4001），
 *   详情同时校验记录 tenantId。dataScope=all 只解除归属人限制，不再隐含跨租户能力；跨租户检索只走
 *   `@IgnoreTenant()` + system:tenant:ignore 的维护入口（/audit-logs/platform*）
 * @module example-api/auth
 */

import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type PageResult, type Sort } from '@fw/db';
import {
  AuditService,
  AuthService,
  CurrentUser,
  DATA_SCOPE_ORG,
  IgnoreTenant,
  PERM,
  Permissions,
  auditRegistryVersion,
  escapeCsvCell,
  findAuditEvent,
  isActorWithinDataScope,
  isTenantWithinScope,
  listAuditEvents,
  resolveDataScopeActors,
  resolveTenantFilter,
  resolveTenantScope,
  type AuditAction,
  type AuditEventDefinition,
  type AuditEventResult,
  type AuditLogRecord,
  type DataScopeOrgPort,
  type RequestUser,
} from '@fw/auth';
import { ADMIN_STORE } from '../admin/admin-store.js';
import { clientIp } from './auth.controller.js';
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
  // PRD-015（M15）：结果与租户维度过滤
  'result',
  'tenant_id',
  // mock 失败演示路径专用透传参数（simulate=fail；smoke-mock 用，后端忽略该值）
  'simulate',
] as const;

/** 结果枚举（PRD-015 FR-15-05 四态） */
const AUDIT_RESULTS: readonly AuditEventResult[] = ['success', 'denied', 'failed', 'unknown'];

/**
 * 解析结果过滤参数
 *
 * 非法取值直接 400：静默忽略会让调用方误以为「过滤后就是这些」，
 * 这与 M12 W2「白名单外字段一律 400」的排障原则同源。
 * @param value 查询参数
 */
export function parseAuditResult(value?: string): AuditEventResult | undefined {
  if (!value) return undefined;
  if (!(AUDIT_RESULTS as readonly string[]).includes(value)) {
    throw new BizError(ErrorCode.BAD_REQUEST, `非法 result：${value}（允许：${AUDIT_RESULTS.join(' / ')}）`);
  }
  return value as AuditEventResult;
}

/** 事件多值过滤上限（防止把 URL 当查询语言） */
const AUDIT_EVENTS_MAX = 20;

/**
 * 解析事件过滤参数：`event=a,b,c`（逗号分隔，去空去重，上限 20）
 *
 * 多值只为支撑「按风险筛选」——风险等级不落库，由注册表把风险展开成事件集合（ADR-0032 R9）。
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
    private readonly jobs: JobCenterService,
    private readonly jobRegistry: JobRunnerRegistry,
    private readonly audit: AuditService,
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
    @Query('result') result?: string,
    @Query('tenant_id') tenantId?: string,
  ): Promise<PageResult<AuditLogRecord>> {
    // M12 W2 OBS-14：未知过滤参数 400（不静默忽略）
    assertKnownFilterParams(request.query as Record<string, unknown>);
    // 数据范围 → 允许的归属人集合：self 只允许查询本人记录（忽略传入的 user_id）；
    // org / org_below 展开为部门成员集合（与传入 user_id 取交集）；all 不约束。
    // 与详情接口共用 resolveDataScopeActors——列表看不见的记录，详情也必须拿不到（P1）。
    const actors = await resolveDataScopeActors(user, this.org);
    // 租户维度（与 dataScope 正交，P1）：普通请求强制使用服务端解析出的当前租户；
    // 客户端 tenant_id 只能与之相同（收窄），指定其他租户直接 4001 —— 不能靠 query 越过租户边界。
    const tenantScope = resolveTenantScope(user);
    const tenantFilter = resolveTenantFilter(tenantScope, parseTenantId(tenantId));
    // 排序解析放在数据范围解析之后、查询之前：非法 sort（未知字段 / 非法方向 / 超上限）直接 400（BUG-15）
    const parsedSort = parseSortQuery<AuditLogRecord>(sort, AUDIT_SORT_FIELDS);
    const selfOnly = actors.scope === 'self';

    return this.auth.auditLogs({
      page: Number(page),
      pageSize: Number(pageSize),
      userId: selfOnly ? user.id : userId,
      userIds: selfOnly ? undefined : (actors.allowedUserIds ?? undefined),
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
      // PRD-015 FR-15-05/06：结果与租户过滤。租户过滤值由服务端解析（见上）——
      // 归属人集合与租户条件是两个维度，同时施加（交集），任一维度都不放大可见范围
      result: parseAuditResult(result),
      tenantId: tenantFilter,
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
    @Query('result') result?: string,
    @Query('tenant_id') tenantId?: string,
  ): Promise<JobView> {
    assertKnownFilterParams(request.query as Record<string, unknown>);
    // 与列表同源的授权范围计算（导出不得比列表看到更多）
    const actors = await resolveDataScopeActors(user, this.org);
    // 租户维度（P1）：与列表同一份服务端强制值，导出同样不能靠 tenant_id 越过租户边界
    const tenantScope = resolveTenantScope(user);
    const tenantFilter = resolveTenantFilter(tenantScope, parseTenantId(tenantId));
    const parsedSort = parseSortQuery<AuditLogRecord>(sort, AUDIT_SORT_FIELDS);
    const selfOnly = actors.scope === 'self';

    // M10 E-01：完整查询条件固化进 params（JSON 可序列化）——跨实例重跑按它重建同一查询。
    // dataScope 已在此刻收敛为具体 ID（self → userId；org/org_below → userIds），重跑沿用派发时范围；
    // tenantFilter 同理固化：普通请求是服务端当前租户，维护入口为 null（全局）或调用方指定的租户。
    const params: Record<string, unknown> = {
      userId: selfOnly ? user.id : userId,
      userIds: selfOnly ? undefined : (actors.allowedUserIds ?? undefined),
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
      tenantId: tenantFilter ?? null,
      maxRows: EXPORT_MAX_ROWS,
    };

    const job = await this.jobs.create({
      type: 'audit.export',
      title: '审计日志导出',
      ownerId: operator,
      params,
      runner: (report) => this.executeExport(rebuildExportQuery(params), report),
    });
    // PRD-015 FR-15-11：导出行为本身也是敏感操作（谁、按什么条件、导了什么），必须留痕
    this.audit.recordEvent('audit.export', {
      userId: operator,
      targetId: job.id,
      targetLabel: describeExportFilters({
        userId: params.userId as string | undefined,
        module: params.module as string | undefined,
        action: params.action as string | undefined,
        event: Array.isArray(params.events) ? (params.events as string[]).join(',') : undefined,
        result: params.result as string | undefined,
        tenantId: params.tenantId as string | undefined,
        from: params.from as string | undefined,
        to: params.to as string | undefined,
      }),
      after: { filters: params, maxRows: EXPORT_MAX_ROWS },
      ip: clientIp(request),
    });
    return job;
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
   * 事件注册表（PRD-015 FR-15-01，ADR-0032 R1）
   *
   * 只读下发事件定义（名称/说明/分类/风险/指引/摘要模板/字段中文名）与 `version` 指纹：
   * 前端据此渲染运营视图并做缓存失效，**不在前端维护第二份翻译表**。
   * 路由必须声明在 `@Get(':id')` 之前，否则 `events` 会被当作 id 命中详情分支。
   */
  @Permissions(PERM.AUDIT_READ)
  @Get('events')
  listEvents(): { version: string; items: readonly AuditEventDefinition[] } {
    return { version: auditRegistryVersion(), items: listAuditEvents() };
  }

  /**
   * 跨租户维护入口：平台级审计检索（PRD-008 FR-02「跨租户维护面」）
   *
   * 只有本族端点允许跨租户读取：整类/本组标 `@IgnoreTenant()`，框架守卫额外要求
   * `system:tenant:ignore`（缺失即 3002）并把豁免行为写入审计（`tenant_bypass`）。
   * 请求上下文出现 `ignoreTenant` 后，`resolveTenantScope` 才返回 `crossTenant`——
   * 普通 `/audit-logs` 端点即使调用方 dataScope=all 也不会走到这里，租户边界不因 dataScope 放宽。
   *
   * 维护入口只是**放开租户维度**：归属人（dataScope）维度照旧收敛（与普通列表同一份实现，
   * 本方法直接复用 list）。路由声明必须在 `:id` 之前，否则 `platform` 会被当作记录 ID。
   */
  @IgnoreTenant()
  @Permissions(PERM.AUDIT_READ)
  @Get('platform')
  platformList(
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
    return this.list(user, request, page, pageSize, userId, module, action, targetType, targetId, from, to, sort, traceId, requestId, familyId, category, event, result, tenantId);
  }

  /**
   * 跨租户维护入口：平台级审计导出（与维护列表同一份租户豁免语义）
   *
   * 路由顺序：`platform/export` 必须声明在 `platform/:id` 之前，否则 `export` 会被当作记录 ID。
   */
  @IgnoreTenant()
  @Permissions(PERM.AUDIT_EXPORT)
  @Get('platform/export')
  platformExport(
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
    return this.export(user, operator, request, userId, module, action, targetType, targetId, from, to, sort, traceId, requestId, familyId, category, event, result, tenantId);
  }

  /**
   * 跨租户维护入口：平台级审计详情
   *
   * 维护入口只放开租户维度：归属人范围仍按 dataScope 收敛（与普通详情共用实现）。
   * 普通详情在租户维度不匹配时同样 404（不泄露存在性）；维护入口才可读到任意租户记录。
   */
  @IgnoreTenant()
  @Permissions(PERM.AUDIT_READ)
  @Get('platform/:id')
  platformDetail(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<AuditLogRecord> {
    return this.detail(user, id);
  }

  /**
   * 审计详情（字段级变更前后值）
   *
   * 授权范围与列表同源（`resolveDataScopeActors`）：self → 仅本人；org / org_below → 记录操作人
   * 必须属于可见部门成员集合；all → 不限（仅归属人维度）。范围外与不存在返回**同一个 404**
   * （不泄露存在性，fail-closed）。
   *
   * 修复记录（P1）：此前只判 `scope.selfOnly`，org / org_below 档可凭 ID 直读列表里看不到的记录——
   * 详情接口的服务端权限边界必须与列表一致，不能只靠前端过滤。
   *
   * 租户维度（P1 分维）：详情还要校验记录 `tenantId` 属于当前租户。dataScope=all 只解除归属人
   * 限制，不解除租户边界——否则共享库里「本租户 all 用户」可凭 ID 直读他租户记录。
   * 跨租户读取只允许经 `platform/:id` 维护入口（@IgnoreTenant + system:tenant:ignore）。
   */
  @Permissions(PERM.AUDIT_READ)
  @Get(':id')
  async detail(@CurrentUser() user: RequestUser, @Param('id') id: string): Promise<AuditLogRecord> {
    const actors = await resolveDataScopeActors(user, this.org);
    const tenantScope = resolveTenantScope(user);
    const record = await this.admin.findAuditLogById(id);
    // 注意：系统任务记录 userId 为 null，按人收敛的档位一律不可见（isActorWithinDataScope 内判定）；
    // 两个维度都必须通过：归属人集合（dataScope）+ 记录租户归属（tenant scope）
    if (!record || !isActorWithinDataScope(actors, record.userId) || !isTenantWithinScope(tenantScope, record.tenantId)) {
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
  events?: string[];
  /** PRD-015：结果与租户过滤（导出与列表同源） */
  result?: AuditEventResult;
  tenantId?: string;
}

/**
 * 把导出筛选条件描述成一句中文（审计摘要用）
 *
 * 只列「有值」的条件：导出「全部记录」本身是需要被看见的高风险事实。
 * @param filters 筛选键
 */
export function describeExportFilters(filters: Record<string, string | undefined>): string {
  const labels: Array<[string, string]> = [
    ['userId', '操作人'],
    ['tenantId', '租户'],
    ['module', '模块'],
    ['action', '动作'],
    ['event', '事件'],
    ['result', '结果'],
  ];
  const parts = labels.filter(([key]) => Boolean(filters[key])).map(([key, label]) => `${label} ${filters[key]}`);
  if (filters.from || filters.to) parts.push(`时间 ${filters.from ?? '…'} ~ ${filters.to ?? '…'}`);
  return parts.length > 0 ? parts.join('，') : '全部记录（无筛选条件）';
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
    events: Array.isArray(params.events) ? (params.events.filter((value) => typeof value === 'string') as string[]) : undefined,
    result: strOrNull(params.result) as AuditEventResult | undefined,
    tenantId: strOrNull(params.tenantId),
  };
}

/**
 * 组装审计 CSV
 *
 * 列序约定（PRD-015 FR-15-19）：M12 的 15 列**位置与顺序不变**，M15 的 8 个业务列
 * **追加在末尾**。追加而非插入，是为了不破坏既有下游脚本与 mock 的逐字节同构断言
 * （M12 曾因列序/范围固定断言漏同步导致 CI 红）。
 *
 * 业务列是「运营可读」的导出面：事件名/摘要/对象/操作人/原因/结果/来源/风险，
 * 其中事件名与风险由注册表现算（不落库），历史行取不到时留空而不是编造。
 *
 * 单元格编码统一走 `@fw/auth` 的 `escapeCsvCell`：引号转义之外还中和 `= + - @` 等
 * 公式注入前缀——摘要 / 对象名称 / 操作原因都可能来自用户可控文本（导入数据、历史数据、
 * 其他写入路径同样会带进来），只在 UI 校验不足以防住「导出文件被 Excel 打开即执行」。
 *
 * 带 UTF-8 BOM：Excel 直接打开中文列头不乱码（这是导出功能最常见的落地问题）。
 */
export function buildAuditCsv(rows: AuditLogRecord[]): string {
  const header = [
    'id', 'createdAt', 'userId', 'module', 'action', 'targetType', 'targetId', 'ip', 'traceId',
    'requestId', 'familyId', 'category', 'event', 'before', 'after',
    // ---- M15 追加（位置固定，勿插入到上方） ----
    'eventName', 'summary', 'targetLabel', 'actorLabel', 'reason', 'result', 'auditSource', 'risk',
  ];
  const lines = [header.join(',')];
  for (const row of rows) {
    const definition = findAuditEvent(row.event ?? '');
    lines.push(
      [
        escapeCsvCell(row.id),
        escapeCsvCell(row.createdAt instanceof Date ? row.createdAt.toISOString() : row.createdAt),
        escapeCsvCell(row.userId),
        escapeCsvCell(row.module),
        escapeCsvCell(row.action),
        escapeCsvCell(row.targetType),
        escapeCsvCell(row.targetId),
        escapeCsvCell(row.ip),
        escapeCsvCell(row.traceId),
        escapeCsvCell(row.requestId),
        escapeCsvCell(row.familyId),
        escapeCsvCell(row.category),
        escapeCsvCell(row.event),
        escapeCsvCell(row.beforeValue),
        escapeCsvCell(row.afterValue),
        // 注册表可解释的列（未登记事件 → 空，不猜）
        escapeCsvCell(definition?.name ?? null),
        escapeCsvCell(row.summary),
        escapeCsvCell(row.targetLabel),
        escapeCsvCell(row.actorLabel),
        escapeCsvCell(row.reason),
        escapeCsvCell(row.result),
        escapeCsvCell(row.auditSource),
        escapeCsvCell(definition?.risk ?? null),
      ].join(','),
    );
  }
  return `\uFEFF${lines.join('\r\n')}\r\n`;
}
