/*
 * @file 审计日志 API（C-06 契约 / API 规格 §3.7）
 * @description 按人 / 模块 / 动作 / 对象 / 时间区间分页查询；详情含变更前后值（脱敏）；
 *   导出为异步任务（N-02）：返回 jobId，进度与下载走 `/jobs/:id/*`。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo N-02：新增 exportAuditLogs（GET /audit-logs/export，需 audit:export）
 * @modified 2026-10-21 donttemo P2：新增平台审计三条（/audit-logs/platform*）——跨租户维护入口，
 *   服务端额外要求 `system:tenant:ignore`（@IgnoreTenant）；普通三条端点保持不变，仍受租户边界约束
 * @modified 2026-10-21 donttemo P2 补齐历史审计追溯：新增归档审计四条（普通 / 平台 × 列表 / 导出，
 *   `/audit-archives*`）与平台审计租户选项受控查询（`/audit-logs/platform/tenant-options`）。
 *   归档表无独立详情端点——列表 DTO 即完整只读快照，详情由行数据渲染，不为不可变冷数据新增读端点。
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type {
  AuditEventRegistry,
  AuditLogRecord,
  AuditQuery,
  AuditTenantOption,
  AuditTenantOptionQuery,
  JobView,
  PageResult,
} from './types';

/** 审计日志分页查询 */
export function fetchAuditLogs(query: AuditQuery = {}): Promise<PageResult<AuditLogRecord>> {
  return request.get<PageResult<AuditLogRecord>>('/audit-logs', { params: query });
}

/**
 * 审计事件注册表（PRD-015 FR-15-01）
 *
 * 事件码 → 名称/说明/风险/摘要模板的唯一来源（ADR-0032 R1）。前端不维护本地翻译表，
 * 按 `version` 缓存；未命中事件码走降级链（原始码 + 「未登记事件」）。
 */
export function fetchAuditEvents(): Promise<AuditEventRegistry> {
  return request.get<AuditEventRegistry>('/audit-logs/events');
}

/** 审计详情（字段级 diff） */
export function fetchAuditLog(id: string): Promise<AuditLogRecord> {
  return request.get<AuditLogRecord>(`/audit-logs/${id}`);
}

/**
 * 派发导出任务
 * @param query 与列表同源的筛选条件（分页参数会被服务端忽略）
 * @returns 任务视图（含 jobId 与初始进度）
 */
export function exportAuditLogs(query: AuditQuery = {}): Promise<JobView> {
  return request.get<JobView>('/audit-logs/export', { params: query });
}

/**
 * 平台审计：跨租户分页查询（维护入口，PRD-008 FR-02）
 *
 * 只有本族端点放开租户维度（服务端 `@IgnoreTenant()` + `system:tenant:ignore`，守卫写
 * `tenant_bypass` 豁免审计）；归属人（dataScope）维度照旧收敛。普通 `/audit-logs`
 * **不会**因为调用方 dataScope=all 而跨租户——两个入口的服务端边界不同，前端必须分开调用，
 * 不能用一个开关把普通端点「升级」成平台端点。
 */
export function fetchPlatformAuditLogs(query: AuditQuery = {}): Promise<PageResult<AuditLogRecord>> {
  return request.get<PageResult<AuditLogRecord>>('/audit-logs/platform', { params: query });
}

/** 平台审计详情（跨租户维护入口；记录不存在与范围外统一 404） */
export function fetchPlatformAuditLog(id: string): Promise<AuditLogRecord> {
  return request.get<AuditLogRecord>(`/audit-logs/platform/${id}`);
}

/** 平台审计导出（跨租户维护入口，需 audit:export + system:tenant:ignore） */
export function exportPlatformAuditLogs(query: AuditQuery = {}): Promise<JobView> {
  return request.get<JobView>('/audit-logs/platform/export', { params: query });
}

/**
 * 归档审计分页查询（冷数据追溯，`GET /audit-archives`）
 *
 * 归档表与在线表同构：数据范围 / 租户范围与在线列表**同源收敛**（普通请求仍强制当前租户），
 * 过滤参数与在线列表同形。归档不是越权后门，也不是「另一个更宽松的查询入口」。
 */
export function fetchArchiveAuditLogs(query: AuditQuery = {}): Promise<PageResult<AuditLogRecord>> {
  return request.get<PageResult<AuditLogRecord>>('/audit-archives', { params: query });
}

/** 归档审计异步导出（普通出口；产物与在线导出逐字节同构） */
export function exportArchiveAuditLogs(query: AuditQuery = {}): Promise<JobView> {
  return request.get<JobView>('/audit-archives/export', { params: query });
}

/** 平台归档审计：跨租户冷数据检索（维护入口，`GET /audit-archives/platform`） */
export function fetchPlatformArchiveAuditLogs(query: AuditQuery = {}): Promise<PageResult<AuditLogRecord>> {
  return request.get<PageResult<AuditLogRecord>>('/audit-archives/platform', { params: query });
}

/** 平台归档审计导出（维护入口，需 audit:export + system:tenant:ignore） */
export function exportPlatformArchiveAuditLogs(query: AuditQuery = {}): Promise<JobView> {
  return request.get<JobView>('/audit-archives/platform/export', { params: query });
}

/**
 * 平台审计租户选项（受控查询，P2 评审补口）
 *
 * 为什么不用管理面 `GET /tenants`：后者要求 `tenant:read`（专职审计角色会被迫获得租户管理面读取权），
 * 且只取第一页 100 条时租户更多就无法筛选 / 名称退化。本端点与 platform* 维护入口同一把钥匙
 * （`system:tenant:ignore` + `audit:read`），只返回 id/code/name/status。
 *
 * 两种用法：`keyword`（远程搜索）/ `ids`（列表行 → 名称批量解析，逗号分隔 ≤100）。
 */
export function fetchAuditTenantOptions(query: AuditTenantOptionQuery = {}): Promise<PageResult<AuditTenantOption>> {
  return request.get<PageResult<AuditTenantOption>>('/audit-logs/platform/tenant-options', { params: query });
}
