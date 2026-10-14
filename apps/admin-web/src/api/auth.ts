/*
 * @file 认证 API（C-06 契约 / API 规格 §3.2）
 * @description 登录 / 刷新 / 登出 / 当前用户 / 菜单树 / 改密 / 登录设备。刷新由请求层无感执行，此处仅暴露登出等业务动作。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 新增本人资料自助端点（GET / PUT /auth/profile）：
 *   原先个人中心借 PUT /users/:id 保存资料，该端点需 user:update，普通角色保存必 3002
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { LoginResult, LoginSession, MeResult, MenuNode, ProfileResult } from './types';

/** 账号密码登录 */
export function login(account: string, password: string): Promise<LoginResult> {
  return request.post<LoginResult>('/auth/login', { account, password });
}

/** 登出（令牌进黑名单 + 撤销当前设备 refresh 族） */
export function logout(): Promise<unknown> {
  return request.post('/auth/logout');
}

/** 当前用户资料 + 角色 + 权限码 */
export function fetchMe(): Promise<MeResult> {
  return request.get<MeResult>('/auth/me');
}

/** 当前用户可见菜单树（动态路由数据源） */
export function fetchMenus(): Promise<MenuNode[]> {
  return request.get<MenuNode[]>('/auth/menus');
}

/** 修改本人密码（成功后其它设备下线） */
export function changePassword(oldPassword: string, newPassword: string): Promise<{ changed: boolean }> {
  return request.post('/auth/change-password', { oldPassword, newPassword });
}

/** 登录设备列表（个人中心） */
export function fetchSessions(): Promise<LoginSession[]> {
  return request.get<LoginSession[]>('/auth/sessions');
}

/** 本人资料（含手机 / 邮箱，个人中心回显；仅需 auth:me，不依赖 user:read） */
export function fetchProfile(): Promise<ProfileResult> {
  return request.get<ProfileResult>('/auth/profile');
}

/** 更新本人资料（服务端只接受 nickname / phone / email，其余字段一律拒绝） */
export function updateProfile(data: { nickname?: string; phone?: string; email?: string }): Promise<ProfileResult> {
  return request.put<ProfileResult>('/auth/profile', data);
}

/** 下线指定设备 */
export function revokeSession(sessionId: string): Promise<{ revoked: string }> {
  return request.delete(`/auth/sessions/${sessionId}`);
}
