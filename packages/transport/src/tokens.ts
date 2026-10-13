/*
 * @file 依赖注入令牌
 * @description @fw/transport 的可替换实现经统一 token 注入：驱动、运行时配置、处理器注册表与传输服务，
 *   业务只注入 TransportService（或自己模块的端口 token + createTransportProxy），换驱动只改 TRANSPORT_DRIVER。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

/** 传输驱动（in-process / redis，按 TRANSPORT_DRIVER 装配） */
export const TRANSPORT_DRIVER = Symbol('fw.transport.driver');

/** 运行时配置（由 TRANSPORT_* 环境变量构建） */
export const TRANSPORT_OPTIONS = Symbol('fw.transport.options');

/** 处理器注册表（驱动与服务共享同一实例） */
export const TRANSPORT_REGISTRY = Symbol('fw.transport.registry');

/** 传输服务（与 TransportService 类 token 指向同一实例） */
export const TRANSPORT_SERVICE = Symbol('fw.transport.service');
