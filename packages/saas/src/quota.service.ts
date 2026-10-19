/*
 * @file 配额服务
 * @description 生效配额解析（ADR-0029：override ?? 套餐默认，规则唯一归属本服务）与
 *   窗口计算（ADR-0030 §2.1：窗口按 window_start 切片翻转，无需清零任务）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { BizError, ErrorCode } from '@fw/core';
import { Injectable } from '@nestjs/common';
import type { PlanStore, QuotaStore, SubscriptionStore } from './store.port.js';
import type { EffectiveQuota, QuotaWindowType } from './types.js';

/** 窗口起点（total 窗口固定 epoch，永不翻转） */
export function windowStartFor(windowType: QuotaWindowType, at: Date): Date {
  if (windowType === 'total') return new Date(0);
  if (windowType === 'day') {
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
  // month：当月 1 日 00:00 UTC
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
}

@Injectable()
export class QuotaService {
  constructor(
    private readonly plans: PlanStore,
    private readonly subscriptions: SubscriptionStore,
    private readonly quotas: QuotaStore,
  ) {}

  /**
   * 解析租户生效配额：tenant_quotas.override_value ?? 套餐默认（ADR-0029 §2.1）。
   * 快照行（source=plan_snapshot）是订阅时刻的套餐默认，语义归 plan；
   * 仅 manual 覆盖才算租户特例。无生效订阅或字典/默认项缺失 → 1002/400。
   */
  async resolveEffective(tenantId: string, quotaKey: string): Promise<EffectiveQuota> {
    const override = await this.quotas.findTenantQuotaOverride(tenantId, quotaKey);
    if (override && override.source === 'manual') {
      // execution 覆盖链：租户覆盖 execution ?? 字典默认
      const def = await this.quotas.findQuotaDefinition(quotaKey);
      return {
        tenantId,
        quotaKey,
        limitValue: override.overrideValue,
        execution: override.execution ?? def?.execution ?? 'hard',
        source: 'manual',
      };
    }

    const sub = await this.subscriptions.findActiveSubscription(tenantId);
    if (!sub) {
      throw new BizError(ErrorCode.NOT_FOUND, `租户无生效订阅：${tenantId}`);
    }
    const pq = await this.plans.findPlanQuota(sub.planVersionId, quotaKey);
    if (!pq) {
      throw new BizError(ErrorCode.NOT_FOUND, `当前套餐未包含配额项：${quotaKey}`);
    }
    const def = await this.quotas.findQuotaDefinition(quotaKey);
    if (!def) {
      throw new BizError(ErrorCode.NOT_FOUND, `配额字典未登记：${quotaKey}`);
    }
    return {
      tenantId,
      quotaKey,
      limitValue: pq.limitValue,
      execution: pq.execution ?? def.execution,
      source: 'plan',
    };
  }

  /** 解析配额的窗口起点（含字典窗口类型，无字典默认 day） */
  async resolveWindowStart(tenantId: string, quotaKey: string, at: Date): Promise<{ windowType: QuotaWindowType; windowStart: Date }> {
    const effective = await this.resolveEffective(tenantId, quotaKey);
    const def = await this.quotas.findQuotaDefinition(quotaKey);
    const windowType = def?.windowType ?? 'day';
    return { windowType, windowStart: windowStartFor(windowType, at) };
  }
}
