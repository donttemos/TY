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

/** OAuth2 授权码流服务（E-07：authorize URL 构建 / state 消费 / code 交换） */
export const AUTH_OAUTH2_FLOW = Symbol('fw.auth.oauth2Flow');

/**
 * 数据范围组织解析端口（PRD-008 FR-04/FR-05）：org / org_below 档的部门查询能力，
 * 通常与 AuthStore 为同一实现（业务侧经 DI 适配注册，见 example-api AppAuthModule）。
 */
export const DATA_SCOPE_ORG = Symbol('fw.auth.dataScopeOrg');
