/*
 * @file 审计日志 API（C-06 契约 / API 规格 §3.7）
 * @description 按人 / 模块 / 动作 / 对象 / 时间区间分页查询；详情含变更前后值（脱敏）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/api
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
