/*
 * @file QueueModule：队列与定时任务能力装配
 * @description `QueueModule.forRoot()` 按 `MQ_DRIVER` 装配驱动（memory 零依赖；bullmq 走懒加载的
 *   bullmq + ioredis）、构建运行时配置、注册 QueueService / cron 调度器 / 管理端点与指标端点，
 *   并在应用启动时扫描 `@JobHandler` / `@Cron` 完成注册。切换驱动只改配置，业务代码 diff = 0（AC-001）。
 *   执行守卫（幂等标记 + cron 分布式锁）优先复用 @fw/cache 的 CacheService（redis 驱动时天然分布式），
 *   未接入缓存时退化为进程内实现并在启动期告警（PRD-007 §8）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import {
  Global,
  Inject,
  Injectable,
  Module,
  Optional,
  type DynamicModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type Provider,
} from '@nestjs/common';
import { DiscoveryModule, DiscoveryService, MetadataScanner } from '@nestjs/core';
import { CACHE_SERVICE, type CacheService } from '@fw/cache';
import { loadEnv } from '@fw/config';
import { Logger } from '@fw/logger';
import { CacheGuardStore, MemoryGuardStore, type QueueGuardStore } from './guard-store.js';
import { scanCrons, scanJobHandlers } from './discovery.js';
import { parseBackoffSequence } from './duration.js';
import { MemoryQueueDriver } from './drivers/memory.driver.js';
import { BullmqQueueDriver } from './drivers/bullmq.driver.js';
import { QueueMetrics } from './metrics.js';
import { QueueAdminController } from './admin.controller.js';
import { QueueMetricsController } from './metrics.controller.js';
import { QueueService } from './queue.service.js';
import { CronScheduler } from './scheduler.js';
import { QUEUE_ALERT, QUEUE_DRIVER, QUEUE_GUARD, QUEUE_METRICS, QUEUE_OPTIONS, QUEUE_SCHEDULER, QUEUE_SERVICE } from './tokens.js';
import type { DeadLetterRecord, JobDriverName, QueueRuntimeOptions } from './types.js';
import type { QueueDriverPort } from './driver.port.js';

const logger = Logger.for('queue');

/** 环境变量结构子集（真实 Env 天然满足；测试可传桩对象） */
export interface QueueEnvLike {
  APP_ENV?: string;
  MQ_DRIVER?: JobDriverName;
  MQ_URL?: string;
  MQ_PREFIX?: string;
  MQ_CONCURRENCY?: number;
  MQ_MAX_ATTEMPTS?: number;
  MQ_BACKOFF?: string;
  MQ_JOB_TIMEOUT?: number;
  MQ_CRON_ENABLED?: boolean;
  MQ_RATE_LIMIT?: number;
  MQ_DEAD_LETTER_MAX?: number;
  /** 死信分页每页条数上限（M10/E-16：pageDeadLetters 的 pageSize 钳制上界） */
  MQ_DEAD_LETTER_PAGE_MAX?: number;
  MQ_SHUTDOWN_TIMEOUT?: number;
  /** bullmq 失速检测间隔（毫秒；0 表示用 bullmq 默认 30s） */
  MQ_STALLED_MS?: number;
  /** bullmq 缺 MQ_URL 时的回退来源 */
  CACHE_URL?: string;
}

/** 各项默认值（与 @fw/config 的 env-schema 保持一致，仅用于桩对象兜底） */
const DEFAULTS = {
  driver: 'memory' as JobDriverName,
  concurrency: 10,
  maxAttempts: 4,
  backoff: '1000,5000,30000',
  jobTimeout: 60,
  cronEnabled: true,
  rateLimit: 0,
  deadLetterMax: 1000,
  deadLetterPageMax: 200,
  shutdownTimeout: 30,
  stalledInterval: 30_000,
};

/**
 * 由环境变量构建队列运行时配置
 * @param env 环境变量来源
 * @param overrides 覆盖项（优先级最高）
 * @returns QueueRuntimeOptions
 */
export function buildQueueOptions(env: QueueEnvLike, overrides: Partial<QueueRuntimeOptions> = {}): QueueRuntimeOptions {
  const driver = overrides.driver ?? env.MQ_DRIVER ?? DEFAULTS.driver;
  const backoffRaw = env.MQ_BACKOFF ?? DEFAULTS.backoff;
  return {
    driver,
    // bullmq 的连接串优先取 MQ_URL，未配置时回退 CACHE_URL（多数项目共用同一 Redis）
    url: overrides.url ?? (env.MQ_URL && env.MQ_URL.length > 0 ? env.MQ_URL : env.CACHE_URL),
    // 前缀留空时自动取 `fw:<APP_ENV>`，避免多环境串队列
    prefix: overrides.prefix ?? (env.MQ_PREFIX && env.MQ_PREFIX.length > 0 ? env.MQ_PREFIX : `fw:${env.APP_ENV ?? 'default'}`),
    concurrency: overrides.concurrency ?? env.MQ_CONCURRENCY ?? DEFAULTS.concurrency,
    maxAttempts: overrides.maxAttempts ?? env.MQ_MAX_ATTEMPTS ?? DEFAULTS.maxAttempts,
    backoff: overrides.backoff ?? parseBackoffSequence(backoffRaw),
    jobTimeoutMs: overrides.jobTimeoutMs ?? Math.round((env.MQ_JOB_TIMEOUT ?? DEFAULTS.jobTimeout) * 1000),
    cronEnabled: overrides.cronEnabled ?? env.MQ_CRON_ENABLED ?? DEFAULTS.cronEnabled,
    rateLimit: overrides.rateLimit ?? env.MQ_RATE_LIMIT ?? DEFAULTS.rateLimit,
    deadLetterMax: overrides.deadLetterMax ?? env.MQ_DEAD_LETTER_MAX ?? DEFAULTS.deadLetterMax,
    deadLetterPageSizeMax: overrides.deadLetterPageSizeMax ?? env.MQ_DEAD_LETTER_PAGE_MAX ?? DEFAULTS.deadLetterPageMax,
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? Math.round((env.MQ_SHUTDOWN_TIMEOUT ?? DEFAULTS.shutdownTimeout) * 1000),
    stalledIntervalMs:
      overrides.stalledIntervalMs ?? (env.MQ_STALLED_MS !== undefined ? Math.max(0, Math.round(env.MQ_STALLED_MS)) : DEFAULTS.stalledInterval),
  };
}

/** 就绪探针（结构与 @fw/core 的 ReadinessProbe 一致，避免 core 与本包互相依赖） */
export interface QueueReadinessProbe {
  /** 探针名 */
  name: string;
  /** 探测 */
  check: () => Promise<boolean>;
  /** 装配完成后绑定队列服务 */
  markReady(queue: QueueService): void;
}

/**
 * 创建队列就绪探针（供 FwCoreModule.forRoot({ readinessProbes: [probe] })）
 * @returns 可变探针：未装配前判定为未就绪
 */
export function createQueueReadinessProbe(): QueueReadinessProbe {
  let service: QueueService | undefined;
  return {
    name: 'queue',
    check: async () => (service ? service.ping() : false),
    markReady(next: QueueService): void {
      service = next;
    },
  };
}

/** forRoot 入参 */
export interface QueueModuleOptions {
  /** 环境变量来源，缺省读进程环境 */
  env?: QueueEnvLike;
  /** 直接覆盖运行时配置（测试用） */
  overrides?: Partial<QueueRuntimeOptions>;
  /** 自定义驱动（测试注入 fake；传入后忽略 MQ_DRIVER） */
  driver?: QueueDriverPort;
  /** 自定义守卫存储（测试注入；传入后忽略 CACHE_SERVICE） */
  guard?: QueueGuardStore;
  /** 指标采集器（缺省自建） */
  metrics?: QueueMetrics;
  /** 死信告警回调（可选 webhook） */
  alert?: (record: DeadLetterRecord, reason: string) => void;
  /** 是否注册 /metrics/queue 指标端点（默认 true） */
  exposeMetrics?: boolean;
  /** 是否注册队列管理端点（默认 true） */
  exposeAdmin?: boolean;
  /** 就绪探针实例（与 FwCoreModule 共用同一对象） */
  readinessProbe?: QueueReadinessProbe;
  /** 是否跳过 @JobHandler / @Cron 自动扫描（测试用） */
  disableDiscovery?: boolean;
}

/**
 * 队列生命周期：启动时扫描注册并开始消费，停机时先停调度再等在途任务
 */
@Injectable()
export class QueueLifecycle implements OnApplicationBootstrap, OnApplicationShutdown {
  constructor(
    @Inject(QUEUE_SERVICE) private readonly queue: QueueService,
    @Inject(QUEUE_SCHEDULER) private readonly scheduler: CronScheduler,
    @Inject(QUEUE_OPTIONS) private readonly options: QueueRuntimeOptions,
    @Inject(QUEUE_GUARD) private readonly guard: QueueGuardStore,
    @Optional() private readonly discovery?: DiscoveryService,
    @Optional() private readonly scanner?: MetadataScanner,
  ) {}

  /** 应用启动：注册处理器与定时任务 → 开始消费 → 启动调度 */
  async onApplicationBootstrap(): Promise<void> {
    if (this.discovery && this.scanner) {
      const providers = this.discovery.getProviders();
      for (const scanned of scanJobHandlers(providers)) {
        this.queue.register(scanned.name, (payload, ctx) => boundHandle(scanned.instance, payload, ctx), scanned.idempotent);
      }
      for (const cron of scanCrons(providers, this.scanner)) {
        this.scheduler.register(cron.name, cron.expression, cron.handler, cron.options);
      }
    }
    // 定时任务在多副本下依赖分布式锁：进程内锁（memory 缓存驱动）会退化为「每个副本各跑一次」
    if (this.scheduler.enabled && !this.guard.distributed) {
      const names = this.scheduler.names();
      if (names.length > 0) {
        logger.warn('定时任务未启用分布式互斥：当前执行守卫为进程内实现，多副本部署会重复执行', {
          driver: this.options.driver,
          cacheDistributed: this.guard.distributed,
          crons: names,
        });
      }
    }
    await this.queue.start();
    this.scheduler.start();
  }

  /** 应用停机：先停调度（不再产生新触发）→ 再等队列在途任务 */
  async onApplicationShutdown(): Promise<void> {
    await this.scheduler.stop();
    await this.queue.shutdown();
  }
}

/** 调用实例上的 handle（保持 this 绑定） */
function boundHandle(instance: object, payload: unknown, ctx: unknown): Promise<void> | void {
  return (instance as { handle: (payload: unknown, ctx: unknown) => Promise<void> | void }).handle(payload, ctx);
}

/**
 * 队列全局模块
 */
@Global()
@Module({})
export class QueueModule {
  /**
   * 装配队列能力
   * @param options 环境、覆盖项、自定义驱动 / 守卫 / 指标与开关
   * @returns 动态模块定义
   */
  static forRoot(options: QueueModuleOptions = {}): DynamicModule {
    const env = options.env ?? (loadEnv() as QueueEnvLike);
    const runtime = buildQueueOptions(env, options.overrides);

    const providers: Provider[] = [
      {
        provide: QUEUE_DRIVER,
        useFactory: (guard: QueueGuardStore): QueueDriverPort => {
          if (options.driver) return options.driver;
          if (runtime.driver === 'bullmq') {
            return new BullmqQueueDriver({
              url: runtime.url,
              prefix: runtime.prefix,
              concurrency: runtime.concurrency,
              rateLimit: runtime.rateLimit,
              deadLetterMax: runtime.deadLetterMax,
              stalledIntervalMs: runtime.stalledIntervalMs,
            });
          }
          if (runtime.driver !== 'memory') {
            throw new Error(`暂不支持的队列驱动：${runtime.driver}（M7 提供 memory / bullmq；kafka 仅预留端口）`);
          }
          return new MemoryQueueDriver({
            concurrency: runtime.concurrency,
            rateLimit: runtime.rateLimit,
            deadLetterMax: runtime.deadLetterMax,
          });
        },
        inject: [QUEUE_GUARD],
      },
      {
        provide: QUEUE_GUARD,
        useFactory: (cache?: CacheService): QueueGuardStore => options.guard ?? (cache ? new CacheGuardStore(cache) : new MemoryGuardStore()),
        inject: [{ token: CACHE_SERVICE, optional: true }],
      },
      { provide: QUEUE_OPTIONS, useValue: runtime },
      { provide: QUEUE_METRICS, useValue: options.metrics ?? new QueueMetrics() },
      { provide: QUEUE_ALERT, useValue: options.alert },
      {
        provide: QueueService,
        useFactory: (
          driver: QueueDriverPort,
          guard: QueueGuardStore,
          metrics: QueueMetrics,
          alert: ((record: DeadLetterRecord, reason: string) => void) | undefined,
        ): QueueService => {
          const service = new QueueService({
            driver,
            options: runtime,
            guard,
            metrics,
            alert,
          });
          options.readinessProbe?.markReady(service);
          return service;
        },
        inject: [QUEUE_DRIVER, QUEUE_GUARD, QUEUE_METRICS, QUEUE_ALERT],
      },
      { provide: QUEUE_SERVICE, useExisting: QueueService },
      {
        provide: QUEUE_SCHEDULER,
        useFactory: (guard: QueueGuardStore, metrics: QueueMetrics): CronScheduler =>
          new CronScheduler({
            guard,
            metrics,
            enabled: runtime.cronEnabled,
            defaultTimeoutMs: runtime.jobTimeoutMs,
          }),
        inject: [QUEUE_GUARD, QUEUE_METRICS],
      },
      QueueLifecycle,
    ];

    const controllers: Array<new (...args: never[]) => unknown> = [];
    if (options.exposeMetrics !== false) controllers.push(QueueMetricsController);
    if (options.exposeAdmin !== false) controllers.push(QueueAdminController);

    return {
      module: QueueModule,
      global: true,
      imports: options.disableDiscovery ? [] : [DiscoveryModule],
      providers,
      controllers: controllers as never[],
      exports: [QueueService, QUEUE_SERVICE, QUEUE_OPTIONS, QUEUE_METRICS, QUEUE_SCHEDULER, QUEUE_GUARD],
    };
  }
}
