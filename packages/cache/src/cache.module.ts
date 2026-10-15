/*
 * @file CacheModule：缓存能力装配
 * @description `CacheModule.forRoot()` 按 `CACHE_DRIVER` 装配存储驱动（memory 零依赖；redis 走 ioredis 懒加载）、
 *   构建运行时配置、注册 CacheService（同时作为全局 @Cacheable 兜底实例）与 /metrics 控制器。
 *   切换驱动只改配置：业务代码与鉴权适配器 diff = 0（PRD-004 AC-002）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { Global, Inject, Injectable, Module, type DynamicModule, type OnApplicationShutdown, type Provider } from '@nestjs/common';
import { loadEnv } from '@fw/config';
import { CacheService } from './cache.service.js';
import { setGlobalCacheService } from './cacheable.decorator.js';
import { MemoryCacheStore, DEFAULT_MEMORY_MAX_ITEMS } from './drivers/memory.driver.js';
import { createRedisClient } from './drivers/redis-client.js';
import { RedisCacheStore } from './drivers/redis.driver.js';
import { CacheMetricsController } from './metrics.controller.js';
import { CacheMetrics } from './metrics.js';
import type { CacheStorePort } from './store.port.js';
import { CACHE_METRICS, CACHE_OPTIONS, CACHE_SERVICE, CACHE_STORE } from './tokens.js';
import type { CacheDriverName, CacheRuntimeOptions } from './types.js';

/** 环境变量结构子集（真实 Env 天然满足；测试可传桩对象） */
export interface CacheEnvLike {
  APP_ENV?: string;
  CACHE_DRIVER?: CacheDriverName;
  CACHE_URL?: string;
  CACHE_PREFIX?: string;
  CACHE_TTL?: number;
  CACHE_MAX_ITEMS?: number;
  CACHE_FAIL_OPEN?: boolean;
  CACHE_NULL_TTL?: number;
  CACHE_TTL_JITTER?: number;
  CACHE_LOCK_TTL?: number;
  CACHE_TAG_TTL?: number;
  CACHE_SLOW_MS?: number;
  CACHE_MAX_VALUE_BYTES?: number;
}

/** 各项默认值（与 @fw/config 的 env-schema 保持一致，仅用于桩对象兜底） */
const DEFAULTS = {
  driver: 'memory' as CacheDriverName,
  ttl: 300,
  maxItems: DEFAULT_MEMORY_MAX_ITEMS,
  failOpen: true,
  nullTtl: 60,
  ttlJitter: 0.1,
  lockTtl: 30,
  tagTtl: 86400,
  slowMs: 50,
  maxValueBytes: 1048576,
};

/**
 * 由环境变量构建缓存运行时配置
 * @param env 环境变量来源
 * @param overrides 覆盖项（优先级最高）
 * @returns CacheRuntimeOptions
 */
export function buildCacheOptions(env: CacheEnvLike, overrides: Partial<CacheRuntimeOptions> = {}): CacheRuntimeOptions {
  const driver = overrides.driver ?? env.CACHE_DRIVER ?? DEFAULTS.driver;
  return {
    driver,
    url: overrides.url ?? env.CACHE_URL,
    // 前缀留空时自动取 `fw:<APP_ENV>`，避免多环境串数据
    prefix: overrides.prefix ?? (env.CACHE_PREFIX && env.CACHE_PREFIX.length > 0 ? env.CACHE_PREFIX : `fw:${env.APP_ENV ?? 'default'}`),
    defaultTtlSeconds: overrides.defaultTtlSeconds ?? env.CACHE_TTL ?? DEFAULTS.ttl,
    maxItems: overrides.maxItems ?? env.CACHE_MAX_ITEMS ?? DEFAULTS.maxItems,
    failOpen: overrides.failOpen ?? env.CACHE_FAIL_OPEN ?? DEFAULTS.failOpen,
    nullTtlSeconds: overrides.nullTtlSeconds ?? env.CACHE_NULL_TTL ?? DEFAULTS.nullTtl,
    ttlJitter: overrides.ttlJitter ?? env.CACHE_TTL_JITTER ?? DEFAULTS.ttlJitter,
    lockTtlSeconds: overrides.lockTtlSeconds ?? env.CACHE_LOCK_TTL ?? DEFAULTS.lockTtl,
    tagTtlSeconds: overrides.tagTtlSeconds ?? env.CACHE_TAG_TTL ?? DEFAULTS.tagTtl,
    slowMs: overrides.slowMs ?? env.CACHE_SLOW_MS ?? DEFAULTS.slowMs,
    maxValueBytes: overrides.maxValueBytes ?? env.CACHE_MAX_VALUE_BYTES ?? DEFAULTS.maxValueBytes,
  };
}

/** 就绪探针（与 @fw/core 的 ReadinessProbe 结构一致，避免 core 与本包互相依赖） */
export interface CacheReadinessProbe {
  name: string;
  check: () => Promise<boolean>;
  /** 模块装配完成后绑定缓存服务（探针在模块定义期创建，服务在容器期实例化） */
  markReady(service: CacheService): void;
}

/**
 * 创建缓存就绪探针（供 FwCoreModule.forRoot({ readinessProbes: [probe] })）
 * @returns 可变探针：未装配前判定为未就绪
 */
export function createCacheReadinessProbe(): CacheReadinessProbe {
  let service: CacheService | undefined;
  return {
    name: 'cache',
    check: async () => (service ? service.ping() : false),
    markReady(next: CacheService): void {
      service = next;
    },
  };
}

/** forRoot 入参 */
export interface CacheModuleOptions {
  /** 环境变量来源，缺省读进程环境 */
  env?: CacheEnvLike;
  /** 直接覆盖运行时配置（测试用） */
  overrides?: Partial<CacheRuntimeOptions>;
  /** 自定义存储驱动（测试注入 fake；传入后忽略 CACHE_DRIVER） */
  store?: CacheStorePort;
  /** 指标采集器（缺省自建） */
  metrics?: CacheMetrics;
  /** 是否注册 /metrics 控制器（默认 true） */
  exposeMetrics?: boolean;
  /** 就绪探针实例（与 FwCoreModule 共用同一对象） */
  readinessProbe?: CacheReadinessProbe;
}

/** 优雅停机钩子：关闭存储连接 */
@Injectable()
export class CacheLifecycle implements OnApplicationShutdown {
  constructor(@Inject(CACHE_SERVICE) private readonly cache: CacheService) {}

  /** 应用关闭时释放连接（memory 驱动为清空，redis 驱动 quit） */
  async onApplicationShutdown(): Promise<void> {
    await this.cache.close();
  }
}

/**
 * 缓存全局模块
 */
@Global()
@Module({})
export class CacheModule {
  /**
   * 装配缓存能力
   * @param options 环境、覆盖项、自定义驱动与指标
   * @returns 动态模块定义
   */
  static forRoot(options: CacheModuleOptions = {}): DynamicModule {
    const env = options.env ?? loadEnv();
    const runtime = buildCacheOptions(env, options.overrides);

    const providers: Provider[] = [
      {
        // 异步工厂：redis 驱动内部动态 import('ioredis')，memory 驱动下 ioredis 不入依赖图
        provide: CACHE_STORE,
        useFactory: async (): Promise<CacheStorePort> => {
          if (options.store) return options.store;
          if (runtime.driver === 'memory') return new MemoryCacheStore(runtime.maxItems);
          const client = await createRedisClient(runtime.driver, runtime.url);
          return new RedisCacheStore(client, runtime.driver);
        },
      },
      { provide: CACHE_OPTIONS, useValue: runtime },
      { provide: CACHE_METRICS, useValue: options.metrics ?? new CacheMetrics() },
      {
        provide: CacheService,
        useFactory: (store: CacheStorePort, opts: CacheRuntimeOptions, metrics: CacheMetrics): CacheService => {
          const service = new CacheService({ store, options: opts, metrics });
          // 注册全局实例：@Cacheable 无需显式注入属性即可工作；绑定就绪探针
          setGlobalCacheService(service);
          options.readinessProbe?.markReady(service);
          return service;
        },
        inject: [CACHE_STORE, CACHE_OPTIONS, CACHE_METRICS],
      },
      { provide: CACHE_SERVICE, useExisting: CacheService },
      CacheLifecycle,
    ];

    return {
      module: CacheModule,
      global: true,
      providers,
      controllers: options.exposeMetrics === false ? [] : [CacheMetricsController],
      // CACHE_STORE 一并导出（M10 E-03：AppModule 的限流器工厂按存储端口构造令牌桶）
      exports: [CacheService, CACHE_SERVICE, CACHE_OPTIONS, CACHE_METRICS, CACHE_STORE],
    };
  }
}
