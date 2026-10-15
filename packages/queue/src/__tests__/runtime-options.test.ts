/*
 * @file 运行时选项热更测试（M9/PRD-009 FR-09）
 * @description 验证并发 / 限速热更的生效路径：memory 驱动就地更新即时生效（stats 与消费循环读取同一选项对象）、
 *   QueueService 就地更新并下推驱动（未实现 applyRuntimeOptions 的驱动被安全忽略）。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/queue
 */
import { describe, expect, it } from 'vitest';
import { MemoryQueueDriver } from '../drivers/memory.driver.js';
import { QueueService } from '../queue.service.js';
import { MemoryGuardStore } from '../guard-store.js';
import type { QueueDriverPort, QueueRuntimeOptions } from '../types.js';

/** 最小驱动桩（未实现 applyRuntimeOptions——验证可选能力的安全忽略路径） */
function makeStubDriver(applied: Array<Record<string, unknown>> = []): QueueDriverPort {
  return {
    kind: 'memory',
    async start() {},
    async enqueue() {},
    ensureQueue() {},
    async cancel() {
      return true;
    },
    async pause() {},
    async resume() {},
    async drain() {
      return 0;
    },
    async stats() {
      return { driver: 'memory', queues: [], totals: { waiting: 0, active: 0, completed: 0, failed: 0, delayed: 0, deadLetter: 0 } } as never;
    },
    async listDeadLetters() {
      return [];
    },
    async countDeadLetters() {
      return 0;
    },
    async requeueDeadLetter() {
      return true;
    },
    async purgeDeadLetters() {
      return 0;
    },
    async ping() {
      return true;
    },
    async close() {
      return 0;
    },
    // 刻意不实现 applyRuntimeOptions：验证可选能力
    ...(applied.length >= 0 ? {} : {}),
  };
}

function makeOptions(overrides: Partial<QueueRuntimeOptions> = {}): QueueRuntimeOptions {
  return {
    driver: 'memory',
    url: undefined,
    prefix: 'fw:test',
    concurrency: 1,
    maxAttempts: 4,
    backoff: [1000, 5000, 30000],
    jobTimeoutMs: 60_000,
    cronEnabled: false,
    rateLimit: 0,
    deadLetterMax: 1000,
    shutdownTimeoutMs: 30_000,
    stalledIntervalMs: 30_000,
    ...overrides,
  };
}

describe('MemoryQueueDriver · applyRuntimeOptions（热更生效路径）', () => {
  it('就地更新并发与限速：stats 反映新并发（消费循环逐次读取同一选项对象）', async () => {
    const driver = new MemoryQueueDriver({ concurrency: 1, rateLimit: 0, deadLetterMax: 10 });
    await driver.start({
      run: async () => undefined,
      onDeadLetter: () => undefined,
    });
    driver.ensureQueue('default');

    driver.applyRuntimeOptions({ concurrency: 5, rateLimit: 20 });

    const stats = await driver.stats();
    expect(stats.queues[0]?.concurrency).toBe(5);
    expect(stats.queues[0]?.rateLimit).toBe(20);
  });
});

describe('QueueService · updateRuntimeOptions（配置中心订阅入口）', () => {
  it('就地更新服务选项并下推驱动；驱动未实现该能力时安全忽略', async () => {
    const driver = makeStubDriver();
    const options = makeOptions();
    const service = new QueueService({ driver, options, guard: new MemoryGuardStore() });

    service.updateRuntimeOptions({ concurrency: 8, rateLimit: 50 });

    expect(options.concurrency).toBe(8);
    expect(options.rateLimit).toBe(50);
  });
});
