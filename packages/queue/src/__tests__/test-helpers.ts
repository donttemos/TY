/*
 * @file 单测公共夹具
 * @description 统一构造队列运行时配置、内存驱动 + 内存守卫的服务实例，以及轮询等待工具。
 *   单测一律使用真实定时器与毫秒级退避序列（不 mock 时钟），避免「假绿」。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { MemoryQueueDriver, type MemoryDriverOptions } from '../drivers/memory.driver.js';
import { MemoryGuardStore } from '../guard-store.js';
import { QueueMetrics } from '../metrics.js';
import { QueueService } from '../queue.service.js';
import type { DeadLetterRecord, JobRecord, QueueRuntimeOptions } from '../types.js';

/** 默认运行时配置（退避序列压到毫秒级，保证单测快速且真实） */
export function makeRuntime(overrides: Partial<QueueRuntimeOptions> = {}): QueueRuntimeOptions {
  return {
    driver: 'memory',
    url: undefined,
    prefix: 'fw:test',
    concurrency: 10,
    maxAttempts: 4,
    backoff: [10, 20, 30],
    jobTimeoutMs: 1000,
    cronEnabled: true,
    rateLimit: 0,
    deadLetterMax: 100,
    deadLetterPageSizeMax: 200,
    shutdownTimeoutMs: 200,
    ...overrides,
  };
}

/** 队列测试环境 */
export interface QueueFixture {
  /** 队列服务 */
  queue: QueueService;
  /** 内存驱动（可直接断言 pending） */
  driver: MemoryQueueDriver;
  /** 内存守卫存储 */
  guard: MemoryGuardStore;
  /** 指标采集器 */
  metrics: QueueMetrics;
  /** 生效的运行时配置 */
  runtime: QueueRuntimeOptions;
  /** 停机 */
  stop(): Promise<void>;
}

/**
 * 构造 memory 驱动 + 内存守卫的队列环境
 * @param overrides 运行时配置覆盖
 * @param driverOptions 驱动选项覆盖
 * @param alert 死信告警回调（可选）
 */
export function createQueueFixture(
  overrides: Partial<QueueRuntimeOptions> = {},
  driverOptions: Partial<MemoryDriverOptions> = {},
  alert?: (record: DeadLetterRecord, reason: string) => void,
): QueueFixture {
  const runtime = makeRuntime(overrides);
  const driver = new MemoryQueueDriver({
    concurrency: runtime.concurrency,
    rateLimit: runtime.rateLimit,
    deadLetterMax: runtime.deadLetterMax,
    ...driverOptions,
  });
  const guard = new MemoryGuardStore();
  const metrics = new QueueMetrics();
  const queue = new QueueService({ driver, options: runtime, guard, metrics, alert });
  return { queue, driver, guard, metrics, stop: () => queue.shutdown().then(() => undefined), runtime };
}

/**
 * 轮询等待条件成立
 * @param condition 条件
 * @param label 超时提示
 * @param timeoutMs 超时上限
 */
export async function waitFor(condition: () => boolean, label = '条件', timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`等待超时：${label}（${timeoutMs}ms）`);
}

/**
 * 构造任务记录（驱动级测试直接入队用）
 * @param overrides 字段覆盖
 */
export function makeRecord(overrides: Partial<JobRecord> = {}): JobRecord {
  return {
    id: `job-${Math.random().toString(36).slice(2, 10)}`,
    queue: 'default',
    name: 'demo',
    payload: {},
    attempts: 1,
    attemptsMade: 0,
    backoff: [],
    runAt: Date.now(),
    priority: 0,
    timeoutMs: 1000,
    enqueuedAt: Date.now(),
    ...overrides,
  };
}
