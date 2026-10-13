/*
 * @file 依赖注入令牌
 * @description @fw/cache 的可替换实现经统一 token 注入：存储驱动、运行时配置、指标采集器与缓存服务，
 *   业务与鉴权层只注入 CacheService（或 CACHE_SERVICE token），换驱动只改模块参数。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

/** 存储驱动（memory / redis，按 CACHE_DRIVER 装配） */
export const CACHE_STORE = Symbol('fw.cache.store');

/** 运行时配置（由环境变量构建） */
export const CACHE_OPTIONS = Symbol('fw.cache.options');

/** 指标采集器 */
export const CACHE_METRICS = Symbol('fw.cache.metrics');

/** 缓存服务（与 CacheService 类 token 指向同一实例） */
export const CACHE_SERVICE = Symbol('fw.cache.service');
