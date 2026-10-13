/*
 * @file bullmq 队列驱动（Redis，中大型系统）
 * @description 基于 bullmq 6 的驱动实现，与 memory 驱动提供一致的队列语义：
 *   延时与优先级、最大执行次数与同一套退避序列（经 `settings.backoffStrategy` 读取任务内序列）、
 *   死信（failed 集合）查询/重放/清理、暂停与恢复、并发与令牌桶限速（Worker limiter）、
 *   优雅停机（等待在途，超时交由失速检测在重启后恢复）。切换驱动只改 MQ_DRIVER（TC-JOB-001）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { Logger } from '@fw/logger';
import type { JobRunner, QueueDriverPort } from '../driver.port.js';
import { backoffFor } from '../duration.js';
import { PermanentJobError } from '../errors.js';
import type { DeadLetterRecord, JobDriverName, JobRecord, QueueStats, QueueStatsItem } from '../types.js';
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
  async listDeadLetters(queue?: string): Promise<DeadLetterRecord[]> {
    const out: DeadLetterRecord[] = [];
    for (const [, instance] of await this.targets(queue)) {
      const jobs = await instance.getFailed(0, Math.max(0, this.options.deadLetterMax - 1));
      for (const job of jobs) out.push(toDeadLetter(job));
    }
    return out;
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
    if (this.started) await this.ensureWorker(name);
    return queue;
  }

  /** 取/建消费器实例 */
  private async ensureWorker(name: string): Promise<void> {
    if (this.workers.has(name)) return;
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
        settings: {
          // 与 memory 驱动共用同一套退避语义：序列随任务下发，第 n 次重试等待第 n 项
          backoffStrategy: (attemptsMade: number, _type?: string, _err?: Error, job?: { data?: unknown }): number =>
            backoffFor(readBackoff(job?.data), attemptsMade),
        },
      },
    );
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
