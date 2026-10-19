/*
 * @file 订阅服务
 * @description 订阅创建/变更/取消（ADR-0029 §2.1）：绑定套餐版本 + 一租户至多一个生效订阅
 *   （active_marker 方案）；创建即按 plan_quotas 快照生成 tenant_quotas（source=plan_snapshot）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { BizError, ErrorCode } from '@fw/core';
import { Injectable } from '@nestjs/common';
import type { PlanStore, QuotaStore, SubscriptionStore } from './store.port.js';
import type { SubscriptionView } from './types.js';

@Injectable()
export class SubscriptionService {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly quotas: QuotaStore,
  ) {}

  /**
   * 为租户创建订阅：
   * - 套餐与版本必须存在且已发布（published）；
   * - 已有生效订阅 → 1003 CONFLICT；
   * - 创建成功后按版本快照回写 tenant_quotas（source=plan_snapshot）。
   */
  async create(input: {
    tenantId: string;
    planCode: string;
    planVersion?: number;
    effectiveAt?: Date;
    expireAt?: Date | null;
  }): Promise<SubscriptionView> {
    const plan = await this.plans.findPlanByCode(input.planCode);
    if (!plan) {
      throw new BizError(ErrorCode.NOT_FOUND, `套餐不存在：${input.planCode}`);
    }
    const active = await this.subscriptions.findActiveSubscription(input.tenantId);
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
      throw new BizError(ErrorCode.NOT_FOUND, `套餐 ${input.planCode} 无可用发布版本${input.planVersion ? `：v${input.planVersion}` : ''}`);
    }

    const sub = await this.subscriptions.createSubscription({
      tenantId: input.tenantId,
      planId: plan.id,
      planVersionId: target.id,
      effectiveAt: input.effectiveAt ?? new Date(),
      expireAt: input.expireAt ?? null,
      activeMarker: input.tenantId,
    });

    // 版本快照：plan_quotas → tenant_quotas（source=plan_snapshot）
    const quotas = await this.plans.listPlanQuotas(target.id);
    for (const q of quotas) {
      await this.quotas.upsertTenantQuota({
        tenantId: input.tenantId,
        quotaKey: q.quotaKey,
        overrideValue: q.limitValue,
        execution: q.execution,
        source: 'plan_snapshot',
      });
    }
    return sub;
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
