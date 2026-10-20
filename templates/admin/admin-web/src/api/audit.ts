/*
 * @file 审计日志 API（C-06 契约 / API 规格 §3.7）
 * @description 按人 / 模块 / 动作 / 对象 / 时间区间分页查询；详情含变更前后值（脱敏）。
 *   模板按「登录 + RBAC + 管理端点 + 示例 CRUD + 附件上传」范围裁剪，不含任务中心，
 *   故不提供异步导出（exportAuditLogs）——需要时参照 apps/admin-web 同文件补回，
 *   并同步模板服务端 audit 控制器与 audit:export 权限点。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo 三方一致性门禁：移除 exportAuditLogs（GET /audit-logs/export
 *   在模板服务端未注册，且任务中心不在模板范围内——留着就是生成项目里的 404 死代码）
 * @module __APP_NAME__-web/api
 */

import { request } from '@/utils/request';
import type { AuditLogRecord, AuditQuery, PageResult } from './types';

/** 审计日志分页查询 */
export function fetchAuditLogs(query: AuditQuery = {}): Promise<PageResult<AuditLogRecord>> {
  return request.get<PageResult<AuditLogRecord>>('/audit-logs', { params: query });
}

/** 审计详情（字段级 diff） */
export function fetchAuditLog(id: string): Promise<AuditLogRecord> {
  return request.get<AuditLogRecord>(`/audit-logs/${id}`);
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
