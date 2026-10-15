/*
 * @file 租户管理 API（N-01 / api-spec §3.9）
 * @description 租户列表、开租户、改套餐与状态、停用（不物理删）、shared ↔ dedicated 隔离级别迁移。
 *   迁移是长任务：接口立即返回 jobId（JobView），进度走 `GET /jobs/:id/progress`。
 *   权限：tenant:read / create / update / delete / manage —— 服务端另要求 `system:tenant:ignore`
 *   （跨租户维护豁免，见 @fw/auth 的 @IgnoreTenant）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { JobView, PageResult, TenantMigrateInput, TenantQuery, TenantUpsertInput, TenantView } from './types';

/** 租户分页列表（api-spec §3.9 的五个端点之一；详情没有独立端点，列表项即视图） */
export function fetchTenants(query: TenantQuery = {}): Promise<PageResult<TenantView>> {
  return request.get<PageResult<TenantView>>('/tenants', { params: query });
}

/** 开租户 */
export function createTenant(data: TenantUpsertInput): Promise<TenantView> {
  return request.post<TenantView>('/tenants', data);
}

/** 更新（名称 / 套餐 / 状态 / 到期时间） */
export function updateTenant(id: string, data: TenantUpsertInput): Promise<TenantView> {
  return request.put<TenantView>(`/tenants/${id}`, data);
}

/** 停用（服务端置 status=0，不物理删） */
export function disableTenant(id: string): Promise<TenantView> {
  return request.delete<TenantView>(`/tenants/${id}`);
}

/** 隔离级别迁移（长任务，返回任务视图供进度轮询） */
export function migrateTenant(id: string, data: TenantMigrateInput): Promise<JobView> {
  return request.post<JobView>(`/tenants/${id}/migrate`, data);
}
