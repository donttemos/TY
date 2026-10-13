/*
 * @file cron 调度器
 * @description 单一定时器驱动全部 `@Cron` 条目（按最近触发时刻唤醒，避免每个任务各起一个定时器）：
 *   - 触发时先经执行守卫存储抢分布式锁，抢不到即跳过本次（集群内只跑一次，PRD-007 FR-03 / TC-JOB-002）；
 *   - 锁 TTL 缺省取 `max(任务超时, 60)` 秒，避免长任务被他人抢锁；
 *   - 停机时停止定时器并等待在途触发完成；
 *   - `tick(name?)` 支持手动触发（运维与冒烟验证用），仍走同一把锁。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { Logger } from '@fw/logger';
import { withTimeout } from './async.js';
import { parseCron, type CronExpression } from './cron-expression.js';
import type { GuardLockHandle, QueueGuardStore } from './guard-store.js';
import type { QueueMetrics } from './metrics.js';
import type { CronOptions, CronSnapshot } from './types.js';

const logger = Logger.for('queue.cron');

/** 单条 cron 的运行期状态 */
interface CronEntry {
  /** 任务名（互斥锁键） */
  name: string;
  /** 表达式（原文） */
  expression: string;
  /** 解析结果 */
  parsed: CronExpression;
  /** 选项 */
  options: CronOptions;
  /** 是否加锁（默认 true） */
  lock: boolean;
  /** 锁 TTL（秒） */
  lockTtlSeconds: number;
  /** 执行超时（毫秒） */
  timeoutMs: number;
  /** 执行体 */
  handler: () => Promise<void> | void;
  /** 下次触发时刻（毫秒） */
  nextRunAt: number;
  /** 本实例执行次数 */
  runs: number;
  /** 未拿到锁跳过次数 */
  lockedOut: number;
  /** 最近执行结果 */
  lastResult: 'ok' | 'error' | null;
  /** 最近执行时刻（ISO 8601） */
  lastRunAt: string | null;
  /** 是否在途 */
  inflight: boolean;
}

/** 调度器依赖 */
export interface CronSchedulerDeps {
  /** 执行守卫存储（分布式锁） */
  guard: QueueGuardStore;
  /** 指标采集器 */
  metrics: QueueMetrics;
  /** 是否启用（MQ_CRON_ENABLED） */
  enabled: boolean;
  /** 默认执行超时（毫秒，取 MQ_JOB_TIMEOUT） */
  defaultTimeoutMs: number;
  /** 时钟（测试可注入） */
  now?: () => number;
  /** 定时器（测试可注入） */
  setTimer?: (fn: () => void, ms: number) => { unref?: () => void };
  /** 清定时器 */
  clearTimer?: (handle: { unref?: () => void }) => void;
}

/** Node 定时器上限（约 24.8 天）：超长间隔分段唤醒 */
const MAX_TIMER_MS = 2_147_483_647;

/** 默认锁 TTL 下界（秒）：保证长任务不被他人抢锁 */
const MIN_LOCK_TTL_SECONDS = 60;

/**
 * cron 调度器
 */
export class CronScheduler {
  private readonly entries = new Map<string, CronEntry>();

  private readonly now: () => number;

  private readonly setTimer: (fn: () => void, ms: number) => { unref?: () => void };

  private readonly clearTimer: (handle: { unref?: () => void }) => void;

  private timer: { unref?: () => void } | undefined;

  private running = false;

  /** 在途触发（停机时等待） */
  private inflight = 0;

  /**
   * @param deps 守卫存储、指标、启用开关与可注入时钟
   */
  constructor(private readonly deps: CronSchedulerDeps) {
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = deps.clearTimer ?? ((handle) => clearTimeout(handle as unknown as NodeJS.Timeout));
  }

  /** 是否启用 */
  get enabled(): boolean {
    return this.deps.enabled;
  }

  /** 已注册条目名 */
  names(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 注册定时任务（重复注册同名条目时后者覆盖前者）
   * @param name 任务名
   * @param expression cron 表达式
   * @param handler 执行体
   * @param options 选项
   */
  register(name: string, expression: string, handler: () => Promise<void> | void, options: CronOptions = {}): void {
    const parsed = parseCron(expression, options.timezone);
    const timeoutMs = Math.round((options.timeoutSeconds ?? this.deps.defaultTimeoutMs / 1000) * 1000);
    const entry: CronEntry = {
      name,
      expression,
      parsed,
      options,
      lock: options.lock !== false,
      lockTtlSeconds: options.lockTtlSeconds ?? Math.max(Math.ceil(timeoutMs / 1000), MIN_LOCK_TTL_SECONDS),
      timeoutMs,
      handler,
      nextRunAt: parsed.next(new Date(this.now())).getTime(),
      runs: 0,
      lockedOut: 0,
      lastResult: null,
      lastRunAt: null,
      inflight: false,
    };
    if (this.entries.has(name)) logger.warn('定时任务被覆盖注册', { name, expression });
    this.entries.set(name, entry);
    logger.debug('定时任务已注册', {
      name,
      expression,
      lock: entry.lock,
      lockTtlSeconds: entry.lockTtlSeconds,
      nextRunAt: new Date(entry.nextRunAt).toISOString(),
    });
  }

  /** 启动调度（`runOnInit` 的条目立即执行一次） */
  start(): void {
    if (!this.deps.enabled || this.running) return;
    this.running = true;
    const immediate = [...this.entries.values()].filter((entry) => entry.options.runOnInit === true);
    for (const entry of immediate) void this.fireEntry(entry);
    this.reschedule();
    logger.info('定时任务调度已启动', { entries: this.entries.size, distributed: this.deps.guard.distributed });
  }

  /** 停止调度并等待在途触发 */
  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    const deadline = this.now() + 5000;
    while (this.inflight > 0 && this.now() < deadline) {
      await new Promise<void>((resolve) => {
        const handle = this.setTimer(resolve, 5);
        handle.unref?.();
      });
    }
  }

  /** 运行快照（管理面与冒烟断言用） */
  snapshot(): CronSnapshot[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      expression: entry.expression,
      lock: entry.lock,
      nextRunAt: entry.nextRunAt > 0 ? new Date(entry.nextRunAt).toISOString() : null,
      runs: entry.runs,
      lockedOut: entry.lockedOut,
      lastResult: entry.lastResult,
      lastRunAt: entry.lastRunAt,
    }));
  }

  /**
   * 手动触发（运维按钮与冒烟验证；仍走分布式锁语义）
   * @param name 任务名（缺省触发全部）
   * @returns 每条条目的触发结果
   */
  async tick(name?: string): Promise<Array<{ name: string; acquired: boolean }>> {
    const targets = name ? [this.entries.get(name)].filter((entry): entry is CronEntry => entry !== undefined) : [...this.entries.values()];
    const out: Array<{ name: string; acquired: boolean }> = [];
    for (const entry of targets) {
      out.push({ name: entry.name, acquired: await this.fireEntry(entry) });
    }
    return out;
  }

  /** 安排下一次唤醒（单一 timer，按最近触发时刻） */
  private reschedule(): void {
    if (!this.running || this.entries.size === 0) return;
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    let next = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) next = Math.min(next, entry.nextRunAt);
    if (!Number.isFinite(next)) return;
    const delay = Math.max(0, Math.min(next - this.now(), MAX_TIMER_MS));
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.onTimer();
    }, delay);
    this.timer.unref?.();
  }

  /** 定时器回调：触发全部到期条目后重排 */
  private async onTimer(): Promise<void> {
    const now = this.now();
    const due = [...this.entries.values()].filter((entry) => entry.nextRunAt <= now);
    for (const entry of due) {
      entry.nextRunAt = entry.parsed.next(new Date(now)).getTime();
      this.inflight++;
      try {
        await this.fireEntry(entry);
      } catch (error) {
        logger.error('定时任务触发异常', { name: entry.name, error: error instanceof Error ? error.message : String(error) });
      } finally {
        this.inflight--;
      }
    }
    this.reschedule();
  }

  /**
   * 触发单条条目：加锁 → 执行 → 释放
   * @param entry 条目
   * @returns 是否真正执行（未拿到锁返回 false）
   */
  private async fireEntry(entry: CronEntry): Promise<boolean> {
    this.deps.metrics.cronTick();
    let handle: GuardLockHandle | null = null;
    if (entry.lock) {
      handle = await this.deps.guard.acquireLock(`cron:${entry.name}`, entry.lockTtlSeconds);
      if (!handle) {
        entry.lockedOut++;
        this.deps.metrics.cronLockOut();
        logger.debug('定时任务未取得分布式锁，跳过本次', { name: entry.name, lockedOut: entry.lockedOut });
        return false;
      }
    }
    entry.inflight = true;
    try {
      await withTimeout(() => entry.handler(), entry.timeoutMs, () => new Error(`定时任务执行超时：${entry.name}`));
      entry.lastResult = 'ok';
      entry.runs++;
      logger.info('定时任务执行完成', { name: entry.name, runs: entry.runs });
    } catch (error) {
      entry.lastResult = 'error';
      entry.runs++;
      logger.error('定时任务执行失败', { name: entry.name, error: error instanceof Error ? error.message : String(error) });
    } finally {
      entry.inflight = false;
      entry.lastRunAt = new Date(this.now()).toISOString();
      if (handle) await handle.release();
    }
    return true;
  }
}
