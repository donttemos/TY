/*
 * @file memory 队列驱动（进程内，零外部依赖）
 * @description 小系统与单实例场景的默认驱动：内存队列 + 单一定时器驱动消费循环，
 *   完整实现队列语义——延时与优先级、最大执行次数与退避重试、死信归档与重放、
 *   并发信号量与令牌桶限速、暂停/恢复/清空、优雅停机（等待在途 + 未完成重新入队）。
 *   与 bullmq 驱动的可观测行为一致（TC-JOB-001）：同一套退避序列与「最大执行次数」语义。
 *   局限：进程退出即丢任务（PRD-007 §8），仅用于可丢失的轻量任务。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo 死信窗口：listDeadLetters 支持 window 切片 + 新增 countDeadLetters
 * @module @fw/queue
 */

import { Logger } from '@fw/logger';
import type { JobRunner, QueueDriverPort } from '../driver.port.js';
import { PermanentJobError, QueueUnavailableError } from '../errors.js';
import { backoffFor } from '../duration.js';
import type { DeadLetterRecord, DeadLetterWindow, JobDriverName, JobRecord, QueueStats } from '../types.js';

const logger = Logger.for('queue.memory');

/** 定时器句柄（Node 与浏览器兼容的最小子集） */
interface TimerHandle {
  unref?: () => void;
}

/** memory 驱动选项 */
export interface MemoryDriverOptions {
  /** 每队列并发数 */
  concurrency: number;
  /** 每队列每秒处理上限（0 = 不限速） */
  rateLimit: number;
  /** 死信保留上限 */
  deadLetterMax: number;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 定时器（测试可注入） */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  /** 清定时器 */
  clearTimer?: (handle: TimerHandle) => void;
}

/** 死信内部记录：契约视图 + 原任务快照（重放需要完整选项） */
interface DeadEntry {
  /** 契约视图 */
  view: DeadLetterRecord;
  /** 原任务（重放用） */
  record: JobRecord;
}

/** 单队列状态 */
interface QueueState {
  /** 队列名 */
  name: string;
  /** 等待执行（含退避重排与延时未到期） */
  pending: JobRecord[];
  /** 正在执行 */
  active: number;
  /** 执行中的任务（优雅停机时重新入队） */
  inflight: Set<JobRecord>;
  /** 已完成 */
  completed: number;
  /** 是否暂停 */
  paused: boolean;
  /** 死信 */
  deadLetters: DeadEntry[];
}

/** 默认定时器实现 */
const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms);
/** 默认清定时器实现 */
const defaultClearTimer = (handle: TimerHandle): void => clearTimeout(handle as unknown as NodeJS.Timeout);

/**
 * 进程内队列驱动
 */
export class MemoryQueueDriver implements QueueDriverPort {
  /** @inheritdoc */
  readonly kind: JobDriverName = 'memory';

  private readonly queues = new Map<string, QueueState>();

  private readonly now: () => number;

  private readonly setTimer: (fn: () => void, ms: number) => TimerHandle;

  private readonly clearTimer: (handle: TimerHandle) => void;

  /** 消费循环是否在跑 */
  private running = false;

  /** 停机中（不再拉取新任务） */
  private closing = false;

  /** 当前唤醒定时器 */
  private timer: TimerHandle | undefined;

  /** 令牌桶：当前令牌数 */
  private tokens = 0;

  /** 令牌桶：上次补充时刻 */
  private tokensAt = 0;

  /** 任务序号（生成任务 ID） */
  private seq = 0;

  /** 全局暂停标记（新建队列沿用） */
  private pausedAll = false;

  private runner: JobRunner | undefined;

  /**
   * @param options 并发 / 限速 / 死信上限与可注入时钟
   */
  constructor(private readonly options: MemoryDriverOptions) {
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
    this.tokens = options.rateLimit;
    this.tokensAt = this.now();
  }

  /** @inheritdoc */
  async start(runner: JobRunner): Promise<void> {
    if (this.running) return;
    this.runner = runner;
    this.running = true;
    this.closing = false;
    logger.info('队列消费已启动', { driver: this.kind, concurrency: this.options.concurrency, rateLimit: this.options.rateLimit });
    this.pump();
  }

  /** @inheritdoc */
  ensureQueue(name: string): void {
    this.state(name);
  }

  /** @inheritdoc */
  async enqueue(record: JobRecord): Promise<void> {
    if (this.closing) throw new QueueUnavailableError('队列正在停机，拒绝新任务');
    this.state(record.queue).pending.push(record);
    this.wake(0);
  }

  /** @inheritdoc */
  async cancel(jobId: string): Promise<boolean> {
    for (const state of this.queues.values()) {
      const index = state.pending.findIndex((item) => item.id === jobId);
      if (index >= 0) {
        state.pending.splice(index, 1);
        return true;
      }
    }
    return false;
  }

  /** @inheritdoc */
  async pause(queue?: string): Promise<void> {
    if (queue) {
      this.state(queue).paused = true;
      return;
    }
    // 全局暂停：同时作用于此后新建的队列（避免「先暂停再入队」被新队列绕过）
    this.pausedAll = true;
    for (const state of this.queues.values()) state.paused = true;
  }

  /** @inheritdoc */
  async resume(queue?: string): Promise<void> {
    if (queue) {
      this.state(queue).paused = false;
    } else {
      this.pausedAll = false;
      for (const state of this.queues.values()) state.paused = false;
    }
    this.wake(0);
  }

  /** @inheritdoc */
  async drain(queue?: string): Promise<number> {
    let removed = 0;
    for (const state of this.targets(queue)) {
      removed += state.pending.length;
      state.pending = [];
    }
    return removed;
  }

  /** @inheritdoc */
  async stats(queueNames?: readonly string[]): Promise<QueueStats> {
    const names = queueNames && queueNames.length > 0 ? queueNames : [...this.queues.keys()];
    const queues = names.map((name) => {
      const state = this.queues.get(name);
      const waiting = state ? state.pending.length : 0;
      const active = state?.active ?? 0;
      return {
        name,
        waiting,
        active,
        completed: state?.completed ?? 0,
        deadLetter: state?.deadLetters.length ?? 0,
        backlog: waiting + active,
        concurrency: this.options.concurrency,
        rateLimit: this.options.rateLimit,
      };
    });
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
    const paused = [...this.queues.values()].some((state) => state.paused);
    return { driver: this.kind, paused, consuming: this.running && !this.closing && !paused, queues, totals };
  }

  /** @inheritdoc */
  async listDeadLetters(queue?: string, window?: DeadLetterWindow): Promise<DeadLetterRecord[]> {
    const out: DeadLetterRecord[] = [];
    for (const state of this.targets(queue)) {
      for (const entry of state.deadLetters) out.push({ ...entry.view });
    }
    // 最新失败在前；再按窗口切片（进程内集合有 deadLetterMax 上限，全量排序代价可控）
    const sorted = out.sort((a, b) => (a.failedAt < b.failedAt ? 1 : -1));
    if (!window) return sorted;
    const offset = Math.max(0, window.offset);
    return sorted.slice(offset, offset + Math.max(0, window.limit));
  }

  /** @inheritdoc */
  async countDeadLetters(queue?: string): Promise<number> {
    return this.targets(queue).reduce((acc, state) => acc + state.deadLetters.length, 0);
  }

  /** @inheritdoc */
  async requeueDeadLetter(id: string): Promise<boolean> {
    for (const state of this.queues.values()) {
      const index = state.deadLetters.findIndex((entry) => entry.view.id === id);
      if (index < 0) continue;
      const [entry] = state.deadLetters.splice(index, 1);
      // 重放语义：计数归零，按原始选项重新排队（仍受并发与限速约束）
      const record: JobRecord = { ...entry.record, attemptsMade: 0, runAt: this.now() };
      state.pending.push(record);
      logger.info('死信重放入队', { jobId: id, name: record.name, queue: record.queue });
      this.wake(0);
      return true;
    }
    return false;
  }

  /** @inheritdoc */
  async purgeDeadLetters(queue?: string): Promise<number> {
    let removed = 0;
    for (const state of this.targets(queue)) {
      removed += state.deadLetters.length;
      state.deadLetters = [];
    }
    return removed;
  }

  /** @inheritdoc */
  async ping(): Promise<boolean> {
    return true;
  }

  /**
   * 优雅停机：停止拉取 → 等待在途任务（超时）→ 未完成任务重新入队
   * @param timeoutMs 等待上限（毫秒）
   * @returns 重新入队的任务数
   */
  async close(timeoutMs = 0): Promise<number> {
    this.closing = true;
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const deadline = this.now() + timeoutMs;
    while (this.activeTotal() > 0 && this.now() < deadline) {
      await new Promise<void>((resolve) => {
        const handle = this.setTimer(resolve, 5);
        handle.unref?.();
      });
    }
    let requeued = 0;
    for (const state of this.queues.values()) {
      for (const record of state.inflight) {
        state.pending.push(record);
        requeued++;
      }
      state.inflight.clear();
    }
    if (requeued > 0) {
      logger.warn('停机超时，在途任务已重新入队（memory 驱动进程退出后不保留）', { requeued });
    }
    return requeued;
  }

  /** 某队列当前等待中的任务数（冒烟与单测断言用） */
  pendingCount(queue?: string): number {
    return this.targets(queue).reduce((acc, state) => acc + state.pending.length, 0);
  }

  // ---------------- 内部实现 ----------------

  /** 取/建队列状态 */
  private state(name: string): QueueState {
    let state = this.queues.get(name);
    if (!state) {
      state = { name, pending: [], active: 0, inflight: new Set(), completed: 0, paused: this.pausedAll, deadLetters: [] };
      this.queues.set(name, state);
    }
    return state;
  }

  /** 目标队列集合（未指定则全部） */
  private targets(queue?: string): QueueState[] {
    if (queue) return [this.state(queue)];
    return [...this.queues.values()];
  }

  /** 全局在途任务数 */
  private activeTotal(): number {
    let total = 0;
    for (const state of this.queues.values()) total += state.active;
    return total;
  }

  /** 安排一次唤醒（同一时刻只保留一个定时器） */
  private wake(ms: number): void {
    if (!this.running || this.closing || this.timer) return;
    const delay = Math.max(0, Math.round(ms));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      this.pump();
    }, delay);
    this.timer.unref?.();
  }

  /** 消费循环：按并发与限速尽可能多地取任务 */
  private pump(): void {
    if (!this.running || this.closing || !this.runner) return;
    const nowTs = this.now();
    let nextDue: number | undefined;
    for (;;) {
      if (this.activeTotal() >= this.options.concurrency) {
        return;
      }
      const candidate = this.peek(nowTs);
      if (!candidate) {
        nextDue = this.earliestRunAt();
        break;
      }
      if (!this.takeToken()) {
        nextDue = this.now() + this.refillMs();
        break;
      }
      const pending = this.state(candidate.queue).pending;
      pending.splice(pending.indexOf(candidate), 1);
      void this.execute(candidate);
    }
    if (nextDue !== undefined) this.wake(Math.max(0, nextDue - this.now()));
  }

  /** 查看下一个可执行任务（不取出；按 priority、runAt、入队序） */
  private peek(nowTs: number): JobRecord | undefined {
    let best: JobRecord | undefined;
    for (const state of this.queues.values()) {
      if (state.paused) continue;
      for (const record of state.pending) {
        if (record.runAt > nowTs) continue;
        if (!best) {
          best = record;
          continue;
        }
        if (record.priority < best.priority || (record.priority === best.priority && record.runAt < best.runAt)) {
          best = record;
        }
      }
    }
    return best;
  }

  /** 最早的未来执行时刻 */
  private earliestRunAt(): number | undefined {
    let earliest: number | undefined;
    for (const state of this.queues.values()) {
      if (state.paused) continue;
      for (const record of state.pending) {
        if (earliest === undefined || record.runAt < earliest) earliest = record.runAt;
      }
    }
    return earliest;
  }

  /** 令牌桶：取一个令牌 */
  private takeToken(): boolean {
    const limit = this.options.rateLimit;
    if (limit <= 0) return true;
    const nowTs = this.now();
    const elapsed = nowTs - this.tokensAt;
    if (elapsed > 0) {
      this.tokens = Math.min(limit, this.tokens + (elapsed * limit) / 1000);
      this.tokensAt = nowTs;
    }
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  /** 距下一个令牌可用还需多少毫秒 */
  private refillMs(): number {
    const limit = this.options.rateLimit;
    if (limit <= 0) return 0;
    return Math.max(1, Math.ceil((1000 / limit) * (1 - this.tokens)));
  }

  /** 执行任务：成功计数；失败按退避重排或归档死信 */
  private async execute(record: JobRecord): Promise<void> {
    const state = this.state(record.queue);
    state.active++;
    state.inflight.add(record);
    record.attemptsMade++;
    try {
      await this.runner?.run(record);
      state.completed++;
    } catch (error) {
      this.handleFailure(state, record, error);
    } finally {
      state.active--;
      state.inflight.delete(record);
      if (this.running && !this.closing) this.pump();
    }
  }

  /** 失败处理：终态或次数耗尽 → 死信；否则退避后重排 */
  private handleFailure(state: QueueState, record: JobRecord, error: unknown): void {
    const permanent = error instanceof PermanentJobError;
    if (permanent || record.attemptsMade >= record.attempts) {
      const reason = error instanceof Error ? error.message : String(error);
      this.archive(state, record, reason);
      return;
    }
    const delay = backoffFor(record.backoff, record.attemptsMade);
    record.runAt = this.now() + delay;
    state.pending.push(record);
    logger.warn('任务失败，退避后重试', { jobId: record.id, name: record.name, attempt: record.attemptsMade, delayMs: delay });
  }

  /** 归档死信（超出上限丢弃最旧） */
  private archive(state: QueueState, record: JobRecord, reason: string): void {
    const view: DeadLetterRecord = {
      id: record.id,
      name: record.name,
      queue: record.queue,
      payload: record.payload,
      attemptsMade: record.attemptsMade,
      reason: reason.slice(0, 500),
      failedAt: new Date(this.now()).toISOString(),
      enqueuedAt: new Date(record.enqueuedAt).toISOString(),
    };
    state.deadLetters.push({ view, record });
    while (state.deadLetters.length > this.options.deadLetterMax) state.deadLetters.shift();
    this.runner?.onDeadLetter(record, view.reason);
  }

  /** 生成任务序号（供 QueueService 生成 ID 时复用同一时钟源） */
  nextSeq(): number {
    return ++this.seq;
  }
}
