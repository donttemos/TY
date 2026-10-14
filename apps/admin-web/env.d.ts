/*
 * @file 前端环境变量类型声明
 * @description Vite ImportMetaEnv 扩展（FR-11：.env.* 区分 dev/test/prod）；引入 vite/client 基础类型。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 基址（含 /api/v1 前缀）；缺省时回退同源 `/api/v1`（见 src/utils/request.ts） */
  readonly VITE_API_BASE_URL: string;
  /** 应用标题（登录页 / 文档标题） */
  readonly VITE_APP_TITLE: string;
  /** 是否启用图形验证码钩子（默认 false，见 PRD-005 待定问题） */
  readonly VITE_LOGIN_CAPTCHA: string;
  /** 是否强制使用 mock server（默认随 mode：非 production 即启用） */
  readonly VITE_USE_MOCK: string;
  /** 令牌本地存储开关：缺省启用；置 none 时本地不落令牌（AUTH_STRATEGY=session 走 httpOnly Cookie） */
  readonly VITE_AUTH_STORAGE: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
