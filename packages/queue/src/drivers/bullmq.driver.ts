/*
 * @file bullmq 队列驱动（Redis，中大型系统）
 * @description 基于 bullmq 6 的驱动实现，与 memory 驱动提供一致的队列语义：
 *   延时与优先级、最大执行次数与同一套退避序列（经 `settings.backoffStrategy` 读取任务内序列）、
 *   死信（failed 集合）查询/重放/清理、暂停与恢复、并发与令牌桶限速（Worker limiter）、
 *   优雅停机（等待在途，超时交由失速检测在重启后恢复）。切换驱动只改 MQ_DRIVER（TC-JOB-001）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo 死信窗口下推到 Redis：listDeadLetters 用 getFailed(start,end) 只取当前页，
 *   新增 countDeadLetters（优先 getFailedCount，缺失时按保留上限回退计数）
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增 applyRuntimeOptions——concurrency 经 Worker 原生可变属性即时生效
 * @modified 2026-10-15 donttemo rateLimit 热更收口：限速变更时**先建新消费器（新 limiter）再关旧**，
 *   消除「待重启才生效」的固化窗口；重建失败回滚沿用旧消费器，不让热更把消费面打没。
 *   旧消费器优雅关闭（等待在途），短暂并存由 bullmq 同队列多消费器语义兜底。
 * @module @fw/queue
 */

import { Logger } from '@fw/logger';
import type { JobRunner, QueueDriverPort } from '../driver.port.js';
import { backoffFor } from '../duration.js';
import { PermanentJobError } from '../errors.js';
import type { DeadLetterRecord, DeadLetterWindow, JobDriverName, JobRecord, QueueStats, QueueStatsItem } from '../types.js';
import {
  createBullConnection,
  loadBullmq,
  type BullJobLike,
  type BullQueueLike,
  type BullmqModuleLike,
  type BullWorkerLike,
  type RedisConnectionLike,
} from './bullmq-client.js';

const logger = Logger.for('queue.bullmq');

/** bullmq 驱动选项 */
export interface BullmqDriverOptions {
  /** Redis 连接串 */
  url: string | undefined;
  /** 队列名前缀（多应用隔离） */
  prefix: string;
  /** 每队列并发数 */
  concurrency: number;
  /** 每队列每秒处理上限（0 = 不限速） */
  rateLimit: number;
  /** 死信（failed 集合）保留上限 */
  deadLetterMax: number;
  /** 失速检测间隔（毫秒；缺省/0 = 用 bullmq 默认 30s） */
  stalledIntervalMs?: number;
  /**
   * 自定义 bullmq 模块（测试注入结构桩；缺省走 `import('bullmq')`）。
   * 用于在不依赖真实 Redis 的前提下验证驱动适配层（选项映射、事件回调、统计口径）。
   */
  module?: BullmqModuleLike;
  /** 自定义连接（测试注入结构桩；缺省按 url 建 ioredis 连接） */
  connection?: RedisConnectionLike;
}

/** bullmq 状态集合 → 框架统计字段 */
const WAITING_TYPES = ['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children'];

/**
 * Redis 队列驱动（bullmq）
 */
export class BullmqQueueDriver implements QueueDriverPort {
  /** @inheritdoc */
  readonly kind: JobDriverName = 'bullmq';

  private readonly queues = new Map<string, BullQueueLike>();

  private readonly workers = new Map<string, BullWorkerLike>();

  /** 进行中的消费器创建（并发防重） */
  private readonly creating = new Map<string, Promise<void>>();

  /** 已知队列名（含尚未建立连接的） */
  private readonly known = new Set<string>();

  private mod: BullmqModuleLike | undefined;

  private connection: RedisConnectionLike | undefined;

  private runner: JobRunner | undefined;

  private started = false;

  /**
   * @param options 连接串、前缀、并发、限速与死信上限
   */
  constructor(private readonly options: BullmqDriverOptions) {}

  /** @inheritdoc */
  applyRuntimeOptions(patch: { concurrency?: number; rateLimit?: number }): void {
    const prevRateLimit = this.options.rateLimit;
    Object.assign(this.options, patch);
    if (patch.concurrency !== undefined) {
      // bullmq Worker 的 concurrency 是原生可变属性：即时收敛在途消费循环
      for (const [name, worker] of this.workers) {
        worker.concurrency = patch.concurrency;
        logger.debug('消费器并发已热更', { queue: name, concurrency: patch.concurrency });
      }
    }
    if (patch.rateLimit !== undefined && patch.rateLimit !== prevRateLimit) {
      // limiter 随 Worker 创建固化、运行时不可变 → 重建消费器生效（先建新再关旧，见 rebuildWorkers）
      void this.rebuildWorkers().catch((error: unknown) => {
        logger.error('限速热更重建流程异常', { rateLimit: patch.rateLimit, error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  /**
   * 消费器重建（限速热更的生效路径）：**先建新（携带新 limiter）再关旧**——
   * 新旧短暂并存（bullmq 同队列多消费器合法），避免重建期间的消费空窗；
   * 旧消费器优雅关闭（等待在途，不强制），在途任务完成语义不变。
   * 单队列重建失败时回滚登记旧消费器继续消费，不让热更把消费面打没。
   */
  private async rebuildWorkers(): Promise<void> {
    for (const name of [...this.workers.keys()]) {
      const stale = this.workers.get(name);
      if (!stale) continue;
      this.workers.delete(name);
      try {
        await this.ensureWorker(name);
      } catch (error) {
        this.workers.set(name, stale);
        logger.error('消费器限速热更重建失败，沿用旧消费器（旧 limiter 语义不变）', {
          queue: name,
          rateLimit: this.options.rateLimit,
          error: error instanceof Error ? error.message : String(error),
        });
        continue;
      }
      logger.info('消费器已按新限速重建', { queue: name, rateLimit: this.options.rateLimit });
      void stale.close().catch(() => undefined);
    }
  }

  /** @inheritdoc */
  async start(runner: JobRunner): Promise<void> {
    this.runner = runner;
    this.started = true;
    await this.ensureReady();
    for (const name of this.known) await this.ensureWorker(name);
    logger.info('队列消费已启动', {
      driver: this.kind,
      concurrency: this.options.concurrency,
      rateLimit: this.options.rateLimit,
      queues: [...this.known],
    });
  }

  /** @inheritdoc */
  ensureQueue(name: string): void {
    this.known.add(name);
    if (this.started && !this.workers.has(name)) {
      void this.ensureWorker(name).catch((error: unknown) => {
        logger.error('队列消费器启动失败', { queue: name, error: error instanceof Error ? error.message : String(error) });
      });
    }
  }

  /** @inheritdoc */
  async enqueue(record: JobRecord): Promise<void> {
    const queue = await this.getQueue(record.queue);
    await queue.add(record.name, record, {
      jobId: record.id,
      attempts: record.attempts,
      delay: Math.max(0, record.runAt - Date.now()),
      ...(record.priority > 0 ? { priority: record.priority } : {}),
      backoff: { type: 'fw-sequence' },
      removeOnComplete: { count: 1000 },
      removeOnFail: false,
    });
  }

  /** @inheritdoc */
  async cancel(jobId: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const job = await queue.getJob(jobId);
      if (!job) continue;
      const state = await job.getState();
      if (state === 'active' || state === 'completed') return false;
      await job.remove();
      return true;
    }
    return false;
  }

  /** @inheritdoc */
  async pause(queue?: string): Promise<void> {
    for (const [name, instance] of await this.targets(queue)) {
      await instance.pause();
      await this.workers.get(name)?.pause();
    }
  }

  /** @inheritdoc */
  async resume(queue?: string): Promise<void> {
    for (const [name, instance] of await this.targets(queue)) {
      await instance.resume();
      await this.workers.get(name)?.resume();
    }
  }

  /** @inheritdoc */
  async drain(queue?: string): Promise<number> {
    let removed = 0;
    for (const [, instance] of await this.targets(queue)) {
      const before = await instance.getJobCounts(...WAITING_TYPES);
      await instance.drain(true);
      const waiting = WAITING_TYPES.reduce((acc, type) => acc + (before[type] ?? 0), 0);
      removed += waiting;
    }
    return removed;
  }

  /** @inheritdoc */
  async stats(queueNames?: readonly string[]): Promise<QueueStats> {
    const names = queueNames && queueNames.length > 0 ? [...queueNames] : [...this.known];
    const queues: QueueStatsItem[] = [];
    let paused = false;
    for (const name of names) {
      const instance = await this.getQueue(name);
      const counts = await instance.getJobCounts(...WAITING_TYPES, 'active', 'completed', 'failed');
      const waiting = WAITING_TYPES.reduce((acc, type) => acc + (counts[type] ?? 0), 0);
      const active = counts.active ?? 0;
      const isPaused = await instance.isPaused();
      paused = paused || isPaused;
      queues.push({
        name,
        waiting,
        active,
        completed: counts.completed ?? 0,
        deadLetter: counts.failed ?? 0,
        backlog: waiting + active,
        concurrency: this.options.concurrency,
        rateLimit: this.options.rateLimit,
      });
    }
    const totals = queues.reduce(
      (acc, item) => ({
        waiting: acc.waiting + item.waiting,
        active: acc.active + item.active,
        completed: acc.completed + item.completed,
        deadLetter: acc.deadLetter + item.deadLetter,
        backlog: acc.backlog + item.backlog,
      }),
      { waiting: 0, active: 0, completed: 0, deadLetter: 0, backlog: 0 },
    );
    return { driver: this.kind, paused, consuming: this.started && this.workers.size > 0 && !paused, queues, totals };
  }

  /** @inheritdoc */
  async listDeadLetters(queue?: string, window?: DeadLetterWindow): Promise<DeadLetterRecord[]> {
    const out: DeadLetterRecord[] = [];
    // 窗口直接下推到 Redis 的 LRANGE（getFailed(start, end)），不再把整个 failed 集合拉回来
    const start = window ? Math.max(0, window.offset) : 0;
    const end = window
      ? Math.max(start, start + Math.max(0, window.limit) - 1)
      : Math.max(0, this.options.deadLetterMax - 1);
    if (window && window.limit <= 0) return out;
    for (const [, instance] of await this.targets(queue)) {
      const jobs = await instance.getFailed(start, end);
      for (const job of jobs) out.push(toDeadLetter(job));
    }
    return out;
  }

  /** @inheritdoc */
  async countDeadLetters(queue?: string): Promise<number> {
    let total = 0;
    for (const [, instance] of await this.targets(queue)) {
      if (typeof instance.getFailedCount === 'function') {
        total += await instance.getFailedCount();
        continue;
      }
      // 回退：该版本 bullmq 无 getFailedCount，按保留上限取一页计数（分页 total 的最接近值）
      const jobs = await instance.getFailed(0, Math.max(0, this.options.deadLetterMax - 1));
      total += jobs.length;
    }
    return total;
  }

  /** @inheritdoc */
  async requeueDeadLetter(id: string): Promise<boolean> {
    for (const queue of this.queues.values()) {
      const job = await queue.getJob(id);
      if (!job) continue;
      const state = await job.getState();
      if (state !== 'failed') return false;
      await job.retry('failed');
      logger.info('死信重放', { jobId: id, name: job.name });
      return true;
    }
    return false;
  }

  /** @inheritdoc */
  async purgeDeadLetters(queue?: string): Promise<number> {
    let removed = 0;
    for (const [, instance] of await this.targets(queue)) {
      const cleared = await instance.clean(0, this.options.deadLetterMax, 'failed');
      removed += cleared.length;
    }
    return removed;
  }

  /** @inheritdoc */
  async ping(): Promise<boolean> {
    try {
      const connection = await this.ensureConnection();
      await connection.ping();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 优雅停机：停止消费 → 等待在途任务（超时则强制关闭，交由失速检测恢复）
   * @param timeoutMs 等待上限（毫秒）
   * @returns 停机时仍在途的任务数
   */
  async close(timeoutMs = 0): Promise<number> {
    const stat = await this.stats().catch(() => undefined);
    const inflight = stat?.totals.active ?? 0;
    this.started = false;
    const workers = [...this.workers.values()];
    if (workers.length > 0) {
      if (timeoutMs <= 0) {
        // 无等待窗口：直接强制关闭（在途任务由失速检测在重启后恢复）
        await Promise.all(workers.map((worker) => worker.close(true).catch(() => undefined)));
      } else {
        // 立即发起优雅关闭，再等待至多 timeoutMs；超时则强制关闭
        const graceful = Promise.all(workers.map((worker) => worker.close().catch(() => undefined)));
        const winner = await Promise.race([
          graceful.then(() => 'closed' as const),
          new Promise<'timeout'>((resolve) => {
            const timer = setTimeout(() => resolve('timeout'), timeoutMs);
            timer.unref?.();
          }),
        ]);
        if (winner === 'timeout') {
          logger.warn('停机超时，强制关闭消费器（在途任务由失速检测在重启后恢复）', { inflight, timeoutMs });
          await Promise.all(workers.map((worker) => worker.close(true).catch(() => undefined)));
        }
      }
    }
    for (const queue of this.queues.values()) await queue.close().catch(() => undefined);
    this.workers.clear();
    this.queues.clear();
    if (this.connection) {
      await this.connection.quit().catch(() => this.connection?.disconnect());
      this.connection = undefined;
    }
    return inflight;
  }

  // ---------------- 内部实现 ----------------

  /** 加载模块与连接（幂等） */
  private async ensureReady(): Promise<BullmqModuleLike> {
    this.mod ??= this.options.module ?? (await loadBullmq());
    await this.ensureConnection();
    return this.mod;
  }

  /** 建立连接（幂等） */
  private async ensureConnection(): Promise<RedisConnectionLike> {
    this.connection ??= this.options.connection ?? (await createBullConnection(this.options.url));
    // M10 E-06：cluster 形态（多节点连接串）下 BullMQ 的键族必须同槽（hash-tag）——
    // 官方约定 prefix 带花括号（如 `{fw:prod}:`），否则多键命令将报 CROSSSLOT。这里给出可操作的启动告警。
    if (this.options.url?.includes(',') && !this.options.prefix.includes('{')) {
      logger.warn(
        'MQ_URL 为 Redis Cluster（多节点）而 MQ_PREFIX 未含 hash-tag 花括号：BullMQ 键族可能跨槽报 CROSSSLOT，请将 MQ_PREFIX 设为 `{...}:` 形式',
        { prefix: this.options.prefix },
      );
    }
    return this.connection;
  }

  /** 取/建队列实例 */
  private async getQueue(name: string): Promise<BullQueueLike> {
    const existing = this.queues.get(name);
    if (existing) return existing;
    const mod = await this.ensureReady();
    const queue = new mod.Queue(name, { connection: this.connection, prefix: this.options.prefix });
    this.queues.set(name, queue);
    this.known.add(name);
    // 注意：这里不能回调 ensureWorker——createWorker → getQueue → ensureWorker 会 await 到
    // 自己那个尚未完成的创建 Promise，造成启动期死锁（TC-JOB-008 排障记录）。
    // 消费器的创建统一由 ensureQueue / start() 负责。
    return queue;
  }

  /** 取/建消费器实例（并发安全：创建中先登记 Promise，避免同队列重复建） */
  private ensureWorker(name: string): Promise<void> {
    if (this.workers.has(name)) return Promise.resolve();
    const pending = this.creating.get(name);
    if (pending) return pending;
    const task = this.createWorker(name).finally(() => this.creating.delete(name));
    this.creating.set(name, task);
    return task;
  }

  /** 实际创建消费器（仅由 ensureWorker 调用） */
  private async createWorker(name: string): Promise<void> {
    const mod = await this.ensureReady();
    await this.getQueue(name);
    const runner = this.runner;
    if (!runner) return;
    const worker = new mod.Worker(
      name,
      async (job) => this.process(mod, job),
      {
        connection: this.connection,
        prefix: this.options.prefix,
        concurrency: this.options.concurrency,
        ...(this.options.rateLimit > 0 ? { limiter: { max: this.options.rateLimit, duration: 1000 } } : {}),
        // 失速检测：消费进程被强杀后，在途任务最长等 stalledInterval 被搬回等待区并重试
        ...(this.options.stalledIntervalMs && this.options.stalledIntervalMs > 0 ? { stalledInterval: this.options.stalledIntervalMs } : {}),
        settings: {
          // 与 memory 驱动共用同一套退避语义：序列随任务下发，第 n 次重试等待第 n 项
          backoffStrategy: (attemptsMade: number, _type?: string, _err?: Error, job?: { data?: unknown }): number =>
            backoffFor(readBackoff(job?.data), attemptsMade),
        },
      },
    );
    worker.on('stalled', (jobIds: string[]) => {
      logger.warn('检测到失速任务，已搬回等待区重试', { queue: name, jobIds });
    });
    worker.on('failed', (job: BullJobLike, error: Error) => {
      const attempts = job.opts.attempts ?? 1;
      if (job.attemptsMade >= attempts) {
        runner.onDeadLetter(recordOf(job), error instanceof Error ? error.message : String(error));
      }
    });
    worker.on('error', (error: Error) => {
      logger.warn('队列消费器异常', { queue: name, error: error instanceof Error ? error.message : String(error) });
    });
    this.workers.set(name, worker);
    logger.debug('队列消费器已就绪', { queue: name, concurrency: this.options.concurrency });
    if (process.env.MQ_DEBUG_WORKER === '1') {
      logger.info('[debug] bullmq worker 选项', { queue: name, opts: JSON.stringify((worker as { opts?: unknown }).opts) });
    }
  }

  /** 任务执行：把 bullmq 任务还原为框架任务记录并交给执行器 */
  private async process(mod: BullmqModuleLike, job: BullJobLike): Promise<void> {
    const record = recordOf(job);
    try {
      await this.runner?.run(record);
    } catch (error) {
      // 终态失败：转成 bullmq 的 UnrecoverableError，跳过剩余重试直接进死信
      if (error instanceof PermanentJobError) throw new mod.UnrecoverableError(error.message);
      throw error;
    }
  }

  /** 目标队列集合（未指定则全部） */
  private async targets(queue?: string): Promise<Array<[string, BullQueueLike]>> {
    if (queue) return [[queue, await this.getQueue(queue)]];
    const entries: Array<[string, BullQueueLike]> = [];
    for (const name of this.known) entries.push([name, await this.getQueue(name)]);
    return entries;
  }
}

/** 从任务数据还原框架任务记录（并校正执行次数） */
function recordOf(job: BullJobLike): JobRecord {
  const record = { ...(job.data as JobRecord) };
  record.id = job.id ?? record.id;
  record.attemptsMade = job.attemptsMade + 1;
  record.enqueuedAt = record.enqueuedAt ?? job.timestamp;
  return record;
}

/** 读取任务内的退避序列 */
function readBackoff(data: unknown): number[] {
  if (data && typeof data === 'object' && Array.isArray((data as JobRecord).backoff)) return (data as JobRecord).backoff;
  return [];
}

/** bullmq 任务 → 死信记录 */
function toDeadLetter(job: BullJobLike): DeadLetterRecord {
  const record = job.data as JobRecord;
  return {
    id: job.id ?? record.id,
    name: job.name,
    queue: record.queue,
    payload: record.payload,
    attemptsMade: job.attemptsMade,
    reason: (job.failedReason ?? '未知原因').slice(0, 500),
    failedAt: new Date(job.finishedOn ?? Date.now()).toISOString(),
    enqueuedAt: new Date(record.enqueuedAt ?? job.timestamp).toISOString(),
  };
}
