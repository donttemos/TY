/*
 * @file 前端环境变量类型声明
 * @description Vite ImportMetaEnv 扩展（FR-11：.env.* 区分 dev/test/prod）；引入 vite/client 基础类型。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web
 */

/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** API 基址（含 /api/v1 前缀），生产环境指向真实网关 */
  readonly VITE_API_BASE_URL: string;
  /** 应用标题（登录页 / 文档标题） */
  readonly VITE_APP_TITLE: string;
  /** 是否启用图形验证码钩子（默认 false，见 PRD-005 待定问题） */
  readonly VITE_LOGIN_CAPTCHA: string;
  /** 是否强制使用 mock server（默认随 mode：非 production 即启用） */
  readonly VITE_USE_MOCK: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
