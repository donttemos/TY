/*
 * @file token 存储抽象
 * @description PRD-005 NFR：前端不长期驻留敏感信息——access token 仅存内存（刷新页面即失效，由 refresh 无感恢复），
 *   refresh token 存 localStorage（「记住我」关闭时退化为 sessionStorage，随会话销毁）。
 *   AUTH_STRATEGY=session（httpOnly Cookie）时本模块自动退化为空实现（令牌由浏览器携带），业务代码不感知差异。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/utils
 */

const REFRESH_TOKEN_KEY = 'fw_admin_refresh_token';

/** 是否启用本地存储：AUTH_STRATEGY=session 时令牌走 httpOnly Cookie，本地不落任何令牌 */
function storageEnabled(): boolean {
  return import.meta.env.VITE_API_BASE_URL !== undefined;
}

let accessToken: string | null = null;

/** 取当前存储介质：记住我=localStorage，否则=sessionStorage */
function activeStorage(): Storage | null {
  if (!storageEnabled()) return null;
  try {
    // 登录时已按「记住我」写入对应介质；读取时先 local 后 session
    return localStorage.getItem(REFRESH_TOKEN_KEY) !== null ? localStorage : sessionStorage;
  } catch {
    return null;
  }
}

export const tokenStore = {
  /** access token（内存） */
  getAccess(): string | null {
    return accessToken;
  },
  setAccess(token: string | null): void {
    accessToken = token;
  },

  /** refresh token（本地存储；remember=false 时仅会话内存活） */
  getRefresh(): string | null {
    const storage = activeStorage();
    return storage ? storage.getItem(REFRESH_TOKEN_KEY) : null;
  },
  setRefresh(token: string, remember = true): void {
    const storage = remember ? localStorage : sessionStorage;
    // 切换「记住我」时清理另一介质，避免双写歧义
    const other = remember ? sessionStorage : localStorage;
    other.removeItem(REFRESH_TOKEN_KEY);
    storage.setItem(REFRESH_TOKEN_KEY, token);
  },

  /** 登出 / 刷新失败：清空全部令牌 */
  clear(): void {
    accessToken = null;
    try {
      localStorage.removeItem(REFRESH_TOKEN_KEY);
      sessionStorage.removeItem(REFRESH_TOKEN_KEY);
    } catch {
      // 存储不可用（隐私模式）时静默降级
    }
  },
};
