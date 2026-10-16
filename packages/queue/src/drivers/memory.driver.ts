/*
 * @file memory 队列驱动（进程内，零外部依赖）
 * @description 小系统与单实例场景的默认驱动：内存队列 + 单一定时器驱动消费循环，
 *   完整实现队列语义——延时与优先级、最大执行次数与退避重试、死信归档与重放、
 *   并发信号量与**每队列**令牌桶限速、暂停/恢复/清空、优雅停机（等待在途 + 未完成重新入队）。
 *   与 bullmq 驱动的可观测行为一致（TC-JOB-001）：同一套退避序列与「最大执行次数」语义，
 *   限速与 bullmq limiter 同为按队列生效（某队列突发不得饿死其他队列）。
 *   局限：进程退出即丢任务（PRD-007 §8），仅用于可丢失的轻量任务。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo 死信窗口：listDeadLetters 支持 window 切片 + 新增 countDeadLetters
 * @modified 2026-10-15 donttemo M9/PRD-009 FR-09：新增 applyRuntimeOptions——并发/限速就地更新即时生效（pump 与令牌判定逐次读取）
 * @modified 2026-10-16 donttemo 驱动审查修复：① void execute 吞 rejection——执行链路全量隔离，
 *   失败处理（退避/归档/onDeadLetter）自身异常记日志不逃逸（unhandled rejection 会让 Node 20+ 终止进程）；
 *   ② close() 改为 await 在途执行 Promise + 真实定时器超时，不再用 this.now() 计算 deadline
 *   （注入假时钟时 deadline 永不满足 → 死循环）；③ 限速改**每队列**令牌桶（与 bullmq limiter 对齐，
 *   此前 10 队列共享一个桶，某队列突发饿死其他队列），限速热更重置桶（对齐 bullmq 重建消费器的满桶语义）；
 *   ④ peek/earliestRunAt 由 O(N) 全扫改为按（队列 × 优先级）分桶的最小堆，pump 摊销 O(队列×优先级)；
 *   ⑤ listDeadLetters 排序加插入序 tie-breaker（同毫秒失败翻页稳定），payload 返回深拷贝
 *   （此前视图与归档共享引用，调用方可篡改重放数据）；⑥ applyRuntimeOptions 不再写构造入参对象
 *   （构造时浅拷贝，多实例不互相污染）；⑦ 移除 nextSeq()（全仓无调用方，且属驱动特有能力破坏端口抽象）。
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

/** 死信内部记录：契约视图 + 原任务快照（重放需要完整选项）+ 归档序（同毫秒排序 tie-breaker） */
interface DeadEntry {
  /** 契约视图 */
  view: DeadLetterRecord;
  /** 原任务（重放用） */
  record: JobRecord;
  /** 归档序号（队列内单调递增） */
  seq: number;
}

/** 等待堆条目：runAt 快照（退避重排后记录的 runAt 会变，堆键以入堆时刻为准）+ 入堆序 */
interface PendingEntry {
  /** 任务记录 */
  record: JobRecord;
  /** 计划执行时刻（入堆时刻快照，epoch 毫秒） */
  runAt: number;
  /** 入堆序号（同优先级同 runAt 时保证 FIFO 确定性） */
  seq: number;
}

/**
 * 等待任务最小堆：按（runAt, seq）有序，同一优先级一个堆。
 * peek/earliestRunAt 的复杂度从「全量扫描所有 pending」降为「每队列看各优先级堆顶」。
 */
class PendingHeap {
  private readonly items: PendingEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  peek(): PendingEntry | undefined {
    return this.items[0];
  }

  clear(): void {
    this.items.length = 0;
  }

  push(entry: PendingEntry): void {
    this.items.push(entry);
    this.siftUp(this.items.length - 1);
  }

  pop(): PendingEntry | undefined {
    const top = this.items[0];
    const last = this.items.pop();
    if (this.items.length > 0 && last !== undefined) {
      this.items[0] = last;
      this.siftDown(0);
    }
    return top;
  }

  /** 按谓词查找任务记录（cancel 等低频管理操作用，O(N) 可接受） */
  find(predicate: (record: JobRecord) => boolean): JobRecord | undefined {
    return this.items.find((entry) => predicate(entry.record))?.record;
  }

  /** 按记录身份移除（splice 后对替换位双向堆化），返回是否移除成功 */
  remove(record: JobRecord): boolean {
    const index = this.items.findIndex((entry) => entry.record === record);
    if (index < 0) return false;
    const last = this.items.pop();
    if (index < this.items.length && last !== undefined) {
      this.items[index] = last;
      this.siftDown(index);
      this.siftUp(index);
    }
    return true;
  }

  private static before(a: PendingEntry, b: PendingEntry): boolean {
    return a.runAt < b.runAt || (a.runAt === b.runAt && a.seq < b.seq);
  }

  private siftUp(start: number): void {
    let i = start;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!PendingHeap.before(this.items[i], this.items[parent])) break;
      [this.items[i], this.items[parent]] = [this.items[parent], this.items[i]];
      i = parent;
    }
  }

  private siftDown(start: number): void {
    let i = start;
    for (;;) {
      const left = i * 2 + 1;
      const right = left + 1;
      let smallest = i;
      if (left < this.items.length && PendingHeap.before(this.items[left], this.items[smallest])) smallest = left;
      if (right < this.items.length && PendingHeap.before(this.items[right], this.items[smallest])) smallest = right;
      if (smallest === i) break;
      [this.items[i], this.items[smallest]] = [this.items[smallest], this.items[i]];
      i = smallest;
    }
  }
}

/** 单队列状态 */
interface QueueState {
  /** 队列名 */
  name: string;
  /** 等待执行：优先级 → 最小堆（含退避重排与延时未到期） */
  pending: Map<number, PendingHeap>;
  /** 等待中任务总数（各堆 size 之和的缓存，避免 pendingCount 反复遍历） */
  waiting: number;
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
  /** 死信归档序号（tie-breaker 用） */
  deadSeq: number;
}

/** 默认定时器实现 */
const defaultSetTimer = (fn: () => void, ms: number): TimerHandle => setTimeout(fn, ms);
/** 默认清定时器实现 */
const defaultClearTimer = (handle: TimerHandle): void => clearTimeout(handle as unknown as NodeJS.Timeout);

/** 每队列令牌桶状态 */
interface RateBucket {
  /** 当前令牌数 */
  tokens: number;
  /** 上次补充时刻 */
  tokensAt: number;
}

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

  /**
   * 驱动私有选项副本：构造时浅拷贝，applyRuntimeOptions 就地更新只作用于本实例，
   * 不回写调用方传入的对象（多实例共用同一 options 字面量时不再互相污染）
   */
  private readonly options: MemoryDriverOptions;

  /** 消费循环是否在跑 */
  private running = false;

  /** 停机中（不再拉取新任务） */
  private closing = false;

  /** 当前唤醒定时器 */
  private timer: TimerHandle | undefined;

  /** 每队列令牌桶（与 bullmq 的 per-Worker limiter 对齐，某队列突发不饿死其他队列） */
  private readonly rateBuckets = new Map<string, RateBucket>();

  /** 任务入堆序号（FIFO tie-breaker） */
  private pushSeq = 0;

  /** 全局暂停标记（新建队列沿用） */
  private pausedAll = false;

  private runner: JobRunner | undefined;

  /** 在途执行 Promise（close 等待与超时重排队用） */
  private readonly executions = new Set<Promise<void>>();

  /**
   * @param options 并发 / 限速 / 死信上限与可注入时钟
   */
  constructor(options: MemoryDriverOptions) {
    this.options = { ...options };
    this.now = options.now ?? (() => Date.now());
    this.setTimer = options.setTimer ?? defaultSetTimer;
    this.clearTimer = options.clearTimer ?? defaultClearTimer;
  }

  /** @inheritdoc */
  applyRuntimeOptions(patch: { concurrency?: number; rateLimit?: number }): void {
    if (patch.rateLimit !== undefined && patch.rateLimit !== this.options.rateLimit) {
      // bullmq 限速热更 = 重建消费器（limiter 从满桶重来）；memory 对齐语义重置全部桶
      this.rateBuckets.clear();
    }
    // 并发在每次 pump 调度时读取、限速在每次令牌判定时读取：改 options 即时生效
    Object.assign(this.options, patch);
    logger.info('memory 队列驱动运行时选项已热更', { ...patch });
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
    this.pushTo(this.state(record.queue), record);
    this.wake(0);
  }

  /** @inheritdoc */
  async cancel(jobId: string): Promise<boolean> {
    for (const state of this.queues.values()) {
      for (const heap of state.pending.values()) {
        const record = heap.find((item) => item.id === jobId);
        if (record && heap.remove(record)) {
          state.waiting--;
          return true;
        }
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
      removed += state.waiting;
      for (const heap of state.pending.values()) heap.clear();
      state.waiting = 0;
    }
    return removed;
  }

  /** @inheritdoc */
  async stats(queueNames?: readonly string[]): Promise<QueueStats> {
    const names = queueNames && queueNames.length > 0 ? queueNames : [...this.queues.keys()];
    const queues = names.map((name) => {
      const state = this.queues.get(name);
      const waiting = state ? state.waiting : 0;
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
    const collected: Array<{ view: DeadLetterRecord; seq: number }> = [];
    for (const state of this.targets(queue)) {
      for (const entry of state.deadLetters) collected.push({ view: entry.view, seq: entry.seq });
    }
    // 最新失败在前；同毫秒失败按归档序倒序（后归档者在前），保证窗口翻页稳定；
    // payload 深拷贝——调用方修改返回项不得污染归档数据与重放来源
    const sorted = collected
      .sort((a, b) => (a.view.failedAt !== b.view.failedAt ? (a.view.failedAt < b.view.failedAt ? 1 : -1) : b.seq - a.seq))
      .map(({ view }) => ({ ...view, payload: clonePayload(view.payload) }));
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
      this.pushTo(state, record);
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
   *
   * 等待基于在途执行 Promise 的真实完成 + 独立超时定时器，**不经 this.now() 计算 deadline**——
   * 注入假时钟时（now 恒定/可控）按当前时刻推进的 deadline 永不满足，轮询会退化为死循环。
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
    if (timeoutMs > 0 && this.activeTotal() > 0 && this.executions.size > 0) {
      await Promise.race([
        Promise.allSettled([...this.executions]),
        new Promise<void>((resolve) => {
          const handle = this.setTimer(resolve, Math.max(0, Math.round(timeoutMs)));
          handle.unref?.();
        }),
      ]);
    }
    let requeued = 0;
    for (const state of this.queues.values()) {
      for (const record of state.inflight) {
        this.pushTo(state, record);
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
    return this.targets(queue).reduce((acc, state) => acc + state.waiting, 0);
  }

  // ---------------- 内部实现 ----------------

  /** 取/建队列状态 */
  private state(name: string): QueueState {
    let state = this.queues.get(name);
    if (!state) {
      state = { name, pending: new Map(), waiting: 0, active: 0, inflight: new Set(), completed: 0, paused: this.pausedAll, deadLetters: [], deadSeq: 0 };
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

  /** 任务入等待堆（按优先级分桶；runAt 快照入键，退避重排后重新入堆） */
  private pushTo(state: QueueState, record: JobRecord): void {
    let heap = state.pending.get(record.priority);
    if (!heap) {
      heap = new PendingHeap();
      state.pending.set(record.priority, heap);
    }
    heap.push({ record, runAt: record.runAt, seq: ++this.pushSeq });
    state.waiting++;
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

  /**
   * 消费循环：按并发与限速尽可能多地取任务。
   * 每轮在「队列 × 优先级堆顶」集合中选最优（O(队列×优先级)），不再全量扫描 pending：
   * 同优先级堆顶 runAt 最小——若堆顶未到期则该优先级必然无到期任务（堆序保证）。
   */
  private pump(): void {
    if (!this.running || this.closing || !this.runner) return;
    let nextDue: number | undefined;
    for (;;) {
      if (this.activeTotal() >= this.options.concurrency) {
        return;
      }
      const nowTs = this.now();
      let best: { state: QueueState; heap: PendingHeap; priority: number; entry: PendingEntry } | undefined;
      let blockedUntil: number | undefined;
      let earliestFuture: number | undefined;
      for (const state of this.queues.values()) {
        if (state.paused) continue;
        for (const [priority, heap] of state.pending) {
          const top = heap.peek();
          if (!top) continue;
          if (top.runAt <= nowTs) {
            if (this.hasToken(state)) {
              if (!best || isBetterCandidate(priority, top, best.priority, best.entry)) {
                best = { state, heap, priority, entry: top };
              }
            } else {
              // 该队列有到期任务但令牌耗尽：记下最近补币时刻（其他队列照常调度）
              const refill = nowTs + this.refillMsFor(state);
              blockedUntil = blockedUntil === undefined ? refill : Math.min(blockedUntil, refill);
            }
          } else {
            earliestFuture = earliestFuture === undefined ? top.runAt : Math.min(earliestFuture, top.runAt);
          }
        }
      }
      if (!best) {
        nextDue = earliestFuture !== undefined && blockedUntil !== undefined ? Math.min(earliestFuture, blockedUntil) : earliestFuture ?? blockedUntil;
        break;
      }
      const entry = best.heap.pop();
      if (entry) {
        best.state.waiting--;
        this.takeToken(best.state);
        this.startExecution(best.state, entry.record);
      }
    }
    if (nextDue !== undefined) this.wake(Math.max(0, nextDue - this.now()));
  }

  /** 发起一次在途执行：Promise 登记进 executions（close 等待用），链路自身不产生 rejection */
  private startExecution(state: QueueState, record: JobRecord): void {
    const promise: Promise<void> = this.runJob(state, record).finally(() => {
      this.executions.delete(promise);
    });
    this.executions.add(promise);
  }

  /**
   * 执行任务：成功计数；失败按退避重排或归档死信。
   * 全链路隔离——runner 异常由 handleFailure 消化，handleFailure 自身异常（退避计算、
   * 归档、onDeadLetter 回调）捕获记日志：执行 Promise 绝不 reject，否则 unhandled
   * rejection 在 Node 20+ 默认直接终止进程。
   */
  private async runJob(state: QueueState, record: JobRecord): Promise<void> {
    state.active++;
    state.inflight.add(record);
    record.attemptsMade++;
    try {
      await this.runner?.run(record);
      state.completed++;
    } catch (error) {
      try {
        this.handleFailure(state, record, error);
      } catch (handlingError) {
        logger.error('任务失败处理链路异常（已隔离，不影响消费循环）', {
          jobId: record.id,
          name: record.name,
          queue: record.queue,
          originalError: error instanceof Error ? error.message : String(error),
          cause: handlingError instanceof Error ? handlingError.message : String(handlingError),
        });
      }
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
    this.pushTo(state, record);
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
    state.deadLetters.push({ view, record, seq: ++state.deadSeq });
    while (state.deadLetters.length > this.options.deadLetterMax) state.deadLetters.shift();
    this.runner?.onDeadLetter(record, view.reason);
  }

  // ---------------- 每队列令牌桶（对齐 bullmq per-Worker limiter 语义） ----------------

  /** 该队列当前是否有可用令牌（不消耗；rateLimit ≤ 0 = 不限速恒真） */
  private hasToken(state: QueueState): boolean {
    const limit = this.options.rateLimit;
    if (limit <= 0) return true;
    return this.refillBucket(state).tokens >= 1;
  }

  /** 消耗一个令牌（仅在与 hasToken 判定同一轮 pump 内调用） */
  private takeToken(state: QueueState): void {
    const limit = this.options.rateLimit;
    if (limit <= 0) return;
    const bucket = this.refillBucket(state);
    if (bucket.tokens >= 1) bucket.tokens -= 1;
  }

  /** 按流逝时间补充队列令牌并返回桶状态（时钟回拨不补充、不倒扣） */
  private refillBucket(state: QueueState): RateBucket {
    const limit = this.options.rateLimit;
    let bucket = this.rateBuckets.get(state.name);
    if (!bucket) {
      bucket = { tokens: limit, tokensAt: this.now() };
      this.rateBuckets.set(state.name, bucket);
    }
    const nowTs = this.now();
    if (nowTs > bucket.tokensAt) {
      bucket.tokens = Math.min(limit, bucket.tokens + ((nowTs - bucket.tokensAt) * limit) / 1000);
      bucket.tokensAt = nowTs;
    }
    return bucket;
  }

  /** 距该队列下一个令牌可用还需多少毫秒 */
  private refillMsFor(state: QueueState): number {
    const limit = this.options.rateLimit;
    if (limit <= 0) return 0;
    const bucket = this.refillBucket(state);
    return Math.max(1, Math.ceil((1000 / limit) * (1 - bucket.tokens)));
  }
}

/** 跨队列候选比较：优先级小者先；同优先级看 runAt；再同看入堆序（FIFO 确定性） */
function isBetterCandidate(
  priority: number,
  entry: PendingEntry,
  bestPriority: number,
  best: PendingEntry,
): boolean {
  if (priority !== bestPriority) return priority < bestPriority;
  if (entry.runAt !== best.runAt) return entry.runAt < best.runAt;
  return entry.seq < best.seq;
}

/** 死信视图 payload 深拷贝（JSON 契约载荷；不可克隆时退回原引用并保持只读约定） */
function clonePayload(payload: unknown): unknown {
  if (payload === null || typeof payload !== 'object') return payload;
  try {
    return structuredClone(payload);
  } catch {
    return payload;
  }
}
