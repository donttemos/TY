/*
 * @file TransportModule：传输能力装配
 * @description `TransportModule.forRoot()` 按 `TRANSPORT_DRIVER` 装配驱动（in-process 零依赖；
 *   redis 走懒加载的 ioredis）、构建运行时配置、注册 TransportService，并在应用启动时扫描
 *   `@TransportHandler` 完成注册。切换驱动只改配置，业务代码 diff = 0（PRD-008 FR-06 / TC-TNT-005）。
 *   角色语义：TRANSPORT_ROLE=caller 只发起调用（不起消费循环、本地不解析）；handler 只处理请求；
 *   both（默认）两者兼顾——单体部署保持 both，微服务拆分后按进程职责裁剪。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { loadEnv } from '@fw/config';
import { TransportUnavailableError } from './errors.js';
import { InProcessTransportDriver } from './drivers/in-process.driver.js';
import { RedisTransportDriver } from './drivers/redis.driver.js';
import type { RedisLike } from './drivers/redis-client.js';
import { TransportRegistry } from './registry.js';
import { TransportService } from './transport.service.js';
import { TRANSPORT_DRIVER, TRANSPORT_OPTIONS, TRANSPORT_REGISTRY, TRANSPORT_SERVICE } from './tokens.js';
import type { TransportDriverPort } from './driver.port.js';
import type { TransportDriverName, TransportRole, TransportRuntimeOptions } from './types.js';

/** 环境变量结构子集（真实 Env 天然满足；测试可传桩对象） */
export interface TransportEnvLike {
  APP_ENV?: string;
  TRANSPORT_DRIVER?: TransportDriverName;
  TRANSPORT_URL?: string;
  TRANSPORT_PREFIX?: string;
  TRANSPORT_TIMEOUT_MS?: number;
  TRANSPORT_ROLE?: TransportRole;
  TRANSPORT_INSTANCE_ID?: string;
  TRANSPORT_SHUTDOWN_TIMEOUT?: number;
  /** redis 驱动缺 TRANSPORT_URL 时的回退来源 */
  CACHE_URL?: string;
}

/** 各项默认值（与 @fw/config 的 env-schema 保持一致，仅用于桩对象兜底） */
const DEFAULTS = {
  driver: 'in-process' as TransportDriverName,
  timeoutMs: 5000,
  role: 'both' as TransportRole,
  shutdownTimeout: 10,
};

/** 默认实例标识：主机名-pid（跨进程可区分，冒烟/诊断用） */
function defaultInstanceId(): string {
  const os = globalThis.process;
  return `host-${os.pid}`;
}

/**
 * 由环境变量构建传输运行时配置
 * @param env 环境变量来源
 * @param overrides 覆盖项（优先级最高）
 * @returns TransportRuntimeOptions
 */
export function buildTransportOptions(env: TransportEnvLike, overrides: Partial<TransportRuntimeOptions> = {}): TransportRuntimeOptions {
  return {
    driver: overrides.driver ?? env.TRANSPORT_DRIVER ?? DEFAULTS.driver,
    // redis 的连接串优先取 TRANSPORT_URL，未配置时回退 CACHE_URL（多数项目共用同一 Redis）
    url: overrides.url ?? (env.TRANSPORT_URL && env.TRANSPORT_URL.length > 0 ? env.TRANSPORT_URL : env.CACHE_URL),
    // 前缀留空时自动取 `fw:<APP_ENV>`，避免多环境串数据
    prefix:
      overrides.prefix ??
      (env.TRANSPORT_PREFIX && env.TRANSPORT_PREFIX.length > 0 ? env.TRANSPORT_PREFIX : `fw:${env.APP_ENV ?? 'default'}`),
    timeoutMs: overrides.timeoutMs ?? env.TRANSPORT_TIMEOUT_MS ?? DEFAULTS.timeoutMs,
    role: overrides.role ?? env.TRANSPORT_ROLE ?? DEFAULTS.role,
    instanceId:
      overrides.instanceId ??
      (env.TRANSPORT_INSTANCE_ID && env.TRANSPORT_INSTANCE_ID.length > 0 ? env.TRANSPORT_INSTANCE_ID : defaultInstanceId()),
    shutdownTimeoutMs:
      overrides.shutdownTimeoutMs ?? Math.round((env.TRANSPORT_SHUTDOWN_TIMEOUT ?? DEFAULTS.shutdownTimeout) * 1000),
  };
}

/** 就绪探针（结构与 @fw/core 的 ReadinessProbe 一致，避免 core 与本包互相依赖） */
export interface TransportReadinessProbe {
  /** 探针名 */
  name: string;
  /** 探测 */
  check: () => Promise<boolean>;
  /** 装配完成后绑定传输服务 */
  markReady(service: TransportService): void;
}

/**
 * 创建传输就绪探针（供 FwCoreModule.forRoot({ readinessProbes: [probe] })）
 * @returns 可变探针：未装配前判定为未就绪
 */
export function createTransportReadinessProbe(): TransportReadinessProbe {
  let service: TransportService | undefined;
  return {
    name: 'transport',
    check: async () => (service ? service.ping() : false),
    markReady(next: TransportService): void {
      service = next;
    },
  };
}

/** forRoot 入参 */
export interface TransportModuleOptions {
  /** 环境变量来源，缺省读进程环境 */
  env?: TransportEnvLike;
  /** 直接覆盖运行时配置（测试用） */
  overrides?: Partial<TransportRuntimeOptions>;
  /** 自定义驱动（测试注入 fake；传入后忽略 TRANSPORT_DRIVER） */
  driver?: TransportDriverPort;
  /** 自定义 Redis 客户端工厂（测试注入 fake；仅 redis 驱动生效。subscriber 供事件面独立订阅连接） */
  createClient?: (purpose: 'caller' | 'worker' | 'subscriber') => RedisLike | Promise<RedisLike>;
  /** 就绪探针实例（与 FwCoreModule 共用同一对象） */
  readinessProbe?: TransportReadinessProbe;
  /** 是否跳过 @TransportHandler 自动扫描（测试用） */
  disableDiscovery?: boolean;
}

/**
 * 传输全局模块
 */
@Global()
@Module({})
export class TransportModule {
  /**
   * 装配传输能力
   * @param options 环境、覆盖项、自定义驱动 / 客户端工厂与开关
   * @returns 动态模块定义
   */
  static forRoot(options: TransportModuleOptions = {}): DynamicModule {
    const env = options.env ?? (loadEnv() as TransportEnvLike);
    const runtime = buildTransportOptions(env, options.overrides);

    const providers: Provider[] = [
      { provide: TRANSPORT_REGISTRY, useFactory: (): TransportRegistry => new TransportRegistry(runtime.role) },
      {
        provide: TRANSPORT_DRIVER,
        useFactory: (registry: TransportRegistry): TransportDriverPort => {
          if (options.driver) return options.driver;
          switch (runtime.driver) {
            case 'in-process':
              return new InProcessTransportDriver(registry, { instanceId: runtime.instanceId });
            case 'redis':
              return new RedisTransportDriver(registry, {
                url: runtime.url,
                prefix: runtime.prefix,
                instanceId: runtime.instanceId,
                defaultTimeoutMs: runtime.timeoutMs,
                shutdownTimeoutMs: runtime.shutdownTimeoutMs,
                createClient: options.createClient,
              });
            default:
              throw new TransportUnavailableError(
                `暂不支持的传输驱动：${runtime.driver}（M8 提供 in-process / redis；tcp / kafka 仅预留端口）`,
              );
          }
        },
        inject: [TRANSPORT_REGISTRY],
      },
      { provide: TRANSPORT_OPTIONS, useValue: runtime },
      {
        provide: TransportService,
        useFactory: (
          driver: TransportDriverPort,
          registry: TransportRegistry,
          opts: TransportRuntimeOptions,
          discovery?: DiscoveryService,
          scanner?: MetadataScanner,
        ): TransportService => {
          const service = new TransportService(driver, registry, opts, discovery, scanner);
          options.readinessProbe?.markReady(service);
          return service;
        },
        inject: [
          TRANSPORT_DRIVER,
          TRANSPORT_REGISTRY,
          TRANSPORT_OPTIONS,
          { token: DiscoveryService, optional: true },
          { token: MetadataScanner, optional: true },
        ],
      },
      { provide: TRANSPORT_SERVICE, useExisting: TransportService },
    ];

    return {
      module: TransportModule,
      global: true,
      imports: options.disableDiscovery ? [] : [DiscoveryModule],
      providers,
      exports: [TransportService, TRANSPORT_SERVICE, TRANSPORT_DRIVER, TRANSPORT_REGISTRY, TRANSPORT_OPTIONS],
    };
  }
}
