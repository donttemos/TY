/*
 * @file SaaS 运营端点（M13，PRD-013 FR-13-15，api-spec §3.21）
 * @description /api/v1/saas/* 平台运营视角（类级 @IgnoreTenant()，与 system:tenant:ignore 组成
 *   跨租户维护路径，沿 /tenants 管理面先例）：
 *   GET  /saas/plans                              需 ops:saas:read  —— 套餐列表
 *   GET  /saas/plans/:id/versions                 需 ops:saas:read  —— 版本与配额默认项
 *   POST /saas/plans                              需 ops:saas:write —— 创建套餐（code 唯一 → 409/1003）
 *   POST /saas/plans/:id/versions                 需 ops:saas:write —— 发布新版本（版本单调递增 +1，发布后不可变）
 *   POST /saas/tenant-subscriptions               需 ops:saas:write —— 创建订阅（一租户一生效）
 *   POST /saas/tenant-subscriptions/:id/cancel    需 ops:saas:write —— 取消订阅
 *   GET  /saas/tenant-subscriptions               需 ops:saas:read  —— 订阅分页列表（租户/套餐/状态/到期范围过滤）
 *   GET  /saas/tenants/:id/subscriptions/history  需 ops:saas:read —— 租户订阅历史（含 cancelled/expired）
 *   GET  /saas/tenants/:id/usage/trend            需 ops:saas:read  —— 用量趋势（hours 白名单，小时/天桶聚合填零）
 *   GET  /saas/tenants/:id/usage/events           需 ops:saas:read  —— 用量事件明细分页（窗口 ≤30 天，内存分页）
 *   GET  /saas/usage/overview                     需 ops:saas:read  —— 平台总览（配额风险 TOP20 + 7 天到期 + 五态计数 + 最近迁移）
 *   GET  /saas/tenants/:id/subscription           需 ops:saas:read  —— 当前生效订阅
 *   GET  /saas/tenants/:id/quotas                 需 ops:saas:read  —— 生效配额（覆盖 ?? 默认）
 *   GET  /saas/tenants/:id/usage                  需 ops:saas:read  —— 窗口用量（rollup 重算）
 *   POST /saas/tenants/:id/lifecycle              需 ops:saas:write —— 生命周期迁移（非法 4030）
 *   GET  /saas/tenants/:id/lifecycle/status  需 ops:saas:read  —— 当前状态 + 合法动作集（ADR-0031 迁移表派生）
 *   GET  /saas/tenants/:id/lifecycle/logs    需 ops:saas:read  —— 迁移历史
 *   全部操作经 M12 审计契约（AuditService.record，userId/ip 随请求上下文）；写操作补 after 快照。
 *   类级 @LifecycleExempt()：frozen/terminated 租户的运营面（含迁移出口 resume）必须可用（ADR-0031 §3.2）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 M14/PRD-014 FR-14-03：statusOf 助手转正为 GET lifecycle/status 端点（状态 + allowedActions），
 *   支撑生命周期页真实状态驱动（PRD-014 §1.2 U-14-3）。
 * @modified 2026-10-20 M14/PRD-014 B2（FR-14-05~07）：套餐创建 / 版本发布端点转正 PlanService 领域能力；
 *   订阅分页列表与租户订阅历史（store 端口新增 listSubscriptions/listSubscriptionsByTenant）；
 *   发布后不可变语义沿用 M13 领域实现；全部写操作补 saas.plan.* 审计事件。
 * @modified 2026-10-20 M14/PRD-014 B4（FR-14-12/13/14）：用量趋势（hours 白名单 + UTC 桶聚合填零）、
 *   事件明细分页（内存分页，OQ-14-3 定案查询时聚合零迁移）、平台总览 overview
 *   （风险 TOP20 + 7 天到期订阅 + 五态计数 + 最近迁移）；端口扩展 listWindows/countTenantsByStatus/listRecentLifecycleLogs。
 * @modified 2026-10-21 donttemo P1（PRD-015 FR-15-10 收口）：审计事件 target_label 停止落裸 ID——
 *   套餐发布/订阅开通/订阅取消/配额超限/生命周期迁移（含非法）六处改为写入时解析
 *   租户名/套餐名快照；解析不到时写「名称快照缺失（ID: …）」显式声明，不让 ID 冒充名称。
 * @modified 2026-10-21 donttemo P1 加固（FR-15-10 评审）：名称解析改为**尽力而为**——
 *   tenantLabelOf/planLabelOf 对名称查询异常统一 try/catch 降级为缺失标记，
 *   cancelSubscription 的 findSubscriptionById 回查同口径防护。名称快照是审计辅助
 *   信息，不得反向决定业务成败：调用点在业务写入成功之后，查询失败若透出就会把
 *   已提交的操作变成失败响应（客户端重试撞订阅冲突/重复操作）。故障注入测试锁定。
 * @modified 2026-10-20 M14 收口：全部入参校验（含 M13 遗留三处）统一 throw BizError——
 *   信封直返会被全局响应拦截器包双层（{code:0,data:{code:1001}}），前端按顶层 code 误判成功；
 *   禁新增信封直返校验（冒烟 S15.0 断言锁定）。
 * @modified 2026-10-21 donttemo P1：订阅创建补边界校验——tenantId/planCode 空白 → 1001、
 *   租户不存在 → 1002（真机验收复现过 `{"tenantId":""}` 建出 `tenant_id=''` 的订阅行）；
 *   通过校验后以 trim 归一值调用领域服务并写入审计快照。
 * @modified 2026-10-21 donttemo P1 业务一致性：订阅创建补**生命周期状态**校验——terminated 租户
 *   拒绝开通（4030，details 带 from/action），避免「生效订阅 + 终止租户」的矛盾数据（终态无迁出）；
 *   frozen/grace/pending 仍放行（frozen 的「续订再恢复」是 ADR-0031 §2.2 合法前置），
 *   开通本身不做隐式迁移。存在性与状态共用同一次 findTenantStatus 读取。
 * @modified 2026-10-21 donttemo P2 追溯补齐：terminated 拒绝分支补审计
 *   `saas.subscription.create_rejected`（result=denied，target=租户 + 名称快照，after 含请求套餐/
 *   租户状态/拒绝码），记录后原样抛出；与 `saas.lifecycle.invalid` 同一留痕口径。
 * @module example-api/saas
 */

import { Body, Controller, Get, Inject, Param, Post, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { BizError, ErrorCode } from '@fw/core';
import { AuditService, CurrentUser, IgnoreTenant, PERM, Permissions, snapshotMissingLabel } from '@fw/auth';
import type { RequestUser } from '@fw/auth';
import { clientIp } from '../auth/auth.controller.js';
import { LifecycleExempt } from './lifecycle.decorator.js';
import { SAAS_STORE } from './saas.tokens.js';
import type { LifecycleAction, LifecycleStatus, PlanView, SaasStore, SubscriptionView } from '@fw/saas';
import { PlanService, QuotaService, SubscriptionService, TenantLifecycleService, UsageService, TRANSITIONS, windowStartFor } from '@fw/saas';

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

/** 套餐创建请求体（M14 FR-14-05） */
interface CreatePlanBody {
  code?: string;
  name?: string;
  description?: string | null;
}

/** 版本发布请求体（M14 FR-14-06；limitValue 接受 number/string，控制器归一为 BigInt） */
interface PublishVersionBody {
  remark?: string | null;
  quotas?: Array<{ quotaKey?: string; limitValue?: number | string; execution?: 'soft' | 'hard' | 'observe' | null }>;
}

/** 订阅状态过滤白名单（M14 FR-14-07） */
const SUBSCRIPTION_STATUSES: readonly SubscriptionView['status'][] = ['active', 'expired', 'cancelled'];

/** 用量趋势时间范围白名单（小时；M14 FR-14-12）；事件明细范围白名单（小时） */
const TREND_HOURS = [24, 48, 72, 168, 720] as const;

/** 合法迁移动作白名单（控制器层先校验，领域层迁移表再校验一次，双保险） */
const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ['activate', 'expire', 'freeze', 'resume', 'terminate', 'dispose'];

/**
 * 生命周期动作 → 事件码（PRD-015 FR-15-09）
 *
 * @audit-event-map 本表是审计事件的**间接写入点**（`recordEvent(LIFECYCLE_EVENTS[action])`）：
 * 门禁（scripts/check-audit-events.mjs）只对带本标记的文件把「事件码字面量」计为写入点，
 * 其余文件一律只认 `recordEvent('…')` / `event: '…'`。标记是显式声明，不靠猜。
 *
 * 此前用模板字符串 `saas.lifecycle.${action}` 拼码：值虽然稳定，但事件不可枚举，
 * 注册表与门禁都覆盖不到。显式映射让「新增动作」必须同时登记事件定义。
 */
const LIFECYCLE_EVENTS: Record<LifecycleAction, string> = {
  activate: 'saas.lifecycle.activate',
  expire: 'saas.lifecycle.expire',
  freeze: 'saas.lifecycle.freeze',
  resume: 'saas.lifecycle.resume',
  terminate: 'saas.lifecycle.terminate',
  dispose: 'saas.lifecycle.dispose',
};

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

  /**
   * 租户名称快照（PRD-015 FR-15-10 / AC-15-02 + P1 加固）：**尽力而为，绝不反向决定业务成败**。
   *
   * 审计 `target_label` 必须是可读名称而不是 ID：运营在对象列看到 `t1` 会误以为是
   * 租户名。三类结果全部收敛为返回值，不向外抛：
   * - 查询成功且有名称 → 真实名称快照；
   * - 对象不存在 / 名称为空白（脏引用）→ 「名称快照缺失（ID: …）」显式声明；
   * - 查询抛异常（库抖动 / 连接池耗尽 / 驱动缺陷）→ 同样降级为缺失标记。
   *
   * 为什么不放异常出去：名称解析发生在业务写入成功**之后**（套餐已发布、订阅已取消、
   * 迁移已生效）。查询失败一旦透出，就会把已提交的业务变成失败响应——客户端重试会撞
   * `active_marker` 唯一冲突（订阅开通）、重复取消、重复迁移。名称快照是审计辅助信息，
   * 没有资格覆盖业务结果，与 AuditService 对审计写入失败的降级同向（旁路不伤主链路）。
   */
  private async tenantLabelOf(tenantId: string): Promise<string> {
    try {
      const name = await this.store.findTenantName(tenantId);
      return name?.trim() ? name : snapshotMissingLabel(tenantId);
    } catch {
      return snapshotMissingLabel(tenantId);
    }
  }

  /**
   * 套餐名称快照（同上，异常同口径降级）。与订阅列表 `enrichSubscriptions` 同口径：软删套餐
   * 不暴露名称，落缺失标记——两侧看到的事实必须一致，不能列表说「没有」、审计却编一个名字。
   */
  private async planLabelOf(planId: string): Promise<string> {
    try {
      const plan = await this.store.findPlanById(planId);
      return plan?.name?.trim() ? plan.name : snapshotMissingLabel(planId);
    } catch {
      return snapshotMissingLabel(planId);
    }
  }

  /** 订阅对象标签：`租户名 · 套餐名`（任一侧缺失只标记该侧，不牵连另一侧；两侧解析均已防抛） */
  private async subscriptionLabelOf(subscription: { tenantId: string; planId: string }): Promise<string> {
    const [tenant, plan] = await Promise.all([this.tenantLabelOf(subscription.tenantId), this.planLabelOf(subscription.planId)]);
    return `${tenant} · ${plan}`;
  }

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

  /** 创建套餐（M14 FR-14-05；code 唯一 → 409/1003 由领域服务抛出） */
  @Post('plans')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async createPlan(@Body() body: CreatePlanBody, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    if (!body?.code?.trim() || !body?.name?.trim()) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'code 与 name 必填');
    }
    const plan = await this.plans.createPlan({ code: body.code.trim(), name: body.name.trim(), description: body.description ?? null });
    this.audit.recordEvent('saas.plan.create', {
      userId: operator?.id,
      targetId: plan.id,
      targetLabel: plan.name,
      actorLabel: operator?.username,
      after: { code: plan.code, name: plan.name, description: plan.description ?? null },
      ip: request ? clientIp(request) : undefined,
    });
    return plan;
  }

  /**
   * 发布套餐新版本（M14 FR-14-06）：版本号 = 当前最大版本 + 1，发布后不可变（ADR-0029，领域服务保证）。
   * limitValue 接受 number/string，控制器归一为非负 BigInt；返回值含配额默认项（limitValue 转 string）。
   */
  @Post('plans/:id/versions')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async publishPlanVersion(@Param('id') planId: string, @Body() body: PublishVersionBody, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    const quotas = body?.quotas;
    if (!Array.isArray(quotas) || quotas.length === 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'quotas 必填且至少一条');
    }
    const normalized: Array<{ quotaKey: string; limitValue: bigint; execution: 'soft' | 'hard' | 'observe' | null }> = [];
    for (const q of quotas) {
      if (!q?.quotaKey?.trim()) {
        throw new BizError(ErrorCode.BAD_REQUEST, 'quotas[].quotaKey 必填');
      }
      const n = typeof q.limitValue === 'string' ? Number(q.limitValue) : q.limitValue;
      if (!Number.isFinite(n) || (n as number) < 0) {
        throw new BizError(ErrorCode.BAD_REQUEST, `quotas[].limitValue 非法：${String(q?.limitValue)}`);
      }
      normalized.push({ quotaKey: q.quotaKey.trim(), limitValue: BigInt(Math.floor(n as number)), execution: q.execution ?? null });
    }
    const version = await this.plans.publishVersion(planId, { remark: body?.remark ?? null, quotas: normalized });
    const withQuotas = await this.plans.listPlanQuotas(version.id);
    this.audit.recordEvent('saas.plan.publish', {
      userId: operator?.id,
      targetId: planId,
      targetLabel: await this.planLabelOf(planId),
      actorLabel: operator?.username,
      after: { planId, version: version.version, remark: body?.remark ?? null, quotaCount: normalized.length },
      ip: request ? clientIp(request) : undefined,
    });
    return { ...version, quotas: withQuotas.map((q) => ({ quotaKey: q.quotaKey, limitValue: q.limitValue.toString(), execution: q.execution })) };
  }

  // ---- 订阅（写 + 读） ----

  /**
   * 创建订阅（M13/M14）
   *
   * 入参在**接口边界**校验，不依赖前端表单（真机验收复现过：`{"tenantId":""}` 返回 code 0
   * 并建出 `tenant_id=''` 的订阅行）：
   * ① tenantId 非空白 → 否则 1001（空串/纯空白一律拒绝，不做「兜底成 0 号租户」的猜测）；
   * ② planCode 非空白 → 否则 1001（避免把空 code 当业务参数传进领域层）；
   * ③ 租户存在 → 否则 1002（`findTenantStatus` 的 null 即「租户不存在」，见 LifecycleStore 端口约定）；
   * ④ 租户**未终止** → terminated 一律 4030（见下）。
   *
   * 为什么要在边界查存在性：订阅行会绑定 active_marker（一租户一生效的唯一键）并生成配额快照，
   * 挂到不存在的租户上会产出无法归属的权益数据，且该租户日后建档时会「莫名已有生效订阅」。
   * 领域层另有一道非空不变量（SubscriptionService.create），两层各自独立。
   *
   * 为什么还要拒绝 terminated（ADR-0031 §2.2）：terminated 是终态，迁移表只有 `dispose`、没有任何
   * 迁出路径。类级 `@LifecycleExempt()` 又让运营面绕过 4031，于是「存在性检查 + 无状态检查」会留下
   * **生效订阅挂在终止租户上**的数据——租户仍终止、业务请求继续 4031，且没有合法迁移能把它恢复。
   * 拒绝码复用 4030（与「terminated 不可被启用」同一口径），details 保留 `from/action` 便于定位。
   * frozen / grace / pending 均放行：ADR-0031 §2.2 的 `frozen -resume-> active` 前置条件正是
   * 「存在有效订阅（新订阅）」，即「先续订、再恢复」是合法流程；但开通本身**不做隐式迁移**
   * （状态写权唯一归属 TenantLifecycleService），运营随后显式 `resume` 即可，两种状态因此区别处理。
   * 拒绝同时落 `saas.subscription.create_rejected`（result=denied，含租户名快照/请求套餐/
   * 租户状态/拒绝文案）——与 `saas.lifecycle.invalid` 同口径：先记录、再原样抛出，
   * 让运营能在审计后台直接回答「这个租户为什么开不了套餐」，不必回查应用日志。
   */
  @Post('tenant-subscriptions')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async createSubscription(@Body() body: CreateSubscriptionBody, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    const tenantId = typeof body?.tenantId === 'string' ? body.tenantId.trim() : '';
    if (!tenantId) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'tenantId 必填（不能为空或纯空白）');
    }
    const planCode = typeof body?.planCode === 'string' ? body.planCode.trim() : '';
    if (!planCode) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'planCode 必填（不能为空或纯空白）');
    }
    const tenantStatus = await this.store.findTenantStatus(tenantId);
    if (tenantStatus === null) {
      throw new BizError(ErrorCode.NOT_FOUND, `租户不存在：${tenantId}`);
    }
    // 终止态是终态：开通订阅会被误读成「复活」意图，而 terminated 在迁移表里没有迁出（ADR-0031 §2.2）
    if (tenantStatus === 'terminated') {
      const denied = new BizError(
        ErrorCode.LIFECYCLE_TRANSITION_INVALID,
        `租户已终止（terminated 为终态，无迁移出口），不能开通订阅：${tenantId}`,
        [
          { field: 'from', message: 'terminated' },
          { field: 'action', message: 'activate' },
        ],
      );
      // 拒绝必须留痕（与 saas.lifecycle.invalid 同一口径：记录后原样抛出）。
      // 否则运营在审计后台查不到「为什么这个租户开不了套餐」，只能让开发者翻应用日志。
      // 审计是旁路：名称解析失败降级为缺失标记，绝不改变错误语义、不产生订阅/配额/状态写入。
      this.audit.recordEvent('saas.subscription.create_rejected', {
        userId: operator?.id,
        targetType: 'tenant',
        targetId: tenantId,
        targetLabel: await this.tenantLabelOf(tenantId),
        actorLabel: operator?.username,
        result: 'denied',
        reason: denied.message,
        after: { planCode, tenantStatus, code: denied.code },
        ip: request ? clientIp(request) : undefined,
      });
      throw denied;
    }
    const sub = await this.subscriptions.create({
      tenantId,
      planCode,
      planVersion: body.planVersion,
      expireAt: body.expireAt ? new Date(body.expireAt) : null,
    });
    this.audit.recordEvent('saas.subscription.create', {
      userId: operator?.id,
      targetId: sub.id,
      targetLabel: await this.subscriptionLabelOf(sub),
      actorLabel: operator?.username,
      after: { tenantId, planCode, planVersion: body.planVersion ?? null, expireAt: body.expireAt ?? null },
      ip: request ? clientIp(request) : undefined,
    });
    return sub;
  }

  @Post('tenant-subscriptions/:id/cancel')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async cancelSubscription(@Param('id') id: string, @Body() body: { reason?: string }, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    await this.subscriptions.cancel(id, { reason: body?.reason ?? null });
    // 标签取「取消后」的订阅行：cancel 已保证行存在（否则先抛 1002），此处仅防御并发硬删。
    // 回查同属业务成功后的旁路查询：抛异常（库抖动等）按缺失标记降级——
    // 订阅已取消是事实，不能因为一次名称查询失败就把取消变成失败响应（客户端重试会重复取消）。
    let cancelled: SubscriptionView | null = null;
    try {
      cancelled = await this.store.findSubscriptionById(id);
    } catch {
      cancelled = null;
    }
    this.audit.recordEvent('saas.subscription.cancel', {
      userId: operator?.id,
      targetId: id,
      targetLabel: cancelled ? await this.subscriptionLabelOf(cancelled) : snapshotMissingLabel(id),
      actorLabel: operator?.username,
      reason: body?.reason ?? null,
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

  /**
   * 订阅分页列表（M14 FR-14-07）：过滤参数显式白名单（tenantId/planCode/status/expireFrom/expireTo），
   * 排序固定 effectiveAt desc + id asc（主键 tie-breaker）；planCode 过滤先解析为 planId。
   */
  @Get('tenant-subscriptions')
  @Permissions(PERM.OPS_SAAS_READ)
  async listSubscriptions(
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('tenantId') tenantId?: string,
    @Query('planCode') planCode?: string,
    @Query('status') status?: string,
    @Query('expireFrom') expireFrom?: string,
    @Query('expireTo') expireTo?: string,
  ): Promise<unknown> {
    const p = Number(page);
    const ps = Number(pageSize);
    if (!Number.isInteger(p) || p < 1 || !Number.isInteger(ps) || ps < 1 || ps > 200) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'page/pageSize 非法（正整数，pageSize ≤ 200）');
    }
    if (status !== undefined && status !== '' && !SUBSCRIPTION_STATUSES.includes(status as SubscriptionView['status'])) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'status 仅支持 active/expired/cancelled');
    }
    const filter: { tenantId?: string; planId?: string; status?: SubscriptionView['status']; expireFrom?: Date; expireTo?: Date } = {};
    if (tenantId) filter.tenantId = tenantId;
    if (status) filter.status = status as SubscriptionView['status'];
    if (planCode) {
      const plan = await this.store.findPlanByCode(planCode);
      if (!plan) return { items: [], total: 0, page: p, pageSize: ps };
      filter.planId = plan.id;
    }
    for (const [key, raw] of [['expireFrom', expireFrom], ['expireTo', expireTo]] as const) {
      if (raw) {
        const d = new Date(raw);
        if (Number.isNaN(d.getTime())) {
          throw new BizError(ErrorCode.BAD_REQUEST, `${key} 非法日期（ISO 8601）`);
        }
        filter[key] = d;
      }
    }
    const { items, total } = await this.store.listSubscriptions(filter, { page: p, pageSize: ps });
    return { items: await this.enrichSubscriptions(items), total, page: p, pageSize: ps };
  }

  /** 租户订阅历史（M14 FR-14-07）：完整列表（含 cancelled/expired），排序同列表 */
  @Get('tenants/:id/subscriptions/history')
  @Permissions(PERM.OPS_SAAS_READ)
  async subscriptionHistory(@Param('id') tenantId: string): Promise<unknown> {
    return this.enrichSubscriptions(await this.store.listSubscriptionsByTenant(tenantId));
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
      throw new BizError(ErrorCode.BAD_REQUEST, 'quotaKey 必填');
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
      throw new BizError(ErrorCode.BAD_REQUEST, 'quotaKey / quantity(正数) / idempotencyKey 必填');
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
        this.audit.recordEvent('saas.quota.exceeded', {
          userId: operator?.id,
          targetId: tenantId,
          targetLabel: await this.tenantLabelOf(tenantId),
          actorLabel: operator?.username,
          result: 'denied',
          after: { quotaKey: body.quotaKey, idempotencyKey: body.idempotencyKey },
          ip: request ? clientIp(request) : undefined,
        });
      }
      throw e;
    }
  }

  // ---- 用量趋势 / 明细 / 平台看板（M14/PRD-014 FR-14-12/14，OQ-14-3 定案：查询时聚合零迁移） ----

  @Get('tenants/:id/usage/trend')
  @Permissions(PERM.OPS_SAAS_READ)
  async usageTrend(@Param('id') tenantId: string, @Query('quotaKey') quotaKey: string, @Query('hours') hours = '24'): Promise<unknown> {
    if (!quotaKey) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'quotaKey 必填');
    }
    const h = Number(hours);
    if (!TREND_HOURS.includes(h as never)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `hours 仅支持 ${TREND_HOURS.join('/')}`);
    }
    const bucketType: 'hour' | 'day' = h <= 48 ? 'hour' : 'day';
    const to = new Date();
    const from = new Date(to.getTime() - h * 3_600_000);
    const events = await this.store.listEvents(tenantId, quotaKey, from, to);
    const bucketStart = (t: Date): Date =>
      bucketType === 'hour'
        ? new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate(), t.getUTCHours()))
        : new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()));
    const buckets = new Map<string, { quantity: bigint; eventCount: number }>();
    for (const e of events) {
      const key = bucketStart(e.occurredAt).toISOString();
      const b = buckets.get(key) ?? { quantity: 0n, eventCount: 0 };
      b.quantity += e.quantity;
      b.eventCount += 1;
      buckets.set(key, b);
    }
    // 填零序列：前端直接画图，无需再补空桶
    const points: Array<{ bucketStart: string; quantity: string; eventCount: number }> = [];
    const step = bucketType === 'hour' ? 3_600_000 : 86_400_000;
    for (let cursor = bucketStart(from); cursor <= bucketStart(to); cursor = new Date(cursor.getTime() + step)) {
      const b = buckets.get(cursor.toISOString());
      points.push({ bucketStart: cursor.toISOString(), quantity: (b?.quantity ?? 0n).toString(), eventCount: b?.eventCount ?? 0 });
    }
    return { quotaKey, from: from.toISOString(), to: to.toISOString(), bucketType, points };
  }

  /** 用量事件明细分页（内存分页：窗口 ≤30 天且运营面低频，事件量级可控；大量化后立 ADR 升级存储分页） */
  @Get('tenants/:id/usage/events')
  @Permissions(PERM.OPS_SAAS_READ)
  async usageEventList(
    @Param('id') tenantId: string,
    @Query('quotaKey') quotaKey: string,
    @Query('hours') hours = '168',
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '50',
  ): Promise<unknown> {
    if (!quotaKey) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'quotaKey 必填');
    }
    const h = Number(hours);
    if (![24, 72, 168, 720].includes(h)) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'hours 仅支持 24/72/168/720');
    }
    const p = Number(page);
    const ps = Number(pageSize);
    if (!Number.isInteger(p) || p < 1 || !Number.isInteger(ps) || ps < 1 || ps > 200) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'page/pageSize 非法（正整数，pageSize ≤ 200）');
    }
    const to = new Date();
    const from = new Date(to.getTime() - h * 3_600_000);
    const events = await this.store.listEvents(tenantId, quotaKey, from, to);
    const sorted = events.sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime());
    return {
      items: sorted.slice((p - 1) * ps, p * ps).map((e) => ({ quotaKey, quantity: e.quantity.toString(), occurredAt: e.occurredAt.toISOString() })),
      total: sorted.length,
      page: p,
      pageSize: ps,
    };
  }

  /** 平台运营总览（FR-14-14 数据源）：配额风险（≥80% TOP20）+ 7 天内到期订阅 + 五态计数 + 最近迁移 */
  @Get('usage/overview')
  @Permissions(PERM.OPS_SAAS_READ)
  async opsOverview(): Promise<unknown> {
    const now = new Date();
    const dayStart = windowStartFor('day', now);
    const monthStart = windowStartFor('month', now);
    const [dayRows, monthRows, expiring, pendingC, activeC, graceC, frozenC, terminatedC, recent] = await Promise.all([
      this.store.listWindows('day', dayStart),
      this.store.listWindows('month', monthStart),
      this.store.listActiveSubscriptionsExpiredAt(new Date(now.getTime() + 7 * 86_400_000)),
      this.store.countTenantsByStatus('pending'),
      this.store.countTenantsByStatus('active'),
      this.store.countTenantsByStatus('grace'),
      this.store.countTenantsByStatus('frozen'),
      this.store.countTenantsByStatus('terminated'),
      this.store.listRecentLifecycleLogs(10),
    ]);
    const quotaRisks = [
      ...dayRows.map((r) => ({ r, windowType: 'day' as const, ws: dayStart })),
      ...monthRows.map((r) => ({ r, windowType: 'month' as const, ws: monthStart })),
    ]
      .filter(({ r }) => r.limitValue > 0n)
      .map(({ r, windowType, ws }) => ({
        tenantId: r.tenantId,
        quotaKey: r.quotaKey,
        windowType,
        windowStart: ws.toISOString(),
        used: r.used.toString(),
        limitValue: r.limitValue.toString(),
        ratio: Number((r.used * 10000n) / r.limitValue) / 100,
      }))
      .filter((r) => r.ratio >= 80)
      .sort((a, b) => b.ratio - a.ratio)
      .slice(0, 20);
    return {
      quotaRisks,
      expiringSubscriptions: expiring
        .filter((s) => s.expireAt && s.expireAt >= now)
        .map((s) => ({ subscriptionId: s.id, tenantId: s.tenantId, expireAt: s.expireAt ? s.expireAt.toISOString() : null })),
      tenantCounts: { pending: pendingC, active: activeC, grace: graceC, frozen: frozenC, terminated: terminatedC },
      recentTransitions: recent,
    };
  }

  // ---- 生命周期（写 + 读） ----

  @Post('tenants/:id/lifecycle')
  @Permissions(PERM.OPS_SAAS_WRITE)
  async transition(@Param('id') tenantId: string, @Body() body: LifecycleBody, @CurrentUser() operator?: RequestUser, @Req() request?: Request): Promise<unknown> {
    if (!body?.action || !LIFECYCLE_ACTIONS.includes(body.action)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `非法动作：${body?.action ?? '(empty)'}`);
    }
    let result: Awaited<ReturnType<TenantLifecycleService['transition']>>;
    try {
      result = await this.lifecycle.transition(tenantId, body.action, {
        actorType: 'user',
        actorId: operator?.id ?? null,
        reason: body?.reason ?? null,
        ip: request ? clientIp(request) : null,
      });
    } catch (error) {
      // 非法迁移（4030）是运营最常见的拒绝态：必须与「迁移成功」在同一事件模型里可区分
      if (error instanceof BizError && error.code === ErrorCode.LIFECYCLE_TRANSITION_INVALID) {
        this.audit.recordEvent('saas.lifecycle.invalid', {
          userId: operator?.id,
          targetId: tenantId,
          targetLabel: await this.tenantLabelOf(tenantId),
          actorLabel: operator?.username,
          result: 'denied',
          reason: error.message,
          after: { action: body.action, code: error.code },
          ip: request ? clientIp(request) : undefined,
        });
      }
      throw error;
    }
    this.audit.recordEvent(LIFECYCLE_EVENTS[body.action], {
      userId: operator?.id,
      targetId: tenantId,
      targetLabel: await this.tenantLabelOf(tenantId),
      actorLabel: operator?.username,
      reason: body?.reason ?? null,
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

  /**
   * 租户当前生命周期状态 + 合法动作集（M14/PRD-014 FR-14-03）：
   * status 直读 store.findTenantStatus（ tenants.status 真实状态，非日志推导）；
   * allowedActions 由 @fw/saas TRANSITIONS 迁移表派生（单一权威，前端不硬编码）。
   * 租户不存在/无状态 → { status: null, allowedActions: [] }（沿 /subscription 无则 data=null 先例）。
   */
  @Get('tenants/:id/lifecycle/status')
  @Permissions(PERM.OPS_SAAS_READ)
  async lifecycleStatus(@Param('id') tenantId: string): Promise<{ status: LifecycleStatus | null; allowedActions: LifecycleAction[] }> {
    const status = await this.store.findTenantStatus(tenantId);
    return { status, allowedActions: status ? (Object.keys(TRANSITIONS[status]) as LifecycleAction[]) : [] };
  }

  /** 窗口起点换算暴露（测试与文档核对用，纯函数转发） */
  windowStartOf(windowType: 'day' | 'month' | 'total', at: Date): Date {
    return windowStartFor(windowType, at);
  }

  /** 订阅行补套餐/版本展示字段（planCode/planName/planVersion；缺失的脏数据行回 null 不阻断列表） */
  private async enrichSubscriptions(items: SubscriptionView[]): Promise<Array<SubscriptionView & { planCode: string | null; planName: string | null; planVersion: number | null }>> {
    return Promise.all(
      items.map(async (s) => {
        const [plan, version] = await Promise.all([this.store.findPlanById(s.planId), this.store.findVersionById(s.planVersionId)]);
        return { ...s, planCode: plan?.code ?? null, planName: plan?.name ?? null, planVersion: version?.version ?? null };
      }),
    );
  }
}
