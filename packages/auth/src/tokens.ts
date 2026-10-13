/*
 * @file 依赖注入令牌
 * @description @fw/auth 的所有可替换实现（存储、缓存、策略、会话、OAuth2 处理器、配置）经统一 token 注入，
 *   业务方只改 DI 注册即可替换实现（M4 换 Redis 缓存、M8 换租户级存储），服务代码零改动。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

/** 鉴权存储实现（业务项目提供 Prisma 实现，或使用 MemoryAuthStore） */
export const AUTH_STORE = Symbol('fw.auth.store');

/** 鉴权缓存实现（默认 MemoryAuthCache；M4 起替换为 CacheService 适配器） */
export const AUTH_CACHE = Symbol('fw.auth.cache');

/** 鉴权运行时配置（由环境变量构建） */
export const AUTH_OPTIONS = Symbol('fw.auth.options');

/** 认证策略注册表 */
export const AUTH_STRATEGY_REGISTRY = Symbol('fw.auth.strategyRegistry');

/** 会话存储（session 策略可选） */
export const AUTH_SESSION_STORE = Symbol('fw.auth.sessionStore');

/** OAuth2 提供方处理器集合 */
export const AUTH_OAUTH2_HANDLERS = Symbol('fw.auth.oauth2Handlers');
