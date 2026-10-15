/*
 * @file OAuth2 授权码客户端（E-07：授权码端到端的框架原语）
 * @description PRD-010 E-07 / AC6：把「跳转 → 回调 → 换 token → 拉用户信息」做成可装配的服务，
 *   身份到本地账号的映射与登录会话签发留在应用层（oauth2.controller + AuthService.loginByOAuth2）。
 *   安全要点：
 *   - state 防 CSRF：随机 UUID nonce，经 AuthCachePort 一次性消费（取后即删 + TTL），回调必须带回；
 *   - 回调域名白名单：redirect_uri 必须前缀命中 AUTH_OAUTH2_REDIRECT_WHITELIST，未配置即全拒（默认安全）；
 *   - 提供方未注册明确拒绝，不静默放行；clientSecret 只参与令牌端点请求，不进日志。
 *   令牌端点与用户信息端点走 RFC 6749 §4.1.3 / §4.1.4 标准 form 交换（Node 20+ 内置 fetch，不引 SDK，
 *   与 NacosConfigDriver 同策略）；fetch 可注入测试桩。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/auth
 */

import { randomUUID } from 'node:crypto';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import { DEFAULT_OAUTH2_STATE_TTL_SECONDS, OAUTH2_STATE_CACHE_PREFIX } from './constants.js';
import type { AuthCachePort } from './auth-cache.js';
import type { OAuth2ProviderConfig } from './types.js';

const logger = Logger.for('auth.oauth2');

/** state 缓存载荷（一次性凭据：provider 与 redirectUri 必须与回调完全一致） */
interface OAuth2StateEntry {
  provider: string;
  redirectUri: string;
}

/** OAuth2 提供方配置注册表解析结果：非法条目跳过并告警（与 parseApiKeys 同策略） */
export function parseOAuth2Providers(raw: string | undefined): OAuth2ProviderConfig[] {
  if (!raw || raw.trim() === '') return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    logger.warn('AUTH_OAUTH2_PROVIDERS 不是合法 JSON，忽略全部提供方');
    return [];
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    logger.warn('AUTH_OAUTH2_PROVIDERS 应为 { provider: 配置 } 对象，忽略');
    return [];
  }
  const configs: OAuth2ProviderConfig[] = [];
  for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name)) {
      logger.warn('OAuth2 提供方名非法（须为小写字母开头的 1-32 位 [a-z0-9_-]），已跳过', { provider: name });
      continue;
    }
    const v = (value ?? {}) as Partial<OAuth2ProviderConfig>;
    const missing = (['clientId', 'clientSecret', 'authorizeUrl', 'tokenUrl', 'userInfoUrl'] as const).filter(
      (field) => typeof v?.[field] !== 'string' || (v?.[field] as string).length === 0,
    );
    if (missing.length > 0) {
      logger.warn('OAuth2 提供方配置缺少必填字段，已跳过', { provider: name, missing });
      continue;
    }
    configs.push({
      provider: name,
      clientId: v.clientId as string,
      clientSecret: v.clientSecret as string,
      authorizeUrl: v.authorizeUrl as string,
      tokenUrl: v.tokenUrl as string,
      userInfoUrl: v.userInfoUrl as string,
      scope: typeof v.scope === 'string' && v.scope ? v.scope : undefined,
    });
  }
  return configs;
}

/** 解析回调地址白名单：逗号分隔，去空去重 */
export function parseRedirectWhitelist(raw: string | undefined): string[] {
  if (!raw) return [];
  return [...new Set(raw.split(',').map((item) => item.trim()).filter(Boolean))];
}

/** OAuth2 授权码流服务依赖 */
export interface OAuth2FlowOptions {
  /** 提供方配置（parseOAuth2Providers 解析结果） */
  providers: OAuth2ProviderConfig[];
  /** 缓存端口（state 一次性存取；复用 AuthCachePort，redis 驱动下多实例共享） */
  cache: AuthCachePort;
  /** 回调地址白名单（parseRedirectWhitelist 解析结果；空 = 全拒） */
  redirectWhitelist: string[];
  /** state 有效期（秒），默认 300 */
  stateTtlSeconds?: number;
  /** fetch 实现（测试注入桩；缺省全局 fetch） */
  fetchImpl?: typeof fetch;
}

/** 回调解析结果：应用层据此映射本地账号并签发会话 */
export interface OAuth2CallbackResult {
  provider: string;
  /** 回调地址（与 authorize 时登记的一致） */
  redirectUri: string;
  /** IdP 颁发的访问令牌（仅本次交换用途，不落库不进审计） */
  idpAccessToken: string;
  /** IdP 用户信息（JSON 原文） */
  userInfo: Record<string, unknown>;
}

/**
 * OAuth2 授权码流服务（E-07）
 */
export class OAuth2FlowService {
  private readonly providers: Map<string, OAuth2ProviderConfig>;
  private readonly stateTtlSeconds: number;
  private readonly fetchImpl: typeof fetch;

  /**
   * @param options 提供方配置、缓存端口、回调白名单与可注入 fetch
   */
  constructor(private readonly options: OAuth2FlowOptions) {
    this.providers = new Map(options.providers.map((provider) => [provider.provider, provider]));
    this.stateTtlSeconds = options.stateTtlSeconds ?? DEFAULT_OAUTH2_STATE_TTL_SECONDS;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  /** 已注册提供方名列表（供 GET /auth/oauth2/providers 与登录页渲染入口） */
  listProviders(): string[] {
    return [...this.providers.keys()];
  }

  /** 提供方是否已注册 */
  has(provider: string): boolean {
    return this.providers.has(provider);
  }

  /**
   * 构建 IdP 授权跳转地址：校验提供方与回调白名单 → 生成一次性 state 并入缓存 → 拼 query
   * @param provider 提供方名
   * @param redirectUri 回调地址（须前缀命中白名单）
   * @returns 302 目标 URL
   * @throws BizError 4001 提供方未注册 / 1001 redirect_uri 缺失或不在白名单
   */
  async buildAuthorizeUrl(provider: string, redirectUri: string | undefined): Promise<string> {
    const config = this.mustGet(provider);
    if (!redirectUri) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'redirect_uri 必填');
    }
    this.assertAllowedRedirect(redirectUri);
    const state = randomUUID();
    await this.options.cache.set(
      `${OAUTH2_STATE_CACHE_PREFIX}${state}`,
      { provider, redirectUri } satisfies OAuth2StateEntry,
      this.stateTtlSeconds,
    );
    const url = new URL(config.authorizeUrl);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('client_id', config.clientId);
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('state', state);
    if (config.scope) url.searchParams.set('scope', config.scope);
    logger.info('构建 OAuth2 授权跳转', { provider, redirectUri });
    return url.toString();
  }

  /**
   * 消费回调：state 一次性校验（取后即删，重放/伪造一律拒绝）→ code 换 access_token → 拉用户信息
   * @param provider 提供方名（须与 state 登记一致，防跨提供方重放）
   * @param code IdP 回传的授权码
   * @param state IdP 回传的 state
   * @throws BizError 4001 提供方未注册 / 1001 参数缺失 / 3001 state 非法或已消费、IdP 拒绝 / 9002 IdP 不可达
   */
  async resolveCallback(provider: string, code: string | undefined, state: string | undefined): Promise<OAuth2CallbackResult> {
    if (!code || !state) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'code 与 state 必填');
    }
    const config = this.mustGet(provider);
    const stateKey = `${OAUTH2_STATE_CACHE_PREFIX}${state}`;
    const entry = await this.options.cache.get<OAuth2StateEntry>(stateKey);
    await this.options.cache.del(stateKey);
    if (!entry || entry.provider !== provider) {
      logger.warn('OAuth2 state 校验失败', { provider, reason: entry ? 'provider 不一致' : '不存在或已消费' });
      throw new BizError(ErrorCode.UNAUTHORIZED, 'state 无效或已过期，请重新发起授权');
    }
    this.assertAllowedRedirect(entry.redirectUri);

    const idpAccessToken = await this.exchangeCode(config, code, entry.redirectUri);
    const userInfo = await this.fetchUserInfo(config, idpAccessToken);
    logger.info('OAuth2 回调解析完成', { provider });
    return { provider, redirectUri: entry.redirectUri, idpAccessToken, userInfo };
  }

  /** 回调地址白名单：前缀命中且边界完整（origin 后只能跟 / ? # 或结尾），防 `evil.com#http://ok` 类绕过 */
  private assertAllowedRedirect(redirectUri: string): void {
    const whitelist = this.options.redirectWhitelist;
    const hit = whitelist.some((prefix) => {
      if (!redirectUri.startsWith(prefix)) return false;
      const rest = redirectUri.slice(prefix.length);
      return rest === '' || rest.startsWith('/') || rest.startsWith('?') || rest.startsWith('#');
    });
    if (!hit) {
      logger.warn('OAuth2 回调地址不在白名单', { prefixes: whitelist.length });
      throw new BizError(ErrorCode.BAD_REQUEST, '回调地址不在白名单内');
    }
  }

  /** 取提供方：未注册明确拒绝（不泄漏资源存在性的前提是先过白名单，此处可如实报未注册） */
  private mustGet(provider: string): OAuth2ProviderConfig {
    const config = this.providers.get(provider);
    if (!config) {
      throw new BizError(ErrorCode.UNAUTHORIZED, `OAuth2 提供方未注册：${provider}`);
    }
    return config;
  }

  /** RFC 6749 §4.1.3：code + client 凭据换 access_token（form 编码，client_secret_post） */
  private async exchangeCode(config: OAuth2ProviderConfig, code: string, redirectUri: string): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(config.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri,
          client_id: config.clientId,
          client_secret: config.clientSecret,
        }).toString(),
      });
    } catch (error) {
      logger.error('OAuth2 令牌端点请求失败', { provider: config.provider, reason: (error as Error).message });
      throw new BizError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'OAuth2 令牌交换失败：IdP 不可达');
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok || typeof payload.access_token !== 'string' || payload.access_token === '') {
      logger.error('OAuth2 令牌交换被 IdP 拒绝', { provider: config.provider, status: response.status });
      throw new BizError(ErrorCode.UNAUTHORIZED, 'OAuth2 令牌交换失败：授权码无效或已过期');
    }
    return payload.access_token;
  }

  /** RFC 6749 §4.1.4 后的身份声明拉取：Bearer access_token GET userInfoUrl */
  private async fetchUserInfo(config: OAuth2ProviderConfig, accessToken: string): Promise<Record<string, unknown>> {
    let response: Response;
    try {
      response = await this.fetchImpl(config.userInfoUrl, {
        headers: { authorization: `Bearer ${accessToken}`, accept: 'application/json' },
      });
    } catch (error) {
      logger.error('OAuth2 用户信息端点请求失败', { provider: config.provider, reason: (error as Error).message });
      throw new BizError(ErrorCode.DEPENDENCY_UNAVAILABLE, 'OAuth2 用户信息拉取失败：IdP 不可达');
    }
    const payload = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      logger.error('OAuth2 用户信息拉取被 IdP 拒绝', { provider: config.provider, status: response.status });
      throw new BizError(ErrorCode.UNAUTHORIZED, 'OAuth2 用户信息拉取失败');
    }
    return payload;
  }
}
