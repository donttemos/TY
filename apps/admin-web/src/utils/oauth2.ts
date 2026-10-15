/*
 * @file OAuth2 登录辅助（E-07：授权码端到端前端段）
 * @description 回调 fragment 解析与授权跳转 URL 构建。令牌经 URL fragment（#）回传——
 *   fragment 不进服务器日志与 Referer；解析后立即清除地址栏 hash，防令牌留在历史记录。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

/** OAuth2 回调 fragment 解析结果 */
export interface OAuth2CallbackTokens {
  accessToken: string;
  refreshToken: string;
  /** access 剩余有效秒数（可选，仅展示用） */
  expiresIn?: number;
}

/**
 * 解析 OAuth2 回调 fragment（#access_token=..&refresh_token=..&expires_in=..）
 * @param hash location.hash 原文（含或不含 # 均可）
 * @returns 令牌齐全返回结构；无 hash / 缺任一令牌返回 null（按非 OAuth2 回调处理）
 */
export function parseOAuth2CallbackHash(hash: string): OAuth2CallbackTokens | null {
  if (!hash) return null;
  const raw = hash.startsWith('#') ? hash.slice(1) : hash;
  if (!raw) return null;
  const params = new URLSearchParams(raw);
  const accessToken = params.get('access_token');
  const refreshToken = params.get('refresh_token');
  if (!accessToken || !refreshToken) return null;
  const expiresInRaw = params.get('expires_in');
  const expiresIn = expiresInRaw !== null && /^\d+$/.test(expiresInRaw) ? Number(expiresInRaw) : undefined;
  return { accessToken, refreshToken, expiresIn };
}

/**
 * 构建 OAuth2 授权跳转地址（后端 authorize 端点；redirect_uri 固定为本站登录页）
 * @param apiBase API 基址（含 /api/v1）
 * @param provider 提供方名（来自 GET /auth/oauth2/providers）
 * @param loginUrl 本站登录页绝对地址（回调白名单须涵盖其 origin）
 */
export function buildOAuth2AuthorizeUrl(apiBase: string, provider: string, loginUrl: string): string {
  const query = new URLSearchParams({ redirect_uri: loginUrl });
  return `${apiBase}/auth/oauth2/${encodeURIComponent(provider)}/authorize?${query.toString()}`;
}
