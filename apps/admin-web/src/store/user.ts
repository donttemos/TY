/*
 * @file 用户状态store（Pinia）
 * @description 登录态单一数据源：令牌、当前用户资料、权限码集合；登录 / 恢复会话 / 登出 / 改密。
 *   恢复会话策略：刷新页面后 access token 已丢失（仅存内存），用本地 refresh token 无感换新后再拉资料，
 *   用户全程无感（TC-WEB-003）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 新增 updateProfile（本人资料自助，走 auth:me 端点）：
 *   原实现让个人中心调 PUT /users/:id（需 user:update），普通角色保存必 3002
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as authApi from '@/api/auth';
import type { LoginResult, LoginSession, MeResult, PermissionCode, ProfileResult } from '@/api/types';
import { tokenStore } from '@/utils/token';
import { ensureFreshToken } from '@/utils/request';

export const useUserStore = defineStore('user', () => {
  /** 当前用户资料（未登录为 null） */
  const profile = ref<MeResult | null>(null);
  /** 权限码集合（按钮级权限渲染） */
  const permissions = ref<PermissionCode[]>([]);
  /** 登录设备列表（个人中心） */
  const sessions = ref<LoginSession[]>([]);

  const isLoggedIn = ref(false);

  /** 是否持有某权限码（与关系：数组须全部命中） */
  function hasPermission(code: PermissionCode | PermissionCode[]): boolean {
    const codes = Array.isArray(code) ? code : [code];
    return codes.every((c) => permissions.value.includes(c));
  }

  /** 登录：存令牌 → 拉资料 */
  async function login(account: string, password: string, remember = true): Promise<LoginResult> {
    const result = await authApi.login(account, password);
    tokenStore.setAccess(result.accessToken);
    tokenStore.setRefresh(result.refreshToken, remember);
    await loadProfile();
    isLoggedIn.value = true;
    return result;
  }

  /** 拉取当前用户资料（权限码唯一权威来源） */
  async function loadProfile(): Promise<MeResult> {
    const me = await authApi.fetchMe();
    profile.value = me;
    permissions.value = me.permissions;
    return me;
  }

  /**
   * 恢复会话（路由守卫首屏调用）：本地有 refresh token 但内存无 access token 时，
   * 先无感刷新换 access，再拉资料；两者都失败则回登录页。
   */
  async function restoreSession(): Promise<boolean> {
    if (tokenStore.getAccess() && profile.value) return true;
    if (!tokenStore.getRefresh()) return false;
    try {
      await ensureFreshToken();
      await loadProfile();
      isLoggedIn.value = true;
      return true;
    } catch {
      tokenStore.clear();
      return false;
    }
  }

  /** 登出：通知服务端吊销 → 清本地态 */
  async function logout(): Promise<void> {
    try {
      await authApi.logout();
    } catch {
      // 登出接口失败不阻塞本地清理（令牌失效后服务端自然拒绝）
    }
    resetState();
  }

  /** 本地清态（刷新失败 / 被踢下线时调用） */
  function resetState(): void {
    tokenStore.clear();
    profile.value = null;
    permissions.value = [];
    sessions.value = [];
    isLoggedIn.value = false;
  }

  /** 加载登录设备 */
  async function loadSessions(): Promise<void> {
    sessions.value = await authApi.fetchSessions();
  }

  /** 本人资料（含手机 / 邮箱；不依赖 user:read） */
  function fetchProfile(): Promise<ProfileResult> {
    return authApi.fetchProfile();
  }

  /** 更新本人资料（成功后同步头部昵称，无需整页刷新） */
  async function updateProfile(patch: { nickname?: string; phone?: string; email?: string }): Promise<ProfileResult> {
    const updated = await authApi.updateProfile(patch);
    profile.value = {
      id: updated.id,
      username: updated.username,
      nickname: updated.nickname,
      avatar: updated.avatar,
      roles: updated.roles,
      permissions: updated.permissions,
      dataScope: updated.dataScope,
    };
    permissions.value = updated.permissions;
    return updated;
  }

  /** 下线指定设备 */
  async function revokeSession(sessionId: string): Promise<void> {
    await authApi.revokeSession(sessionId);
    await loadSessions();
  }

  /** 改密：成功后本地令牌已被服务端吊销，需重新登录 */
  async function changePassword(oldPassword: string, newPassword: string): Promise<void> {
    await authApi.changePassword(oldPassword, newPassword);
    resetState();
  }

  return {
    profile,
    permissions,
    sessions,
    isLoggedIn,
    hasPermission,
    login,
    loadProfile,
    restoreSession,
    logout,
    resetState,
    loadSessions,
    fetchProfile,
    updateProfile,
    revokeSession,
    changePassword,
  };
});
