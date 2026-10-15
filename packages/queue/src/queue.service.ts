/*
 * @file QueueService：统一队列服务（框架唯一对外队列入口）
 * @description 在驱动端口之上实现 PRD-007 的业务语义：
 *   处理器注册（`@JobHandler` 或 `register`）、派发（默认选项合并与选项校验）、
 *   执行包装（traceId 日志、单任务超时、幂等判定与置位、指标采集）、
 *   死信回调（计数 / 告警 / 可插拔 webhook）以及管理面（统计 / 死信 / 暂停 / 清空 / 重放）。
 *   驱动的重试、退避与死信归档由驱动实现，本类只保证「同一份 Job 代码在两种驱动下行为一致」。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo 死信分页：新增 countDeadLetters / pageDeadLetters，
 *   listDeadLetters 透传窗口（体验债：死信列表无分页）
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增 updateRuntimeOptions——mq.concurrency/rateLimit 经配置中心订阅热更（下推驱动）
 * @module @fw/queue
 */

import { hashArgs } from '@fw/cache';
import { Logger, getTraceId } from '@fw/logger';
import { withTimeout } from './async.js';
import { currentTraceparent, parentFromTraceparent, withConsumerSpan, withProducerSpan } from './trace.js';
import type { JobRunner, QueueDriverPort } from './driver.port.js';
import { readIdempotentMeta, readJobHandlerName, type IdempotentMeta } from './decorators.js';
import { JobNotRegisteredError, JobOptionError, JobTimeoutError } from './errors.js';
import { parseDurationMs } from './duration.js';
import type { QueueGuardStore } from './guard-store.js';
import { QueueMetrics } from './metrics.js';
import type {
  DeadLetterRecord,
  DeadLetterWindow,
  JobContext,
  JobHandle,
  JobHandlerFn,
  JobLogger,
  JobOptions,
  JobRecord,
  QueueMetricsSnapshot,
  QueueRuntimeOptions,
  QueueStats,
} from './types.js';

const logger = Logger.for('queue');

/** 默认队列名（未显式指定 options.queue 时使用） */
export const DEFAULT_QUEUE_NAME = 'default';

/** 幂等窗口默认值（秒） */
const DEFAULT_IDEMPOTENCY_TTL_SECONDS = 3600;

/** 已注册处理器条目 */
interface HandlerEntry {
  /** 处理函数 */
  fn: JobHandlerFn<unknown>;
  /** 幂等元数据（`@Idempotent`） */
  idempotent?: IdempotentMeta;
}

/** 构造参数 */
export interface QueueServiceDeps {
  /** 队列驱动（memory / bullmq） */
  driver: QueueDriverPort;
  /** 运行时配置 */
  options: QueueRuntimeOptions;
  /** 执行守卫存储（幂等标记 + cron 锁） */
  guard: QueueGuardStore;
  /** 指标采集器（缺省自建） */
  metrics?: QueueMetrics;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 死信告警回调（可选 webhook） */
  alert?: (record: DeadLetterRecord, reason: string) => void;
}

/**
 * 统一队列服务
 */
export class QueueService implements JobRunner {
  private readonly handlers = new Map<string, HandlerEntry>();

  private readonly driver: QueueDriverPort;

  private readonly opt: QueueRuntimeOptions;

  private readonly guard: QueueGuardStore;

  private readonly metrics: QueueMetrics;

  private readonly now: () => number;

  private readonly alert: ((record: DeadLetterRecord, reason: string) => void) | undefined;

  /**
   * @param deps 驱动、配置、守卫存储与可选指标 / 时钟 / 告警回调
   */
  constructor(deps: QueueServiceDeps) {
    this.driver = deps.driver;
    this.opt = deps.options;
    this.guard = deps.guard;
    this.metrics = deps.metrics ?? new QueueMetrics();
    this.now = deps.now ?? (() => Date.now());
    this.alert = deps.alert;
  }

  /**
   * 运行时更新并发与限速（M9/PRD-009 FR-09：由配置中心 onChange 订阅调用，禁止业务侧自行轮询）
   *
   * 生效路径：服务侧选项对象就地更新 + 下推驱动（memory 即时生效；bullmq concurrency 即时、
   * rateLimit 随消费器重建生效并记 WARN）。合法性由配置中心管道保证，本方法不二次校验。
   * @param patch 待更新字段（并发 / 限速）
   */
  updateRuntimeOptions(patch: { concurrency?: number; rateLimit?: number }): void {
    Object.assign(this.opt, patch);
    this.driver.applyRuntimeOptions?.(patch);
    logger.info('队列运行时选项已热更', { ...patch });
  }

  /** 当前驱动名 */
  get driverName(): string {
    return this.driver.kind;
  }

  /** 运行时配置（调度器与管理面复用） */
  get options(): QueueRuntimeOptions {
    return this.opt;
  }

  /**
   * 注册处理器
   * @param name 任务名
   * @param handler 处理函数
   * @param idempotent 幂等元数据（`@Idempotent` 扫描结果）
   */
  register<T>(name: string, handler: JobHandlerFn<T>, idempotent?: IdempotentMeta): void {
    if (!name) throw new JobOptionError('任务名不能为空');
    if (this.handlers.has(name)) {
      logger.warn('任务处理器被覆盖注册', { name });
    }
    this.handlers.set(name, { fn: handler as JobHandlerFn<unknown>, idempotent });
    // 启动期即告知驱动默认队列：否则新消费进程在首次 dispatch 前不建消费器，
    // 失速检测器不存在，被强杀进程遗留的在途任务永远无人恢复（TC-JOB-008）
    this.driver.ensureQueue(DEFAULT_QUEUE_NAME);
    logger.debug('任务处理器已注册', { name, idempotent: idempotent !== undefined });
  }

  /**
   * 按 `@JobHandler` 元数据注册处理器实例
   * @param instance 标注了 `@JobHandler` 的类实例（需实现 `handle`）
   * @returns 注册的任务名；实例未标注时返回 undefined
   */
  registerInstance(instance: object): string | undefined {
    const name = readJobHandlerName(instance.constructor);
    if (!name) return undefined;
    const handle = (instance as { handle?: JobHandlerFn<unknown> }).handle;
    if (typeof handle !== 'function') {
      throw new JobOptionError(`任务类 ${instance.constructor.name} 未实现 handle(payload, ctx)`);
    }
    const idempotent = readIdempotentMeta(undefined, instance.constructor);
    this.register(name, handle.bind(instance), idempotent);
    return name;
  }

  /** 是否已注册某任务 */
  has(name: string): boolean {
    return this.handlers.has(name);
  }

  /** 已注册任务名列表（管理面与冒烟断言用） */
  registeredNames(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * 派发任务
   * @param name 任务名
   * @param payload 业务载荷（需可 JSON 序列化）
   * @param options 任务选项
   * @returns 入队句柄
   */
  async dispatch<T>(name: string, payload: T, options: JobOptions = {}): Promise<JobHandle> {
    const record = this.buildRecord(name, payload, options);
    this.driver.ensureQueue(record.queue);
    // PRODUCER span：dispatch 期间生成 traceparent 写入记录，随任务过线供消费侧续接链路
    await withProducerSpan(record.name, record.queue, async () => {
      record.traceparent = currentTraceparent();
      await this.driver.enqueue(record);
    });
    this.metrics.dispatch();
    logger.debug('任务入队', {
      jobId: record.id,
      name: record.name,
      queue: record.queue,
      runAt: new Date(record.runAt).toISOString(),
      delayMs: Math.max(0, record.runAt - this.now()),
      idempotencyKey: record.idempotencyKey,
    });
    return { id: record.id, name: record.name, queue: record.queue, runAt: new Date(record.runAt) };
  }

  /**
   * 执行任务（`JobRunner` 实现，由驱动调用）
   * @param record 任务记录
   */
  async run(record: JobRecord): Promise<void> {
    const entry = this.handlers.get(record.name);
    if (!entry) {
      this.metrics.failure(0);
      throw new JobNotRegisteredError(record.name);
    }
    const started = this.now();
    const guardKey = this.idempotencyKeyOf(record, entry);
    if (guardKey) {
      const ttl = record.idempotencyTtlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS;
      if (await this.guard.hasMarker(guardKey)) {
        this.metrics.idempotent();
        logger.debug('幂等命中，跳过执行', { jobId: record.id, name: record.name, idempotencyKey: guardKey });
        return;
      }
      // 并发重复：同一幂等键正在执行时放弃本次（避免与执行中的那次重复产生副作用）
      const lock = await this.guard.acquireLock(`idem:${guardKey}`, ttl);
      if (!lock) {
        this.metrics.idempotent();
        logger.debug('幂等键正在执行中，跳过重复任务', { jobId: record.id, name: record.name, idempotencyKey: guardKey });
        return;
      }
      try {
        await this.invoke(record, entry);
        await this.guard.markDone(guardKey, ttl);
        this.metrics.success(this.now() - started);
      } catch (error) {
        this.metrics.failure(this.now() - started);
        throw error;
      } finally {
        await lock.release();
      }
      return;
    }

    try {
      await this.invoke(record, entry);
      this.metrics.success(this.now() - started);
    } catch (error) {
      this.metrics.failure(this.now() - started);
      throw error;
    }
  }

  /** @inheritdoc */
  onDeadLetter(record: JobRecord, reason: string): void {
    this.metrics.deadLetter();
    const view: DeadLetterRecord = {
      id: record.id,
      name: record.name,
      queue: record.queue,
      payload: record.payload,
      attemptsMade: record.attemptsMade,
      reason,
      failedAt: new Date(this.now()).toISOString(),
      enqueuedAt: new Date(record.enqueuedAt).toISOString(),
    };
    logger.error('任务进入死信', {
      jobId: view.id,
      name: view.name,
      queue: view.queue,
      attemptsMade: view.attemptsMade,
      reason: view.reason,
    });
    if (this.alert) {
      try {
        this.alert(view, reason);
      } catch (error) {
        // 告警通道故障不得影响队列本身
        logger.warn('死信告警回调失败', { jobId: view.id, error: error instanceof Error ? error.message : String(error) });
      }
    }
  }

  /** 启动消费（模块装配期调用） */
  async start(): Promise<void> {
    await this.driver.start(this);
  }

  /**
   * 优雅停机：等待在途任务（超时后 memory 重新入队 / bullmq 交由失速检测恢复）
   * @returns 停机时未完成的在途任务数
   */
  async shutdown(): Promise<number> {
    const inflight = await this.driver.close(this.opt.shutdownTimeoutMs);
    logger.info('队列已停机', { driver: this.driver.kind, inflight, timeoutMs: this.opt.shutdownTimeoutMs });
    return inflight;
  }

  /** 队列统计 */
  async stats(): Promise<QueueStats> {
    return this.driver.stats();
  }

  /** 指标快照 */
  metricsSnapshot(): QueueMetricsSnapshot {
    return this.metrics.snapshot(this.driver.kind);
  }

  /** 指标采集器（供调度器共用同一实例） */
  get metricsCollector(): QueueMetrics {
    return this.metrics;
  }

  /** 执行守卫存储（供调度器复用分布式锁） */
  get guardStore(): QueueGuardStore {
    return this.guard;
  }

  /**
   * 死信列表
   * @param queue 队列名（缺省全部）
   * @param window 分页窗口（缺省全量）
   */
  async listDeadLetters(queue?: string, window?: DeadLetterWindow): Promise<DeadLetterRecord[]> {
    return this.driver.listDeadLetters(queue, window);
  }

  /**
   * 死信条数（分页 total 用）
   * @param queue 队列名（缺省全部）
   */
  async countDeadLetters(queue?: string): Promise<number> {
    return this.driver.countDeadLetters(queue);
  }

  /**
   * 死信分页（管理面入口）
   *
   * 页大小上限 200 与列表查询约定（api-spec §1.5）一致；越界值收敛到合法区间而不是报错——
   * 运维页面的页码来自前端控件，因分页参数把整个管理页打成 400 得不偿失。
   *
   * @param queue 队列名（缺省全部）
   * @param page 页码（从 1 开始）
   * @param pageSize 每页条数
   */
  async pageDeadLetters(
    queue: string | undefined,
    page: number,
    pageSize: number,
  ): Promise<{ total: number; items: DeadLetterRecord[]; page: number; pageSize: number }> {
    const safePage = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
    const safeSize = Number.isFinite(pageSize) ? Math.min(200, Math.max(1, Math.floor(pageSize))) : 20;
    const [total, items] = await Promise.all([
      this.driver.countDeadLetters(queue),
      this.driver.listDeadLetters(queue, { offset: (safePage - 1) * safeSize, limit: safeSize }),
    ]);
    return { total, items, page: safePage, pageSize: safeSize };
  }

  /**
   * 重放单条死信
   * @param id 任务 ID
   */
  async requeueDeadLetter(id: string): Promise<boolean> {
    return this.driver.requeueDeadLetter(id);
  }

  /**
   * 清理死信
   * @param queue 队列名（缺省全部）
   */
  async purgeDeadLetters(queue?: string): Promise<number> {
    return this.driver.purgeDeadLetters(queue);
  }

  /**
   * 暂停消费
   * @param queue 队列名（缺省全部）
   */
  async pause(queue?: string): Promise<void> {
    await this.driver.pause(queue);
    logger.info('队列已暂停', { queue: queue ?? '全部' });
  }

  /**
   * 恢复消费
   * @param queue 队列名（缺省全部）
   */
  async resume(queue?: string): Promise<void> {
    await this.driver.resume(queue);
    logger.info('队列已恢复', { queue: queue ?? '全部' });
  }

  /**
   * 清空等待中的任务
   * @param queue 队列名（缺省全部）
   */
  async drain(queue?: string): Promise<number> {
    return this.driver.drain(queue);
  }

  /**
   * 取消尚未执行的任务
   * @param jobId 任务 ID
   */
  async cancel(jobId: string): Promise<boolean> {
    return this.driver.cancel(jobId);
  }

  /** 驱动可用性探测（注册为 `/ready` 探针） */
  async ping(): Promise<boolean> {
    return this.driver.ping();
  }

  // ---------------- 内部实现 ----------------

  /** 组装任务记录（默认选项合并 + 选项校验） */
  private buildRecord<T>(name: string, payload: T, options: JobOptions): JobRecord {
    if (!name) throw new JobOptionError('任务名不能为空');
    const entry = this.handlers.get(name);
    const attempts = options.attempts ?? this.opt.maxAttempts;
    if (!Number.isInteger(attempts) || attempts < 1) {
      throw new JobOptionError(`attempts 必须为 >=1 的整数：${String(options.attempts)}`);
    }
    const timeoutSeconds = options.timeoutSeconds ?? this.opt.jobTimeoutMs / 1000;
    if (!Number.isFinite(timeoutSeconds) || timeoutSeconds < 0) {
      throw new JobOptionError(`timeoutSeconds 必须为非负数：${String(options.timeoutSeconds)}`);
    }
    const runAt = options.runAt ? options.runAt.getTime() : this.now() + parseDurationMs(options.delay ?? 0);
    const idempotencyKey = options.idempotencyKey ?? this.deriveIdempotencyKey(name, payload, entry);
    return {
      id: `job-${this.nextId()}`,
      queue: options.queue ?? DEFAULT_QUEUE_NAME,
      name,
      payload,
      attempts,
      attemptsMade: 0,
      backoff: options.backoff ?? this.opt.backoff,
      runAt,
      priority: options.priority ?? 0,
      timeoutMs: Math.round(timeoutSeconds * 1000),
      idempotencyKey,
      idempotencyTtlSeconds: options.idempotencyTtlSeconds ?? entry?.idempotent?.ttlSeconds ?? DEFAULT_IDEMPOTENCY_TTL_SECONDS,
      enqueuedAt: this.now(),
    };
  }

  /** 由 `@Idempotent` 元数据推导幂等键（未标注则返回 undefined） */
  private deriveIdempotencyKey(name: string, payload: unknown, entry: HandlerEntry | undefined): string | undefined {
    if (!entry?.idempotent) return undefined;
    if (entry.idempotent.key) return entry.idempotent.key(payload);
    return `${name}:${hashArgs([payload])}`;
  }

  /** 执行时读取幂等键（记录内已展开，无需再推导） */
  private idempotencyKeyOf(record: JobRecord, entry: HandlerEntry): string | undefined {
    if (record.idempotencyKey) return record.idempotencyKey;
    return this.deriveIdempotencyKey(record.name, record.payload, entry);
  }

  /** 调用处理器（带超时与上下文日志） */
  private async invoke(record: JobRecord, entry: HandlerEntry): Promise<void> {
    const ctx = this.buildContext(record);
    // CONSUMER span：从记录 traceparent 续接派发链路（缺失时按活跃上下文/根处理）
    await withConsumerSpan(record.name, record.queue, parentFromTraceparent(record.traceparent), () =>
      withTimeout(
        () => entry.fn(record.payload, ctx),
        record.timeoutMs,
        () => {
          this.metrics.timeout();
          return new JobTimeoutError(record.name, record.timeoutMs);
        },
      ),
    );
  }

  /** 构造执行上下文 */
  private buildContext(record: JobRecord): JobContext<unknown> {
    const traceId = readTraceId() ?? record.id;
    const base = logger;
    const jobLogger: JobLogger = {
      debug: (msg, ctx) => base.debug(msg, { jobId: record.id, traceId, ...ctx }),
      info: (msg, ctx) => base.info(msg, { jobId: record.id, traceId, ...ctx }),
      warn: (msg, ctx) => base.warn(msg, { jobId: record.id, traceId, ...ctx }),
      error: (msg, ctx) => base.error(msg, { jobId: record.id, traceId, ...ctx }),
    };
    return {
      jobId: record.id,
      name: record.name,
      queue: record.queue,
      attempt: record.attemptsMade,
      maxAttempts: record.attempts,
      payload: record.payload,
      traceId,
      logger: jobLogger,
    };
  }

  /** 生成任务 ID（时间戳 + 序号，跨驱动唯一） */
  private nextId(): string {
    this.idSeq++;
    return `${this.now().toString(36)}-${this.idSeq.toString(36)}`;
  }

  /** 任务序号 */
  private idSeq = 0;
}

/** 读取当前 traceId（无请求上下文或为空串时返回 undefined） */
function readTraceId(): string | undefined {
  try {
    return getTraceId() || undefined;
  } catch {
    return undefined;
  }
}
