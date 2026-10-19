/*
 * @file SaaS 运营 API（M13 / api-spec §3.21）
 * @description 平台运营面九端点封装：套餐 / 订阅 / 生效配额 / 用量 / 生命周期。
 *   与后端 @fw/saas 领域服务逐一对齐；4029/4030/4031 三码语义见 @/utils/biz-error。
 * @author donttemo
 * @created 2026-10-19
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { LifecycleLog, PlanView, PlanVersionView, SubscriptionView } from './types';

/** 套餐列表 */
export function fetchPlans(): Promise<PlanView[]> {
  return request.get<PlanView[]>('/saas/plans');
}

/** 套餐版本列表（含各版本配额默认项） */
export function fetchPlanVersions(planId: string): Promise<Array<PlanVersionView & { quotas: Array<{ quotaKey: string; limitValue: string; execution: string | null }> }>> {
  return request.get(`/saas/plans/${planId}/versions`);
}

/** 创建订阅（一租户一生效；已有生效订阅 → 409/1003） */
export function createSubscription(body: { tenantId: string; planCode: string; planVersion?: number; expireAt?: string }): Promise<SubscriptionView> {
  return request.post('/saas/tenant-subscriptions', body);
}

/** 取消订阅（幂等：已关闭直接成功） */
export function cancelSubscription(id: string, reason?: string): Promise<{ id: string; cancelled: boolean }> {
  return request.post(`/saas/tenant-subscriptions/${id}/cancel`, { reason });
}

/** 租户当前生效订阅 */
export function fetchTenantSubscription(tenantId: string): Promise<SubscriptionView | null> {
  return request.get(`/saas/tenants/${tenantId}/subscription`);
}

/** 生效配额列表（覆盖 ?? 套餐默认；limitValue 后端转 string） */
export function fetchTenantQuotas(tenantId: string): Promise<Array<{ tenantId: string; quotaKey: string; limitValue: string; execution: string; source: string }>> {
  return request.get(`/saas/tenants/${tenantId}/quotas`);
}

/** 窗口用量（rollup 重算后返回） */
export function fetchTenantUsage(tenantId: string, quotaKey: string, at?: string): Promise<{
  totalQuantity: string;
  eventCount: number;
  limitValue: string;
  execution: string;
  windowStart: string;
  windowEnd: string;
}> {
  return request.get(`/saas/tenants/${tenantId}/usage`, { params: { quotaKey, at } });
}

/** 用量事件上报（运营补录面；hard 超限 → 4029，重复幂等键 → deduped） */
export function recordUsageEvent(
  tenantId: string,
  body: { quotaKey: string; quantity: number; idempotencyKey: string; occurredAt?: string; source?: string },
): Promise<{ result: 'ok' | 'deduped'; used?: string; limit?: string }> {
  return request.post(`/saas/tenants/${tenantId}/usage/events`, body);
}

/** 生命周期迁移（非法 → 409/4030；重复执行幂等 alreadyApplied） */
export function transitionLifecycle(tenantId: string, action: string, reason?: string): Promise<{ from: string; to: string; alreadyApplied: boolean }> {
  return request.post(`/saas/tenants/${tenantId}/lifecycle`, { action, reason });
}

/** 迁移历史（只增不改不删） */
export function fetchLifecycleLogs(tenantId: string): Promise<LifecycleLog[]> {
  return request.get(`/saas/tenants/${tenantId}/lifecycle/logs`);
}
