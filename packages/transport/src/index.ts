/*
 * @file @fw/transport 对外入口
 * @description 统一导出传输层全部公共 API（模块、服务、驱动、注册表、装饰器、扫描、代理、
 *   解析工具与类型），禁止从深路径引用内部文件；驱动特有类型（ioredis）只以最小结构接口
 *   出现在 redis-client 中，公共导出面不暴露第三方类型。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

// ---------- 模块装配 ----------
export { TransportModule, buildTransportOptions, createTransportReadinessProbe } from './transport.module.js';
export type { TransportEnvLike, TransportModuleOptions, TransportReadinessProbe } from './transport.module.js';
export { TRANSPORT_DRIVER, TRANSPORT_OPTIONS, TRANSPORT_REGISTRY, TRANSPORT_SERVICE } from './tokens.js';

// ---------- 服务 ----------
export { TransportService } from './transport.service.js';

// ---------- 驱动 ----------
export { InProcessTransportDriver } from './drivers/in-process.driver.js';
export type { InProcessDriverOptions } from './drivers/in-process.driver.js';
export { RedisTransportDriver } from './drivers/redis.driver.js';
export type { RedisTransportDriverOptions } from './drivers/redis.driver.js';
export { createRedisClient, parseClusterNodes, loadIoredis } from './drivers/redis-client.js';
export type { RedisLike } from './drivers/redis-client.js';
export type { TransportDriverPort } from './driver.port.js';

// ---------- 注册表 / 装饰器 / 扫描 ----------
export { TransportRegistry, roleIncludesHandler } from './registry.js';
export {
  META_TRANSPORT_HANDLER,
  TransportHandler,
  readTransportHandlerAddress,
} from './decorators.js';
export { scanTransportHandlers } from './discovery.js';
export type { ProviderLike, ScannedTransportHandler } from './discovery.js';

// ---------- 客户端代理 ----------
export { createTransportProxy } from './proxy.js';

// ---------- 异常 ----------
export {
  DuplicateAddressError,
  HandlerNotRegisteredError,
  InvalidAddressError,
  InvalidTopicError,
  TransportError,
  TransportEventsUnsupportedError,
  TransportTimeoutError,
  TransportUnavailableError,
  assertAddress,
  assertTopic,
  deserializeTransportError,
  serializeTransportError,
} from './errors.js';

// ---------- 异步工具 ----------
export { delay, withTimeout } from './async.js';

// ---------- 链路追踪插桩（M8 T-M8-06；也可供业务自定义 span 使用） ----------
export { extractTraceparent, injectTraceparent, withClientSpan, withServerSpan } from './trace.js';

// ---------- 类型 ----------
export type {
  CallOptions,
  TransportCallStats,
  TransportContext,
  TransportDriverName,
  TransportEnvelope,
  TransportErrorPayload,
  TransportEventHandler,
  TransportEventMeta,
  TransportEventStats,
  TransportEventUnsubscribe,
  TransportHandlerFn,
  TransportReply,
  TransportRole,
  TransportRuntimeOptions,
  TransportTopic,
} from './types.js';
