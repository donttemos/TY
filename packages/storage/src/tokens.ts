/*
 * @file @fw/storage DI 令牌
 * @description Nest 依赖注入标识（与 @fw/cache tokens 同构）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

/** 存储端口令牌（驱动实例） */
export const STORAGE_PORT = Symbol('STORAGE_PORT');
/** 运行时配置令牌 */
export const STORAGE_OPTIONS = Symbol('STORAGE_OPTIONS');
/** 校验+key 生成门面令牌 */
export const STORAGE_SERVICE = Symbol('STORAGE_SERVICE');
