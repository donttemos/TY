/*
 * @file 租户管理端点（N-01，api-spec §3.9）
 * @description /api/v1/tenants 五个端点（此前实现为零，前端亦无页面）：
 *   GET    /tenants            需 tenant:read   —— 分页列表（关键字 / 隔离级别 / 状态 / 排序）
 *   POST   /tenants            需 tenant:create —— 开租户，指定 isolation（dedicated 必须带 dbUrl）
 *   PUT    /tenants/:id        需 tenant:update —— 改名称 / 套餐 / 状态 / 到期时间
 *   DELETE /tenants/:id        需 tenant:delete —— 停用（不物理删：租户解析仍需按 code 命中并给 4001）
 *   POST   /tenants/:id/migrate 需 tenant:manage —— shared ↔ dedicated 隔离级别迁移（长任务，返回 jobId）
 *
 *   **跨租户维护面**：平台管理员视角的端点必须豁免租户解析（否则 TENANT_ENABLED=true 时自身 4001）。
 *   故整类标 `@IgnoreTenant()` —— 框架要求调用方同时持有 `system:tenant:ignore`（守卫会额外校验并写豁免审计），
 *   与各端点自身的 tenant:* 权限码是「与」关系。这是 PRD-008 定稿的跨租户维护路径，不做特例绕过。
 *
 *   迁移是控制面切换（isolation 元数据 + 连接串落库 + 缓存失效），数据的物理搬迁由运维按手册执行；
 *   该语义在接口与前端文案中明确标注，避免「点一下就搬完数据」的错误预期。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/tenant
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type PageResult } from '@fw/db';
import { AuditService, CurrentUser, IgnoreTenant, PERM, Permissions } from '@fw/auth';
import { TenantService } from '@fw/tenant';
import type { TenantIsolation } from '@fw/tenant';
import { JobCenterService } from '../jobs/job-center.service.js';
import { JobRunnerRegistry } from '../jobs/job-runner.registry.js';
import type { JobReporter } from '../jobs/job-center.port.js';
import { TENANT_ADMIN_STORE, LEGACY_TENANT_ID } from './tenant-admin.store.js';
import type { TenantAdminStore, TenantView } from './tenant-admin.store.js';
import { encryptDbUrl, decryptDbUrl } from './db-url-crypto.js';
import { clientIp } from '../auth/auth.controller.js';
import type { Request } from 'express';

/**
 * 租户可排序字段白名单（api-spec §1.5）
 *
 * 键为 HTTP 参数名（snake_case），值为实体字段名。白名单外字段一律 400 ——
 * 既避免把任意 query 参数拼进 orderBy，也避免通过排序推断未暴露字段。
 */
const TENANT_SORT_FIELDS = {
  id: 'id',
  code: 'code',
  name: 'name',
  isolation: 'isolation',
  status: 'status',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  expire_at: 'expireAt',
} as const;

/** 迁移请求体 */
interface TenantMigrateBody {
  /** 目标隔离级别 */
  isolation?: TenantIsolation;
  /** dedicated 目标必须提供：独立库连接串（明文，落库前加密） */
  dbUrl?: string;
}

/** 迁移任务的分步权重（进度上报用，和 100 对齐） */
const MIGRATE_STEPS = [10, 30, 55, 80, 100] as const;

/** 迁移执行上下文（执行体入参；dbUrl 在 params 中以密文形态持久化，与租户表同语义） */
interface MigrateContext {
  id: string;
  code: string;
  fromIsolation: string;
  target: TenantIsolation;
  /** 明文连接串（dedicated 时非空；由 params.dbUrlEnc 解密还原） */
  dbUrl: string | null;
  affected: number;
  operator: string;
  ip: string;
}

/**
 * 租户管理控制器：/api/v1/tenants
 */
@IgnoreTenant()
@Controller('/api/v1/tenants')
export class TenantAdminController {
  constructor(
    @Inject(TENANT_ADMIN_STORE) private readonly store: TenantAdminStore,
    private readonly tenants: TenantService,
    private readonly jobs: JobCenterService,
    private readonly audit: AuditService,
    private readonly jobRegistry: JobRunnerRegistry,
  ) {
    // M10 E-01：登记迁移任务的执行体工厂——db/bullmq 驱动下跨实例重跑按 params 重建上下文
    // （连接串以密文进 params，与 tenants 表存储语义一致；memory 驱动下派发仍走闭包）
    this.jobRegistry.register('tenant.migrate', (params) => (report) => this.executeMigrate(rebuildMigrateContext(params), report));
  }

  /** 租户分页列表 */
  @Permissions(PERM.TENANT_READ)
  @Get()
  async list(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('keyword') keyword?: string,
    @Query('isolation') isolation?: string,
    @Query('status') status?: string,
    @Query('sort') sort?: string,
  ): Promise<PageResult<TenantView>> {
    const parsedSort = parseSortQuery<TenantView>(sort, TENANT_SORT_FIELDS);
    if (isolation !== undefined && isolation !== '' && isolation !== 'shared' && isolation !== 'dedicated') {
      throw new BizError(ErrorCode.BAD_REQUEST, 'isolation 仅支持 shared / dedicated');
    }
    if (status !== undefined && status !== '' && status !== '0' && status !== '1') {
      throw new BizError(ErrorCode.BAD_REQUEST, 'status 仅支持 0（停用）/ 1（启用）');
    }
    return this.store.pageTenants({
      page: Math.max(1, Number(page) || 1),
      pageSize: Math.max(1, Number(pageSize) || 20),
      keyword: keyword || undefined,
      isolation: isolation || undefined,
      status: status === undefined || status === '' ? undefined : Number(status),
      ...(parsedSort ? { sort: parsedSort } : {}),
    });
  }

  /** 开租户 */
  @Permissions(PERM.TENANT_CREATE)
  @Post()
  async create(
    @Body() body: { code?: string; name?: string; isolation?: TenantIsolation; plan?: string; expireAt?: string; dbUrl?: string },
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<TenantView> {
    if (!body?.code) throw new BizError(ErrorCode.BAD_REQUEST, 'code 必填');
    if (!body?.name) throw new BizError(ErrorCode.BAD_REQUEST, 'name 必填');
    if (!body?.isolation) throw new BizError(ErrorCode.BAD_REQUEST, 'isolation 必填');
    const created = await this.store.createTenant({
      code: body.code,
      name: body.name,
      isolation: body.isolation,
      plan: body.plan ?? null,
      expireAt: body.expireAt ?? null,
      dbUrl: body.dbUrl ?? null,
    });
    // 新建即让解析缓存感知（同编码此前可能是「不存在」的负缓存）
    this.tenants.invalidate();
    this.audit.record({
      userId: operator,
      module: 'tenant',
      action: 'create',
      targetType: 'tenant',
      targetId: created.id,
      after: { code: created.code, name: created.name, isolation: created.isolation, plan: created.plan },
      ip: clientIp(request),
    });
    return created;
  }

  /** 改名称 / 套餐 / 状态 / 到期时间（隔离级别不走这里，走 migrate） */
  @Permissions(PERM.TENANT_UPDATE)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: { name?: string; plan?: string | null; status?: number; expireAt?: string | null },
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<TenantView> {
    const before = await this.store.findTenantViewById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '租户不存在');
    if (body?.status !== undefined && body.status !== 0 && body.status !== 1) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'status 只能为 0（停用）或 1（启用）');
    }
    if (before.id === LEGACY_TENANT_ID && body?.status === 0) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '存量单租户（legacy）不可停用');
    }
    const updated = await this.store.updateTenant(id, {
      ...(body?.name !== undefined ? { name: body.name } : {}),
      ...(body?.plan !== undefined ? { plan: body.plan } : {}),
      ...(body?.status !== undefined ? { status: body.status as 0 | 1 } : {}),
      ...(body?.expireAt !== undefined ? { expireAt: body.expireAt } : {}),
    });
    this.tenants.invalidate();
    this.audit.record({
      userId: operator,
      module: 'tenant',
      action: 'update',
      targetType: 'tenant',
      targetId: id,
      before: { name: before.name, plan: before.plan, status: before.status, expireAt: before.expireAt },
      after: { name: updated.name, plan: updated.plan, status: updated.status, expireAt: updated.expireAt },
      ip: clientIp(request),
    });
    return updated;
  }

  /**
   * 停用租户（DELETE = 停用，不物理删）
   * 不写 deletedAt：租户解析必须仍能按 code 命中该行并给出 4001「租户已停用」，
   * 若软删会让共用 DTO 的解析路径变成「不存在」，前端提示与排障方向都会跑偏。
   */
  @Permissions(PERM.TENANT_DELETE)
  @Delete(':id')
  async disable(
    @Param('id') id: string,
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<TenantView> {
    const before = await this.store.findTenantViewById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '租户不存在');
    const affected = await this.store.countTenantUsers(id);
    const disabled = await this.store.disableTenant(id);
    this.tenants.invalidate();
    this.audit.record({
      userId: operator,
      module: 'tenant',
      action: 'delete',
      targetType: 'tenant',
      targetId: id,
      before: { code: before.code, status: before.status },
      after: { status: disabled.status, affectedUsers: affected },
      ip: clientIp(request),
    });
    return disabled;
  }

  /**
   * 隔离级别迁移（shared ↔ dedicated）
   *
   * 长任务：派发到任务中心并立即返回 `jobId`，进度走 `GET /jobs/:id/progress`。
   * 迁移内容 = 控制面切换（写 isolation 与连接串密文 + 失效解析缓存 + 校验可解密）。
   * **数据搬迁不在此完成**：独立库的历史数据导入由运维按部署手册执行，接口文案已明确。
   */
  @Permissions(PERM.TENANT_MANAGE)
  @Post(':id/migrate')
  async migrate(
    @Param('id') id: string,
    @Body() body: TenantMigrateBody,
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<unknown> {
    const target = body?.isolation;
    if (target !== 'shared' && target !== 'dedicated') {
      throw new BizError(ErrorCode.BAD_REQUEST, 'isolation 仅支持 shared / dedicated');
    }
    const before = await this.store.findTenantViewById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '租户不存在');
    // legacy 同步前置拒绝：存储层的守卫在 runner 内，派发后才失败会把「请求错误」
    // 演变成「必然失败的后台任务」，违背本方法「语义问题立即 4xx」的原则
    if (before.id === LEGACY_TENANT_ID) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '存量单租户（legacy）不可迁移隔离级别：其数据分布在共享库，切换数据源会整体失联');
    }
    if (before.isolation === target) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, `租户已是 ${target} 隔离级别，无需迁移`);
    }
    if (target === 'dedicated' && !body?.dbUrl?.trim()) {
      throw new BizError(ErrorCode.BAD_REQUEST, '迁移到 dedicated 必须提供独立库连接串 dbUrl');
    }
    const dbUrl = target === 'dedicated' ? (body.dbUrl as string) : null;
    const ip = clientIp(request);

    // 派发前先做一次同步校验：ID/编码/隔离级别语义问题属于「请求错误」，应立即 4xx，
    // 不该变成一个必然失败的后台任务让前端轮询才发现。
    const affected = await this.store.countTenantUsers(id);

    // M10 E-01：执行上下文固化进 params（JSON 可序列化）——跨实例重跑按它重建。
    // 连接串以密文形态持久化（encryptDbUrl，与 tenants 表 db_url_enc 同语义），明文不落库。
    const params: Record<string, unknown> = {
      tenantId: id,
      code: before.code,
      from: before.isolation,
      to: target,
      affectedUsers: affected,
      dataCopyRequired: target === 'dedicated',
      dbUrlEnc: dbUrl ? encryptDbUrl(dbUrl) : null,
      operator,
      ip,
    };

    return this.jobs.create({
      type: 'tenant.migrate',
      title: `租户 ${before.code} 迁移至 ${target === 'dedicated' ? '独立库' : '共享库'}`,
      ownerId: operator,
      params,
      runner: (report) => this.executeMigrate(rebuildMigrateContext(params), report),
    });
  }

  /** 执行迁移（派发闭包与重跑工厂共用的执行体；逻辑与 N-02 交付版逐字一致） */
  private async executeMigrate(ctx: MigrateContext, report: JobReporter): Promise<null> {
    const { id, target, dbUrl, affected, operator, ip } = ctx;
    report(MIGRATE_STEPS[0], '校验目标隔离级别与连接串');
    if (target === 'dedicated') {
      const candidate = dbUrl ?? '';
      if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) && !candidate.startsWith('file:')) {
        throw new Error('独立库连接串格式非法（需形如 postgresql://… 或 file:…）');
      }
    }
    await yieldToEventLoop();

    report(MIGRATE_STEPS[1], '确认租户当前状态与账号规模');
    const current = await this.store.findTenantViewById(id);
    if (!current) throw new Error('租户已被移除，迁移终止');
    if (current.isolation !== ctx.fromIsolation) {
      throw new Error(`租户隔离级别已被并发修改（当前 ${current.isolation}），请刷新后重试`);
    }
    await yieldToEventLoop();

    report(MIGRATE_STEPS[2], target === 'dedicated' ? '加密并校验独立库连接串' : '清理独立库连接串');
    await yieldToEventLoop();

    report(MIGRATE_STEPS[3], '写入隔离级别与连接串（控制面切换）');
    const updated = await this.store.setTenantIsolation(id, target, dbUrl);
    this.audit.record({
      userId: operator,
      module: 'tenant',
      action: 'update',
      targetType: 'tenant',
      targetId: id,
      before: { isolation: ctx.fromIsolation },
      after: { isolation: updated.isolation, dedicatedDbConfigured: updated.dedicatedDbConfigured, affectedUsers: affected },
      ip,
    });
    await yieldToEventLoop();

    report(MIGRATE_STEPS[4], '失效租户解析缓存');
    this.tenants.invalidate();
    return null;
  }
}

/** 从持久化 params 重建迁移上下文（M10 E-01：连接串密文解密还原，失败即执行失败） */
function rebuildMigrateContext(params: Record<string, unknown>): MigrateContext {
  const target = params.to === 'dedicated' ? 'dedicated' : params.to === 'shared' ? 'shared' : undefined;
  if (!target) throw new Error('迁移任务参数损坏（目标隔离级别缺失），请重新发起迁移');
  const dbUrlEnc = typeof params.dbUrlEnc === 'string' ? params.dbUrlEnc : null;
  return {
    id: String(params.tenantId ?? ''),
    code: String(params.code ?? ''),
    fromIsolation: String(params.from ?? 'shared'),
    target,
    dbUrl: dbUrlEnc ? decryptDbUrl(dbUrlEnc) : null,
    affected: typeof params.affectedUsers === 'number' ? params.affectedUsers : 0,
    operator: String(params.operator ?? ''),
    ip: String(params.ip ?? ''),
  };
}

/** 让出事件循环：保证前端能观察到中间的进度阶段（而不是一次性跳到 100） */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 30));
}
