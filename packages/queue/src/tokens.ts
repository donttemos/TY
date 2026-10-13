/*
 * @file 依赖注入令牌
 * @description @fw/queue 的可替换实现经统一 token 注入：驱动、运行时配置、指标采集器、执行守卫存储与队列服务，
 *   业务只注入 QueueService（或 QUEUE_SERVICE token），换驱动只改 MQ_DRIVER。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

/** 队列驱动（memory / bullmq，按 MQ_DRIVER 装配） */
export const QUEUE_DRIVER = Symbol('fw.queue.driver');

/** 运行时配置（由 MQ_* 环境变量构建） */
export const QUEUE_OPTIONS = Symbol('fw.queue.options');

/** 指标采集器 */
export const QUEUE_METRICS = Symbol('fw.queue.metrics');

/** 执行守卫存储（幂等标记 + cron 分布式锁；优先复用 @fw/cache，缺失时退化为进程内实现） */
export const QUEUE_GUARD = Symbol('fw.queue.guard');

/** 队列服务（与 QueueService 类 token 指向同一实例） */
export const QUEUE_SERVICE = Symbol('fw.queue.service');

/** cron 调度器 */
export const QUEUE_SCHEDULER = Symbol('fw.queue.scheduler');

/** 死信告警回调（可选；接入方可在 forRoot 传入 webhook） */
export const QUEUE_ALERT = Symbol('fw.queue.alert');
