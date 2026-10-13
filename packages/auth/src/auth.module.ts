/*
 * @file 鉴权模块装配
 * @description `AuthModule.forRoot({ store })` 完成全部服务装配：配置（环境变量 → AuthOptions）、
 *   存储/缓存/策略注入、全局守卫（APP_GUARD）与审计拦截器（APP_INTERCEPTOR）注册。
 *   默认实现：缓存用 MemoryAuthCache（M4 换 Redis）、策略注册 jwt + apikey（session / oauth2 按需注册）。
 *   `JWT_SECRET` 缺失时在装配期直接抛错——鉴权不允许「无密钥静默降级」。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo allowRegister 缺省回落 false（默认关闭自助注册）
 * @modified 2026-10-13 donttemo cache 支持类形态（M4：应用侧把 @fw/cache 适配为 AuthCachePort 需 DI）
 * @module @fw/auth
 */

import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { loadEnv } from '@fw/config';
import { AuditInterceptor } from './audit.interceptor.js';
import { AuditService } from './audit.service.js';
import { MemoryAuthCache, type AuthCachePort } from './auth-cache.js';
import type { AuthStore } from './auth-store.js';
import { AuthService } from './auth.service.js';
import {
  DEFAULT_ACCESS_TTL_SECONDS,
  DEFAULT_LOCK_MINUTES,
  DEFAULT_LOGIN_RATE_LIMIT,
  DEFAULT_MAX_FAILED,
  DEFAULT_PASSWORD_POLICY,
  DEFAULT_PERMISSION_CACHE_TTL_SECONDS,
  DEFAULT_PUBLIC_PATHS,
  DEFAULT_REFRESH_GRACE_SECONDS,
  DEFAULT_REFRESH_TTL_SECONDS,
  DEFAULT_STRATEGY,
} from './constants.js';
import { parseDurationSeconds } from './duration.js';
import { LoginSecurity } from './login-security.js';
import { PasswordService } from './password.service.js';
import { PermissionService } from './permission.service.js';
import { RbacGuard } from './rbac.guard.js';
import { RefreshTokenService } from './refresh-token.service.js';
import {
  ApiKeyStrategy,
  JwtStrategy,
  OAuth2Strategy,
  SessionStrategy,
  StrategyRegistry,
  parseApiKeys,
  type OAuth2Handler,
  type SessionStore,
} from './strategies.js';
import { TokenService } from './token.service.js';
import { TokenBlacklist } from './token-blacklist.js';
import { AUTH_CACHE, AUTH_OAUTH2_HANDLERS, AUTH_OPTIONS, AUTH_SESSION_STORE, AUTH_STORE, AUTH_STRATEGY_REGISTRY } from './tokens.js';
import type { AuthOptions, AuthStrategyName, PasswordPolicy } from './types.js';

/** 环境变量结构子集（真实 Env 天然满足；测试可传桩对象） */
export interface AuthEnvLike {
  AUTH_STRATEGY?: AuthStrategyName;
  AUTH_ACCESS_TTL?: string;
  AUTH_REFRESH_TTL?: string;
  AUTH_MAX_FAILED?: number;
  AUTH_LOCK_MINUTES?: number;
  AUTH_REFRESH_GRACE_SECONDS?: number;
  AUTH_PASSWORD_POLICY?: PasswordPolicy;
  AUTH_ALLOW_REGISTER?: boolean;
  JWT_SECRET?: string;
  JWT_SECRET_PREV?: string;
  AUTH_API_KEYS?: string;
}

/** forRoot 入参 */
export interface AuthModuleOptions {
  /**
   * 鉴权存储：可直接传实例（内存/测试），也可传类（Nest 用 DI 实例化，
   * 例如业务侧 PrismaAuthStore 需要注入 DB_CLIENT）——类形态下由 Nest 负责依赖解析。
   */
  store: AuthStore | (new (...args: never[]) => AuthStore);
  /**
   * 缓存实现：可传实例（内存/测试）或类（Nest 用 DI 实例化，例如应用侧把 @fw/cache 的
   * CacheService 适配为 AuthCachePort 需要注入 CACHE_SERVICE）；缺省 MemoryAuthCache。
   */
  cache?: AuthCachePort | (new (...args: never[]) => AuthCachePort);
  /** 环境变量来源，缺省读取进程环境（loadEnv） */
  env?: AuthEnvLike;
  /** 直接覆盖运行时配置（优先级最高，测试用） */
  overrides?: Partial<AuthOptions>;
  /** session 策略的会话存储（不传则 session 策略不可用） */
  sessionStore?: SessionStore;
  /** OAuth2 提供方处理器（微信 / 企业微信 / GitHub） */
  oauth2Handlers?: Record<string, OAuth2Handler>;
  /** 是否注册全局守卫（默认 true；仅测试或纯前端托管场景关闭） */
  globalGuard?: boolean;
  /** 是否注册审计拦截器（默认 true） */
  auditInterceptor?: boolean;
}

/**
 * 由环境变量构建运行时配置
 * @param env 环境变量来源
 * @param overrides 覆盖项
 * @returns AuthOptions
 * @throws Error 缺少 JWT_SECRET
 */
export function buildAuthOptions(env: AuthEnvLike, overrides: Partial<AuthOptions> = {}): AuthOptions {
  const jwtSecret = overrides.jwtSecret ?? env.JWT_SECRET;
  if (!jwtSecret) {
    throw new Error('缺少 JWT_SECRET：请在 .env 配置 ≥32 位强随机密钥（M3 鉴权必需，无默认值以防弱密钥入生产）');
  }
  if (env.JWT_SECRET_PREV && env.JWT_SECRET_PREV === jwtSecret) {
    throw new Error('JWT_SECRET_PREV 不得与 JWT_SECRET 相同：轮换过渡期需两把不同密钥（TC-AUTH-014）');
  }
  return {
    strategy: overrides.strategy ?? env.AUTH_STRATEGY ?? DEFAULT_STRATEGY,
    accessTtlSeconds: overrides.accessTtlSeconds ?? parseDurationSeconds(env.AUTH_ACCESS_TTL ?? DEFAULT_ACCESS_TTL_SECONDS),
    refreshTtlSeconds: overrides.refreshTtlSeconds ?? parseDurationSeconds(env.AUTH_REFRESH_TTL ?? DEFAULT_REFRESH_TTL_SECONDS),
    maxFailed: overrides.maxFailed ?? env.AUTH_MAX_FAILED ?? DEFAULT_MAX_FAILED,
    lockMinutes: overrides.lockMinutes ?? env.AUTH_LOCK_MINUTES ?? DEFAULT_LOCK_MINUTES,
    refreshGraceSeconds: overrides.refreshGraceSeconds ?? env.AUTH_REFRESH_GRACE_SECONDS ?? DEFAULT_REFRESH_GRACE_SECONDS,
    passwordPolicy: overrides.passwordPolicy ?? env.AUTH_PASSWORD_POLICY ?? DEFAULT_PASSWORD_POLICY,
    allowRegister: overrides.allowRegister ?? env.AUTH_ALLOW_REGISTER ?? false,
    jwtSecret,
    jwtSecretPrev: overrides.jwtSecretPrev ?? env.JWT_SECRET_PREV,
    apiKeys: overrides.apiKeys ?? parseApiKeys(env.AUTH_API_KEYS),
    loginRateLimit: overrides.loginRateLimit ?? DEFAULT_LOGIN_RATE_LIMIT,
    permissionCacheTtlSeconds: overrides.permissionCacheTtlSeconds ?? DEFAULT_PERMISSION_CACHE_TTL_SECONDS,
    publicPaths: overrides.publicPaths ?? [...DEFAULT_PUBLIC_PATHS],
  };
}

/**
 * 鉴权全局模块
 */
@Global()
@Module({})
export class AuthModule {
  /**
   * 装配鉴权能力
   * @param options 存储、缓存与策略配置
   * @returns 动态模块定义
   */
  static forRoot(options: AuthModuleOptions): DynamicModule {
    const env = options.env ?? loadEnv();
    const runtime = buildAuthOptions(env, options.overrides);

    const providers: Provider[] = [
      // 类形态走 DI（业务侧需要注入 DB_CLIENT 等依赖），实例形态直接可用
      typeof options.store === 'function'
        ? { provide: AUTH_STORE, useClass: options.store }
        : { provide: AUTH_STORE, useValue: options.store },
      // 类形态走 DI（应用侧适配器需要注入 CACHE_SERVICE 等依赖），实例形态直接可用
      typeof options.cache === 'function'
        ? { provide: AUTH_CACHE, useClass: options.cache }
        : { provide: AUTH_CACHE, useValue: options.cache ?? new MemoryAuthCache() },
      { provide: AUTH_OPTIONS, useValue: runtime },
      { provide: AUTH_SESSION_STORE, useValue: options.sessionStore },
      { provide: AUTH_OAUTH2_HANDLERS, useValue: options.oauth2Handlers ?? {} },
      {
        provide: PasswordService,
        useFactory: (config: AuthOptions) => new PasswordService(config.passwordPolicy),
        inject: [AUTH_OPTIONS],
      },
      {
        provide: TokenService,
        useFactory: (config: AuthOptions) =>
          new TokenService({
            secret: config.jwtSecret,
            secretPrev: config.jwtSecretPrev,
            accessTtlSeconds: config.accessTtlSeconds,
            refreshTtlSeconds: config.refreshTtlSeconds,
          }),
        inject: [AUTH_OPTIONS],
      },
      {
        provide: TokenBlacklist,
        useFactory: (cache: AuthCachePort) => new TokenBlacklist(cache),
        inject: [AUTH_CACHE],
      },
      {
        provide: RefreshTokenService,
        useFactory: (store: AuthStore, tokens: TokenService, config: AuthOptions) =>
          new RefreshTokenService(store, tokens, config.refreshGraceSeconds),
        inject: [AUTH_STORE, TokenService, AUTH_OPTIONS],
      },
      {
        provide: LoginSecurity,
        useFactory: (cache: AuthCachePort, config: AuthOptions) =>
          new LoginSecurity(cache, {
            maxFailed: config.maxFailed,
            lockMinutes: config.lockMinutes,
            rateLimit: config.loginRateLimit,
          }),
        inject: [AUTH_CACHE, AUTH_OPTIONS],
      },
      {
        provide: PermissionService,
        useFactory: (store: AuthStore, cache: AuthCachePort, config: AuthOptions) =>
          new PermissionService(store, cache, config.permissionCacheTtlSeconds),
        inject: [AUTH_STORE, AUTH_CACHE, AUTH_OPTIONS],
      },
      {
        provide: AuditService,
        useFactory: (store: AuthStore) => new AuditService(store),
        inject: [AUTH_STORE],
      },
      {
        provide: AUTH_STRATEGY_REGISTRY,
        useFactory: (
          tokens: TokenService,
          blacklist: TokenBlacklist,
          config: AuthOptions,
          sessionStore: SessionStore | undefined,
          oauth2Handlers: Record<string, OAuth2Handler>,
        ) => {
          const oauth2 = new OAuth2Strategy();
          for (const [provider, handler] of Object.entries(oauth2Handlers)) oauth2.registerProvider(provider, handler);
          return new StrategyRegistry([
            new JwtStrategy(tokens, blacklist),
            new ApiKeyStrategy(config.apiKeys),
            new SessionStrategy(sessionStore),
            oauth2,
          ]);
        },
        inject: [TokenService, TokenBlacklist, AUTH_OPTIONS, AUTH_SESSION_STORE, AUTH_OAUTH2_HANDLERS],
      },
      {
        provide: AuthService,
        useFactory: (
          store: AuthStore,
          passwords: PasswordService,
          tokens: TokenService,
          refresh: RefreshTokenService,
          blacklist: TokenBlacklist,
          security: LoginSecurity,
          permissions: PermissionService,
          audit: AuditService,
          config: AuthOptions,
        ) =>
          new AuthService({ store, passwords, tokens, refresh, blacklist, security, permissions, audit, options: config }),
        inject: [
          AUTH_STORE,
          PasswordService,
          TokenService,
          RefreshTokenService,
          TokenBlacklist,
          LoginSecurity,
          PermissionService,
          AuditService,
          AUTH_OPTIONS,
        ],
      },
    ];

    if (options.globalGuard !== false) {
      providers.push({ provide: APP_GUARD, useClass: RbacGuard });
    }
    if (options.auditInterceptor !== false) {
      providers.push({ provide: APP_INTERCEPTOR, useClass: AuditInterceptor });
    }

    return {
      module: AuthModule,
      global: true,
      providers,
      exports: [AUTH_STORE, AUTH_OPTIONS, AuthService, PermissionService, PasswordService, TokenService, TokenBlacklist, RefreshTokenService, AuditService, LoginSecurity],
    };
  }
}
