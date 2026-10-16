/*
 * @file token 存储抽象
 * @description PRD-005 NFR：前端不长期驻留敏感信息——access token 仅存内存（刷新页面即失效，由 refresh 无感恢复），
 *   refresh token 存 localStorage（「记住我」关闭时退化为 sessionStorage，随会话销毁）。
 *   AUTH_STRATEGY=session（httpOnly Cookie）时置 VITE_AUTH_STORAGE=none，本模块退化为空实现，
 *   令牌由浏览器携带，业务代码不感知差异。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 真机修复：存储开关由「VITE_API_BASE_URL 是否已定义」改为专用
 *   VITE_AUTH_STORAGE（默认启用）。原实现借用无关变量作哨兵，生产构建缺 .env.* 时会静默关闭
 *   令牌存储，导致「记住我」失效、刷新即掉登录
 * @module __APP_NAME__-web/utils
 */

const REFRESH_TOKEN_KEY = 'fw_admin_refresh_token';

/**
 * 是否启用本地存储。
 *
 * 默认**启用**；AUTH_STRATEGY=session（httpOnly Cookie，令牌由浏览器携带）时置
 * `VITE_AUTH_STORAGE=none` 关闭，本地不落任何令牌。
 *
 * 历史实现以「VITE_API_BASE_URL 是否已定义」作哨兵，属于**变量语义错配**：该变量来自不进版本库的
 * `.env.*`（.gitignore 排除），生产构建缺失时会连带静默关闭令牌存储 —— 表现为「记住我」失效、
 * 刷新页面即掉登录。真机部署曾踩到，故改用专用开关，默认值取「启用」而非「依赖某个外部变量存在」。
 */
function storageEnabled(): boolean {
  return import.meta.env.VITE_AUTH_STORAGE !== 'none';
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
