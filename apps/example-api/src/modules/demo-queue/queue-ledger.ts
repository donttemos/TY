/*
 * @file 队列执行台账（M7 验收载体）
 * @description 进程内记录每个任务/定时任务的执行次数、并发峰值与最近一次载荷摘要，
 *   供 scripts/smoke-queue.mjs 断言「重试次数正确」「并发不超过上限」「幂等只跑一次」等 PRD-007 AC。
 *   仅用于演示与自检，不承载业务数据；进程重启即清空。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/demo-queue
 */

import { Injectable } from '@nestjs/common';

/** 单个任务名的台账 */
export interface LedgerEntry {
  /** 成功执行次数 */
  count: number;
  /** 当前执行中数量（并发观测） */
  active: number;
  /** 并发峰值 */
  maxConcurrent: number;
  /** 累计执行耗时（毫秒） */
  totalMs: number;
  /** 最近一次执行时刻（epoch 毫秒） */
  lastAt: number | null;
  /** 最近一次执行的附加信息（载荷摘要、attempt 等） */
  lastExtra: Record<string, unknown> | null;
}

/** 台账快照（对外返回 shape：时间字段转为 ISO 8601） */
export interface LedgerSnapshot extends Omit<LedgerEntry, 'lastAt'> {
  /** 任务名 */
  name: string;
  /** 最近一次执行时刻（ISO 8601） */
  lastAt: string | null;
}

/**
 * 执行台账：按任务名聚合
 */
@Injectable()
export class QueueLedger {
  private readonly entries = new Map<string, LedgerEntry>();

  /**
   * 标记任务开始执行（并发计数 +1）
   * @param name 任务名
   */
  enter(name: string): void {
    const entry = this.ensure(name);
    entry.active++;
    if (entry.active > entry.maxConcurrent) entry.maxConcurrent = entry.active;
  }

  /**
   * 标记任务执行结束（并发计数 -1）
   * @param name 任务名
   */
  leave(name: string): void {
    const entry = this.ensure(name);
    entry.active = Math.max(0, entry.active - 1);
  }

  /**
   * 记录一次成功执行
   * @param name 任务名
   * @param durationMs 执行耗时
   * @param extra 附加信息
   */
  record(name: string, durationMs = 0, extra?: Record<string, unknown>): void {
    const entry = this.ensure(name);
    entry.count++;
    entry.totalMs += durationMs;
    entry.lastAt = Date.now();
    entry.lastExtra = extra ?? null;
  }

  /**
   * 读取单个任务名的台账
   * @param name 任务名
   */
  get(name: string): LedgerSnapshot {
    const entry = this.ensure(name);
    return { name, ...entry, lastAt: entry.lastAt === null ? null : new Date(entry.lastAt).toISOString() };
  }

  /** 全部台账（按任务名排序） */
  snapshot(): LedgerSnapshot[] {
    return [...this.entries.keys()]
      .sort()
      .map((name) => this.get(name));
  }

  /** 清空台账（冒烟分阶段复位） */
  reset(): void {
    this.entries.clear();
  }

  /** 取或建台账项 */
  private ensure(name: string): LedgerEntry {
    let entry = this.entries.get(name);
    if (!entry) {
      entry = { count: 0, active: 0, maxConcurrent: 0, totalMs: 0, lastAt: null, lastExtra: null };
      this.entries.set(name, entry);
    }
    return entry;
  }
}
