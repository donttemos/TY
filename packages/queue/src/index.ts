/*
 * @file @fw/queue 对外入口
 * @description 统一导出队列与定时任务全部公共 API（服务、模块、装饰器、驱动、调度器、守卫存储、
 *   指标与端点、解析工具与类型），禁止从深路径引用内部文件；驱动特有类型（bullmq / ioredis）
 *   只以最小结构接口出现在 bullmq-client 中，公共导出面不暴露第三方类型。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

// ---------- 模块装配 ----------
export { QueueModule, QueueLifecycle, buildQueueOptions, createQueueReadinessProbe } from './queue.module.js';
export type { QueueEnvLike, QueueModuleOptions, QueueReadinessProbe } from './queue.module.js';
export { QUEUE_ALERT, QUEUE_DRIVER, QUEUE_GUARD, QUEUE_METRICS, QUEUE_OPTIONS, QUEUE_SCHEDULER, QUEUE_SERVICE } from './tokens.js';

// ---------- 服务与调度 ----------
export { QueueService } from './queue.service.js';
export type { QueueServiceDeps } from './queue.service.js';
export { CronScheduler } from './scheduler.js';
export type { CronSchedulerDeps } from './scheduler.js';

// ---------- 装饰器 ----------
export {
  Cron,
  Idempotent,
  JobHandler,
  META_CRON,
  META_IDEMPOTENT,
  META_JOB_HANDLER,
  readCronMeta,
  readIdempotentMeta,
  readJobHandlerName,
} from './decorators.js';
export type { CronMeta, IdempotentMeta, IdempotentOptions } from './decorators.js';

// ---------- 扫描 ----------
export { scanCrons, scanJobHandlers } from './discovery.js';
export type { MetadataScannerLike, ProviderLike, ScannedCron, ScannedHandler } from './discovery.js';

// ---------- 守卫存储 ----------
export { CacheGuardStore, MemoryGuardStore } from './guard-store.js';
export type { GuardLockHandle, QueueGuardStore } from './guard-store.js';

// ---------- 驱动 ----------
export { MemoryQueueDriver } from './drivers/memory.driver.js';
export type { MemoryDriverOptions } from './drivers/memory.driver.js';
export { BullmqQueueDriver } from './drivers/bullmq.driver.js';
export type { BullmqDriverOptions } from './drivers/bullmq.driver.js';
export { createBullConnection, loadBullmq } from './drivers/bullmq-client.js';
export type { BullJobLike, BullQueueLike, BullmqModuleLike, BullWorkerLike, RedisConnectionLike } from './drivers/bullmq-client.js';
export type { JobRunner, QueueDriverPort } from './driver.port.js';

// ---------- 指标与端点 ----------
export { QueueMetrics } from './metrics.js';
export { QueueMetricsController, QUEUE_METRICS_PATH } from './metrics.controller.js';
export { QueueAdminController, QUEUE_PERM_LIST, QUEUE_PERM_MANAGE } from './admin.controller.js';
export type { DeadLetterListResponse } from './admin.controller.js';

// ---------- 解析工具 ----------
export { CronExpression, parseCron } from './cron-expression.js';
export { backoffFor, parseBackoffSequence, parseDurationMs } from './duration.js';
export { delay, withTimeout } from './async.js';

// ---------- 异常 ----------
export {
  CronExpressionError,
  JobNotRegisteredError,
  JobOptionError,
  JobTimeoutError,
  PermanentJobError,
  QueueUnavailableError,
} from './errors.js';

// ---------- 类型 ----------
export type {
  CronOptions,
  CronSnapshot,
  DeadLetterRecord,
  Duration,
  Job,
  JobContext,
  JobDriverName,
  JobHandle,
  JobHandlerFn,
  JobLogger,
  JobOptions,
  JobRecord,
  JobState,
  QueueMetricsSnapshot,
  QueueRuntimeOptions,
  QueueStats,
  QueueStatsItem,
} from './types.js';
