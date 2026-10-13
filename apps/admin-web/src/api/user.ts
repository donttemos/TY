/*
 * @file 用户 API（C-06 契约 / API 规格 §3.3）
 * @description 用户分页查询与维护：列表 / 详情 / 新建 / 更新 / 软删除 / 分配角色 / 重置密码 / 启用禁用。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { PageResult, ResetPasswordResult, SetUserStatusResult, UserListItem, UserQuery, UserUpsertInput } from './types';

/** 用户分页列表 */
export function fetchUsers(query: UserQuery = {}): Promise<PageResult<UserListItem>> {
  return request.get<PageResult<UserListItem>>('/users', { params: query });
}

/** 用户详情 */
export function fetchUser(id: string): Promise<UserListItem> {
  return request.get<UserListItem>(`/users/${id}`);
}

/** 新建用户（密码走后端强校验） */
export function createUser(data: UserUpsertInput): Promise<UserListItem> {
  return request.post<UserListItem>('/users', data);
}

/** 更新用户资料 */
export function updateUser(id: string, data: UserUpsertInput): Promise<UserListItem> {
  return request.put<UserListItem>(`/users/${id}`, data);
}

/** 软删除用户（不可删内置管理员） */
export function deleteUser(id: string): Promise<{ id: string }> {
  return request.delete(`/users/${id}`);
}

/** 分配角色（全量覆盖） */
export function assignRoles(id: string, roleIds: string[]): Promise<UserListItem> {
  return request.put<UserListItem>(`/users/${id}/roles`, { roleIds });
}

/** 重置密码：返回一次性密码 */
export function resetPassword(id: string): Promise<ResetPasswordResult> {
  return request.post<ResetPasswordResult>(`/users/${id}/reset-password`);
}

/** 启用 / 禁用（禁用同时强制下线） */
export function setUserStatus(id: string, status: 0 | 1): Promise<SetUserStatusResult> {
  return request.put<SetUserStatusResult>(`/users/${id}/status`, { status });
}
