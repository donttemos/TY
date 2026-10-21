/*
 * @file 订阅服务
 * @description 订阅创建/变更/取消（ADR-0029 §2.1）：绑定套餐版本 + 一租户至多一个生效订阅
 *   （active_marker 方案）；创建即按 plan_quotas 快照生成 tenant_quotas（source=plan_snapshot）。
 *   订阅生效与权益快照是同一不变量：两者经端口单事务方法一次写入（ADR-0029 §2.5）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 donttemo 订阅创建与配额快照收敛为单事务（先读快照、后一次原子写；中途失败全回滚）
 * @modified 2026-10-21 donttemo P1：create 增加入参不变量——tenantId / planCode 空白直接 1001，
 *   不再写出 `tenant_id=''` 的订阅行（该行还会占住 active_marker 唯一键，污染后续归属判定）；
 *   tenantId 归一化（trim）后再用于查询、快照与 activeMarker，避免首尾空白分裂同一租户
 * @module @fw/saas
 */
import { BizError, ErrorCode } from '@fw/core';
import { Injectable } from '@nestjs/common';
import type { PlanStore, SubscriptionStore } from './store.port.js';
import type { SubscriptionView, TenantQuotaOverride } from './types.js';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
  ) {}

  /**
   * 为租户创建订阅：
   * - tenantId / planCode 必须非空白（不变量，见下）；
   * - 套餐与版本必须存在且已发布（published）；
   * - 已有生效订阅 → 1003 CONFLICT；
   * - 成功后按版本快照生成 tenant_quotas（source=plan_snapshot）。
   *
   * 入参不变量（P1）：`tenantId` 为空白时直接 1001，**不进任何查询/写入**。
   * 空串曾被原样写进 `subscriptions.tenant_id`，同时占住 `active_marker`（一租户一生效的
   * 唯一键）：这类行既无法回答「属于哪个租户」，又会让后续归属判定出现「看似已有生效订阅」
   * 的错误结论。控制器边界已拒绝，这里再拦一次——服务可能被任务/脚本直接调用，
   * 领域层不能假设调用方一定走过表单或 HTTP 校验。
   *
   * 原子性（ADR-0029 §2.5）：快照**先在内存里算好**（版本发布后 plan_quotas 不可变，
   * 故读快照不引入竞态），再与新订阅行交给端口的单事务方法一次写入——
   * 快照任一条写失败即整体回滚，不存在「订阅已生效、快照不完整」的时间窗。
   */
  async create(input: {
    tenantId: string;
    planCode: string;
    planVersion?: number;
    effectiveAt?: Date;
    expireAt?: Date | null;
  }): Promise<SubscriptionView> {
    // 归一化后再落库：`' t1 '` 与 `'t1'` 必须是同一个租户，不能因首尾空白分裂归属
    const tenantId = typeof input.tenantId === 'string' ? input.tenantId.trim() : '';
    if (!tenantId) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'tenantId 必填（不能为空或纯空白）');
    }
    const planCode = typeof input.planCode === 'string' ? input.planCode.trim() : '';
    if (!planCode) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'planCode 必填（不能为空或纯空白）');
    }

    const plan = await this.plans.findPlanByCode(planCode);
    if (!plan) {
      throw new BizError(ErrorCode.NOT_FOUND, `套餐不存在：${planCode}`);
    }
    const active = await this.subscriptions.findActiveSubscription(tenantId);
    if (active) {
      throw new BizError(ErrorCode.CONFLICT, `租户已有生效订阅（${active.id}），请先关闭再创建`);
    }

    // 选版本：指定版本必须存在且 published；未指定取最新 published（不存在则 1002）
    const versions = await this.plans.listVersions(plan.id);
    const published = versions.filter((v) => v.status === 'published');
    const target = input.planVersion
      ? published.find((v) => v.version === input.planVersion)
      : published.sort((a, b) => b.version - a.version)[0];
    if (!target) {
      throw new BizError(ErrorCode.NOT_FOUND, `套餐 ${planCode} 无可用发布版本${input.planVersion ? `：v${input.planVersion}` : ''}`);
    }

    // 版本快照：plan_quotas → tenant_quotas（source=plan_snapshot）。读在写之前，
    // 读取失败时库上零副作用；写入由驱动保证同事务全成/全败。
    const planQuotas = await this.plans.listPlanQuotas(target.id);
    const snapshot: TenantQuotaOverride[] = planQuotas.map((q) => ({
      tenantId,
      quotaKey: q.quotaKey,
      overrideValue: q.limitValue,
      execution: q.execution,
      source: 'plan_snapshot',
    }));

    return this.subscriptions.createSubscriptionWithSnapshot(
      {
        tenantId,
        planId: plan.id,
        planVersionId: target.id,
        effectiveAt: input.effectiveAt ?? new Date(),
        expireAt: input.expireAt ?? null,
        activeMarker: tenantId,
      },
      snapshot,
    );
  }

  /** 取消订阅（运营动作）：置 cancelled + activeMarker=NULL；幂等（已关闭直接返回） */
  async cancel(subscriptionId: string, input: { reason?: string | null; at?: Date }): Promise<void> {
    const sub = await this.subscriptions.findSubscriptionById(subscriptionId);
    if (!sub) {
      throw new BizError(ErrorCode.NOT_FOUND, `订阅不存在：${subscriptionId}`);
    }
    if (sub.status !== 'active') return;
    await this.subscriptions.closeSubscription(subscriptionId, {
      status: 'cancelled',
      reason: input.reason ?? null,
      closedAt: input.at ?? new Date(),
    });
  }

  /** 查询租户当前生效订阅 */
  async findActive(tenantId: string): Promise<SubscriptionView | null> {
    return this.subscriptions.findActiveSubscription(tenantId);
  }
}
