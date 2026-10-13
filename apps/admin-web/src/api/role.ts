/*
 * @file 角色与权限 API（C-06 契约 / API 规格 §3.4）
 * @description 角色 CRUD、全量授权、复制角色、权限点分组查询（授权页勾选数据源）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { PermissionGroup, RoleListItem, RolePermissionsResult, RoleUpsertInput } from './types';

/** 角色列表（全量，不分页） */
export function fetchRoles(): Promise<RoleListItem[]> {
  return request.get<RoleListItem[]>('/roles');
}

/** 新建角色 */
export function createRole(data: RoleUpsertInput): Promise<RoleListItem> {
  return request.post<RoleListItem>('/roles', data);
}

/** 更新角色（内置角色不可改 code） */
export function updateRole(id: string, data: RoleUpsertInput): Promise<RoleListItem> {
  return request.put<RoleListItem>(`/roles/${id}`, data);
}

/** 删除角色（内置角色拒绝） */
export function deleteRole(id: string): Promise<{ id: string }> {
  return request.delete(`/roles/${id}`);
}

/** 某角色已授权权限点 */
export function fetchRolePermissions(id: string): Promise<RolePermissionsResult> {
  return request.get<RolePermissionsResult>(`/roles/${id}/permissions`);
}

/** 全量授权（覆盖式；内置管理员角色拒绝） */
export function grantRolePermissions(id: string, permissionIds: string[]): Promise<{ roleId: string; count: number }> {
  return request.put(`/roles/${id}/permissions`, { permissionIds });
}

/** 复制角色（含权限） */
export function copyRole(id: string): Promise<RoleListItem> {
  return request.post<RoleListItem>(`/roles/${id}/copy`);
}

/** 权限点列表（按 module 分组，授权页勾选） */
export function fetchPermissionGroups(): Promise<PermissionGroup[]> {
  return request.get<PermissionGroup[]>('/permissions');
}
