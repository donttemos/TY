/*
 * @file @fw/cache 对外入口
 * @description 统一导出缓存层全部公共 API（服务、模块、驱动、装饰器、锁、指标、key 工具与类型），
 *   禁止从深路径引用内部文件；驱动特有类型（ioredis）不出现在导出面。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

// ---------- 模块装配 ----------
export { CacheModule, CacheLifecycle, buildCacheOptions, createCacheReadinessProbe } from './cache.module.js';
export type { CacheEnvLike, CacheModuleOptions, CacheReadinessProbe } from './cache.module.js';
export { CACHE_METRICS, CACHE_OPTIONS, CACHE_SERVICE, CACHE_STORE } from './tokens.js';

// ---------- 服务 ----------
export { CacheService } from './cache.service.js';
export type { CacheServiceDeps } from './cache.service.js';

// ---------- 装饰器 ----------
export { Cacheable, expandTags, resolveCacheService, setGlobalCacheService } from './cacheable.decorator.js';
export type { CacheableOptions } from './cacheable.decorator.js';

// ---------- 分布式锁 ----------
export { LockManager } from './lock.js';
export type { LockHandle, LockOptions } from './lock.js';

// ---------- 驱动 ----------
export { MemoryCacheStore, DEFAULT_MEMORY_MAX_ITEMS } from './drivers/memory.driver.js';
export { RedisCacheStore } from './drivers/redis.driver.js';
export { createRedisClient, parseClusterNodes } from './drivers/redis-client.js';
export type { RedisClientLike } from './drivers/redis-client.js';
export type { CacheStorePort } from './store.port.js';

// ---------- 指标与端点 ----------
export { CacheMetrics } from './metrics.js';
export { CacheMetricsController, CACHE_METRICS_PATH } from './metrics.controller.js';

// ---------- key 与异常 ----------
export {
  MAX_KEY_LENGTH,
  TAG_SEGMENT,
  assertLogicalKey,
  decodeEntry,
  encodeNegative,
  encodeValue,
  hashArgs,
  stableHash,
  tagKeyOf,
  withPrefix,
} from './key.js';
export { CacheKeyError, CacheUnavailableError } from './errors.js';

// ---------- 类型 ----------
export type {
  CacheCallOptions,
  CacheDriverName,
  CacheEntryKind,
  CacheMetricsSnapshot,
  CacheReadResult,
  CacheRuntimeOptions,
} from './types.js';
