/*
 * @file SaaS 运营端点（M13，PRD-013 FR-13-15，api-spec §3.21）
 * @description /api/v1/saas/* 平台运营视角（类级 @IgnoreTenant()，与 system:tenant:ignore 组成
 *   跨租户维护路径，沿 /tenants 管理面先例）：
 *   GET  /saas/plans                              需 ops:saas:read  —— 套餐列表
 *   GET  /saas/plans/:id/versions                 需 ops:saas:read  —— 版本与配额默认项
 *   POST /saas/tenant-subscriptions               需 ops:saas:write —— 创建订阅（一租户一生效）
 *   POST /saas/tenant-subscriptions/:id/cancel    需 ops:saas:write —— 取消订阅
 *   GET  /saas/tenants/:id/subscription           需 ops:saas:read  —— 当前生效订阅
 *   GET  /saas/tenants/:id/quotas                 需 ops:saas:read  —— 生效配额（覆盖 ?? 默认）
 *   GET  /saas/tenants/:id/usage                  需 ops:saas:read  —— 窗口用量（rollup 重算）
 *   POST /saas/tenants/:id/lifecycle              需 ops:saas:write —— 生命周期迁移（非法 4030）
 *   GET  /saas/tenants/:id/lifecycle/logs         需 ops:saas:read  —— 迁移历史
 *   全部操作经 M12 审计契约（AuditService.record，userId/ip 随请求上下文）；写操作补 after 快照。
 *   类级 @LifecycleExempt()：frozen/terminated 租户的运营面（含迁移出口 resume）必须可用（ADR-0031 §3.2）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { AuditService, CurrentUser, IgnoreTenant, PERM, Permissions } from '@fw/auth';
import type { RequestUser } from '@fw/auth';
import { clientIp } from '../auth/auth.controller.js';
import { LifecycleExempt } from './lifecycle.decorator.js';
import { SAAS_STORE } from './saas.tokens.js';
import type { LifecycleAction, LifecycleStatus, PlanView, SaasStore } from '@fw/saas';
import { PlanService, QuotaService, SubscriptionService, TenantLifecycleService, UsageService, windowStartFor } from '@fw/saas';

/** 生命周期迁移请求体 */
interface LifecycleBody {
  action: LifecycleAction;
  reason?: string;
}

/** 订阅创建请求体 */
interface CreateSubscriptionBody {
  tenantId: string;
  planCode: string;
  planVersion?: number;
  expireAt?: string;
}

/** 合法迁移动作白名单（控制器层先校验，领域层迁移表再校验一次，双保险） */
const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ['activate', 'expire', 'freeze', 'resume', 'terminate', 'dispose'];

@IgnoreTenant()
@LifecycleExempt()
@Controller('/api/v1/saas')
export class SaasOpsController {
  constructor(
    @Inject(SAAS_STORE) private readonly store: SaasStore,
    private readonly plans: PlanService,
    private readonly subscriptions: SubscriptionService,
    private readonly quotas: QuotaService,
    private readonly usage: UsageService,
    private readonly lifecycle: TenantLifecycleService,
    private readonly audit: AuditService,
  ) {}

  // ---- 套餐（读） ----

  @Get('plans')
  @Permissions(PERM.OPS_SAAS_READ)
  async listPlans(): Promise<PlanView[]> {
    return this.store.listPlans();
  }

  @Get('plans/:id/versions')
  @Permissions(PERM.OPS_SAAS_READ)
  async listVersions(@Param('id') planId: string): Promise<unknown> {
    const versions = await this.plans.listVersions(planId);
    const withQuotas = await Promise.all(versions.map(async (v) => ({ ...v, quotas: await this.plans.listPlanQuotas(v.id) })));
    return withQuotas;
  }

  // ---- 订阅（写 + 读） ----

  @Post('tenant-subscriptions')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async createSubscription(@Body() body: CreateSubscriptionBody, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    const sub = await this.subscriptions.create({
      tenantId: body.tenantId,
      planCode: body.planCode,
      planVersion: body.planVersion,
      expireAt: body.expireAt ? new Date(body.expireAt) : null,
    });
    this.audit.record({
      userId: operator?.id,
      module: 'saas',
      action: 'create',
      event: 'saas.subscription.create',
      category: 'admin',
      targetType: 'tenant_subscription',
      targetId: sub.id,
      after: { tenantId: body.tenantId, planCode: body.planCode, planVersion: body.planVersion ?? null, expireAt: body.expireAt ?? null },
      ip: request ? clientIp(request) : undefined,
    });
    return sub;
  }

  @Post('tenant-subscriptions/:id/cancel')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async cancelSubscription(@Param('id') id: string, @Body() body: { reason?: string }, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    await this.subscriptions.cancel(id, { reason: body?.reason ?? null });
    this.audit.record({
      userId: operator?.id,
      module: 'saas',
      action: 'update',
      event: 'saas.subscription.cancel',
      category: 'admin',
      targetType: 'tenant_subscription',
      targetId: id,
      after: { reason: body?.reason ?? null },
      ip: request ? clientIp(request) : undefined,
    });
    return { id, cancelled: true };
  }

  @Get('tenants/:id/subscription')
  @Permissions(PERM.OPS_SAAS_READ)
  async getSubscription(@Param('id') tenantId: string): Promise<unknown> {
    return this.subscriptions.findActive(tenantId);
  }

  // ---- 配额与用量（读） ----

  @Get('tenants/:id/quotas')
  @Permissions(PERM.OPS_SAAS_READ)
  async listEffectiveQuotas(@Param('id') tenantId: string): Promise<unknown> {
    // 生效配额全集 = 租户覆盖/快照行的指标键（逐键走 resolveEffective：覆盖 ?? 套餐默认）
    const overrides = await this.store.listTenantQuotaOverrides(tenantId);
    const keys = [...new Set(overrides.map((o) => o.quotaKey))];
    const effective = [];
    for (const key of keys) {
      try {
        const e = await this.quotas.resolveEffective(tenantId, key);
        effective.push({ ...e, limitValue: e.limitValue.toString() });
      } catch {
        // 字典/默认项缺失的脏数据键不阻断整表查询（运营面可见性优先）
      }
    }
    return effective;
  }

  @Get('tenants/:id/usage')
  @Permissions(PERM.OPS_SAAS_READ)
  async getUsage(@Param('id') tenantId: string, @Query('quotaKey') quotaKey: string, @Query('at') at?: string): Promise<unknown> {
    if (!quotaKey) {
      return { code: 1001 as const, message: 'quotaKey 必填', data: null, traceId: '' };
    }
    const occurredAt = at ? new Date(at) : new Date();
    const { windowType, windowStart } = await this.quotas.resolveWindowStart(tenantId, quotaKey, occurredAt);
    const effective = await this.quotas.resolveEffective(tenantId, quotaKey);
    const windowEnd =
      windowType === 'day'
        ? new Date(windowStart.getTime() + 24 * 3600 * 1000)
        : windowType === 'month'
          ? new Date(Date.UTC(occurredAt.getUTCFullYear(), occurredAt.getUTCMonth() + 1, 1))
          : new Date(8_640_000_000_000_000);
    const rollup = await this.usage.recalcRollup(tenantId, quotaKey, windowType, windowStart, windowEnd);
    return { ...rollup, totalQuantity: rollup.totalQuantity.toString(), limitValue: effective.limitValue.toString(), execution: effective.execution, windowEnd };
  }

  /**
   * 用量事件上报（运营补录/业务侧对接面，ADR-0030 §2.4 全语义）：
   * hard 超限 → 4029（事件不留痕）；重复幂等键 → deduped；soft 达限告警；observe 仅统计。
   */
  @Post('tenants/:id/usage/events')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async recordUsageEvent(
    @Param('id') tenantId: string,
    @Body() body: { quotaKey?: string; quantity?: number; idempotencyKey?: string; occurredAt?: string; source?: string },
    @CurrentUser() operator?: RequestUser,
    @Req() request?: Request,
  ): Promise<unknown> {
    if (!body?.quotaKey || !Number.isFinite(body.quantity) || (body.quantity as number) <= 0 || !body?.idempotencyKey) {
      return { code: 1001 as const, message: 'quotaKey / quantity(正数) / idempotencyKey 必填', data: null, traceId: '' };
    }
    try {
      const outcome = await this.usage.record({
        tenantId,
        quotaKey: body.quotaKey,
        quantity: BigInt(Math.floor(body.quantity as number)),
        occurredAt: body.occurredAt ? new Date(body.occurredAt) : new Date(),
        source: body.source ?? 'api',
        idempotencyKey: body.idempotencyKey,
      });
      return {
        result: outcome.result,
        ...(outcome.result === 'ok' ? { used: outcome.used.toString(), limit: outcome.limit.toString() } : {}),
      };
    } catch (e) {
      // QuotaExceededError 等 BizError 由全局过滤器转统一信封；此处仅做审计增强
      if (e instanceof Error && (e as { code?: number }).code === 4029) {
        this.audit.record({
          userId: operator?.id,
          module: 'saas',
          action: 'security',
          event: 'saas.quota.exceeded',
          category: 'admin',
          result: 'denied',
          targetType: 'tenant',
          targetId: tenantId,
          after: { quotaKey: body.quotaKey, idempotencyKey: body.idempotencyKey },
          ip: request ? clientIp(request) : undefined,
        });
      }
      throw e;
    }
  }

  // ---- 生命周期（写 + 读） ----

  @Post('tenants/:id/lifecycle')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async transition(@Param('id') tenantId: string, @Body() body: LifecycleBody, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    if (!body?.action || !LIFECYCLE_ACTIONS.includes(body.action)) {
      return { code: 1001 as const, message: `非法动作：${body?.action ?? '(empty)'}`, data: null, traceId: '' };
    }
    const result = await this.lifecycle.transition(tenantId, body.action, {
      actorType: 'user',
      actorId: operator?.id ?? null,
      reason: body?.reason ?? null,
      ip: request ? clientIp(request) : null,
    });
    this.audit.record({
      userId: operator?.id,
      module: 'saas',
      action: 'update',
      event: `saas.lifecycle.${body.action}`,
      category: 'admin',
      targetType: 'tenant',
      targetId: tenantId,
      after: { from: result.from, to: result.to, alreadyApplied: result.alreadyApplied, reason: body?.reason ?? null },
      ip: request ? clientIp(request) : undefined,
    });
    return result;
  }

  @Get('tenants/:id/lifecycle/logs')
  @Permissions(PERM.OPS_SAAS_READ)
  async lifecycleLogs(@Param('id') tenantId: string): Promise<unknown> {
    return this.lifecycle.listLogs(tenantId);
  }

  /** 租户当前生命周期状态（运营一览辅助；M13 无独立端点，随订阅视图合并） */
  async statusOf(tenantId: string): Promise<LifecycleStatus | null> {
    return this.store.findTenantStatus(tenantId);
  }

  /** 窗口起点换算暴露（测试与文档核对用，纯函数转发） */
  windowStartOf(windowType: 'day' | 'month' | 'total', at: Date): Date {
    return windowStartFor(windowType, at);
  }
}
