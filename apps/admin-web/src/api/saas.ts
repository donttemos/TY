/*
 * @file SaaS 运营 API（M13/M14 / api-spec §3.21）
 * @description 平台运营面十端点封装：套餐 / 订阅 / 生效配额 / 用量 / 生命周期。
 *   与后端 @fw/saas 领域服务逐一对齐；4029/4030/4031 三码语义见 @/utils/biz-error。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 M14/PRD-014 FR-14-03：新增 fetchTenantLifecycleStatus（状态 + allowedActions）。
 * @modified 2026-10-20 M14/PRD-014 B2/B3（FR-14-05~07/10）：新增 createPlan / publishPlanVersion /
 *   fetchSubscriptions / fetchTenantSubscriptionHistory（api-spec §3.21 十四端点对齐）。
 * @modified 2026-10-20 M14/PRD-014 B4（FR-14-12/14）：新增 fetchUsageTrend / fetchUsageEventList /
 *   fetchOpsOverview（趋势/明细/平台总览；api-spec §3.21 十七端点对齐）。
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

/** 订阅行（列表/历史返回：补 planCode/planName/planVersion 展示字段） */
export type SubscriptionRow = SubscriptionView & { planCode: string | null; planName: string | null; planVersion: number | null };

/** 订阅分页结果（后端无 hasMore 字段，与通用 PageResult 略异） */
export interface SubscriptionPage {
  items: SubscriptionRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** 订阅分页列表（M14 FR-14-07；过滤参数全部可选，status ∈ active/expired/cancelled） */
export function fetchSubscriptions(query: { page?: number; pageSize?: number; tenantId?: string; planCode?: string; status?: string; expireFrom?: string; expireTo?: string }): Promise<SubscriptionPage> {
  return request.get('/saas/tenant-subscriptions', { params: query });
}

/** 租户订阅历史（完整列表，含 cancelled/expired） */
export function fetchTenantSubscriptionHistory(tenantId: string): Promise<SubscriptionRow[]> {
  return request.get(`/saas/tenants/${tenantId}/subscriptions/history`);
}

/** 创建套餐（M14 FR-14-05；code 唯一 → 409/1003） */
export function createPlan(body: { code: string; name: string; description?: string | null }): Promise<PlanView> {
  return request.post('/saas/plans', body);
}

/** 发布套餐新版本（M14 FR-14-06；版本 = 当前最大 +1，发布后不可变；limitValue 接受 number/string） */
export function publishPlanVersion(planId: string, body: { remark?: string | null; quotas: Array<{ quotaKey: string; limitValue: number | string; execution?: 'soft' | 'hard' | 'observe' | null }> }): Promise<PlanVersionView & { quotas: Array<{ quotaKey: string; limitValue: string; execution: string | null }> }> {
  return request.post(`/saas/plans/${planId}/versions`, body);
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

/** 用量趋势点（bucketStart UTC 桶起点，quantity 后端转 string，零桶已填充） */
export interface UsageTrendPoint {
  bucketStart: string;
  quantity: string;
  eventCount: number;
}

/** 用量趋势（M14 FR-14-12；hours ∈ 24/48/72/168/720） */
export function fetchUsageTrend(tenantId: string, quotaKey: string, hours: number): Promise<{ quotaKey: string; from: string; to: string; bucketType: 'hour' | 'day'; points: UsageTrendPoint[] }> {
  return request.get(`/saas/tenants/${tenantId}/usage/trend`, { params: { quotaKey, hours } });
}

/** 用量事件明细分页（M14 FR-14-12；hours ∈ 24/72/168/720，occurredAt desc） */
export function fetchUsageEventList(
  tenantId: string,
  query: { quotaKey: string; hours?: number; page?: number; pageSize?: number },
): Promise<{ items: Array<{ quotaKey: string; quantity: string; occurredAt: string }>; total: number; page: number; pageSize: number }> {
  return request.get(`/saas/tenants/${tenantId}/usage/events`, { params: query });
}

/** 配额风险行（overview） */
export interface QuotaRisk {
  tenantId: string;
  quotaKey: string;
  windowType: 'day' | 'month';
  windowStart: string;
  used: string;
  limitValue: string;
  ratio: number;
}

/** 平台运营总览（M14 FR-14-14 数据源） */
export interface OpsOverview {
  quotaRisks: QuotaRisk[];
  expiringSubscriptions: Array<{ subscriptionId: string; tenantId: string; expireAt: string | null }>;
  tenantCounts: { pending: number; active: number; grace: number; frozen: number; terminated: number };
  recentTransitions: LifecycleLog[];
}

export function fetchOpsOverview(): Promise<OpsOverview> {
  return request.get('/saas/usage/overview');
}

/** 生命周期迁移（非法 → 409/4030；重复执行幂等 alreadyApplied） */
export function transitionLifecycle(tenantId: string, action: string, reason?: string): Promise<{ from: string; to: string; alreadyApplied: boolean }> {
  return request.post(`/saas/tenants/${tenantId}/lifecycle`, { action, reason });
}

/** 租户当前生命周期状态 + 合法动作集（M14 FR-14-03；allowedActions 由后端迁移表派生，前端不硬编码） */
export function fetchTenantLifecycleStatus(tenantId: string): Promise<{ status: string | null; allowedActions: string[] }> {
  return request.get(`/saas/tenants/${tenantId}/lifecycle/status`);
}

/** 迁移历史（只增不改不删） */
export function fetchLifecycleLogs(tenantId: string): Promise<LifecycleLog[]> {
  return request.get(`/saas/tenants/${tenantId}/lifecycle/logs`);
}
