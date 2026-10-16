/*
 * @file memory 驱动单测
 * @description 覆盖进程内驱动的队列语义：延时与优先级、并发上限、令牌桶限速、
 *   最大执行次数与退避序列（真实等待毫秒级序列）、死信上限与重放、暂停/恢复/清空/取消、
 *   以及优雅停机时「未完成任务重新入队」（PRD-007 FR-06/FR-07/FR-08/FR-10，TC-JOB-003/004/005/007）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-16 donttemo 驱动审查修复配套：新增每队列限速隔离、假时钟停机不死循环、
 *   失败处理链路异常隔离、死信 payload 深拷贝与同毫秒 tie-breaker、options 防污染回归用例
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { MemoryQueueDriver } from '../drivers/memory.driver.js';
import { PermanentJobError } from '../errors.js';
import type { JobRunner } from '../driver.port.js';
import type { JobRecord } from '../types.js';
import { makeRecord, waitFor } from './test-helpers.js';

/** 记录型执行器 */
function makeRunner(onRun: (record: JobRecord) => Promise<void>): JobRunner & { deadLetters: Array<{ id: string; reason: string }> } {
  const deadLetters: Array<{ id: string; reason: string }> = [];
  return {
    deadLetters,
    run: onRun,
    onDeadLetter: (record, reason) => deadLetters.push({ id: record.id, reason }),
  };
}

/** 空闲等待（让出事件循环） */
const tick = (ms = 20): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** 构造驱动 */
function makeDriver(overrides: Partial<{ concurrency: number; rateLimit: number; deadLetterMax: number }> = {}): MemoryQueueDriver {
  return new MemoryQueueDriver({ concurrency: 1, rateLimit: 0, deadLetterMax: 10, ...overrides });
}

describe('MemoryQueueDriver 基本语义', () => {
  it('入队后异步执行；ping 恒为 true；统计反映驱动与完成数', async () => {
    const driver = makeDriver();
    const executed: string[] = [];
    await driver.start(makeRunner(async (record) => void executed.push(record.id)));
    const record = makeRecord();
    await driver.enqueue(record);
    await waitFor(() => executed.length === 1, '任务执行');
    expect(executed[0]).toBe(record.id);
    expect(await driver.ping()).toBe(true);
    const stats = await driver.stats();
    expect(stats.driver).toBe('memory');
    expect(stats.consuming).toBe(true);
    expect(stats.totals.completed).toBe(1);
    expect(stats.queues[0].concurrency).toBe(1);
    await driver.close();
  });

  it('延时任务在执行时刻之前保持等待', async () => {
    const driver = makeDriver();
    const executed: string[] = [];
    await driver.start(makeRunner(async (record) => void executed.push(record.id)));
    await driver.enqueue(makeRecord({ runAt: Date.now() + 120 }));
    await tick(60);
    expect(executed).toHaveLength(0);
    expect(driver.pendingCount()).toBe(1);
    await waitFor(() => executed.length === 1, '延时任务到期执行');
    await driver.close();
  });

  it('优先级高（数字小）者先执行', async () => {
    const driver = makeDriver();
    const order: string[] = [];
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await driver.start(
      makeRunner(async (record) => {
        order.push(record.name);
        if (record.name === 'hold') await gate;
      }),
    );
    await driver.enqueue(makeRecord({ name: 'hold' }));
    await waitFor(() => order.length === 1, '占位任务开始执行');
    await driver.enqueue(makeRecord({ name: 'low', priority: 5 }));
    await driver.enqueue(makeRecord({ name: 'high', priority: 1 }));
    release?.();
    await waitFor(() => order.length === 3, '全部执行');
    expect(order).toEqual(['hold', 'high', 'low']);
    await driver.close();
  });

  it('并发上限生效', async () => {
    const driver = makeDriver({ concurrency: 2 });
    let current = 0;
    let peak = 0;
    await driver.start(
      makeRunner(async () => {
        current++;
        peak = Math.max(peak, current);
        await tick(30);
        current--;
      }),
    );
    for (let i = 0; i < 6; i++) await driver.enqueue(makeRecord());
    await waitFor(() => peak >= 2, '并发达到上限');
    await tick(150);
    expect(peak).toBeLessThanOrEqual(2);
    expect((await driver.stats()).totals.completed).toBe(6);
    await driver.close();
  });

  it('令牌桶限速：突发超过速率时被推迟（TC-JOB-007）', async () => {
    const driver = makeDriver({ concurrency: 10, rateLimit: 5 });
    const stamps: number[] = [];
    await driver.start(makeRunner(async () => void stamps.push(Date.now())));
    for (let i = 0; i < 8; i++) await driver.enqueue(makeRecord());
    await waitFor(() => stamps.length === 8, '全部任务执行', 5000);
    // 容量 5 的令牌桶：前 5 个突发通过，第 6 个须等 1000/5 = 200ms 补充一个令牌
    expect(stamps[5] - stamps[0]).toBeGreaterThanOrEqual(150);
    expect(stamps[7] - stamps[0]).toBeGreaterThanOrEqual(500);
    await driver.close();
  });

  it('暂停时不消费，恢复后继续', async () => {
    const driver = makeDriver();
    const executed: string[] = [];
    await driver.start(makeRunner(async (record) => void executed.push(record.id)));
    await driver.pause();
    await driver.enqueue(makeRecord());
    await tick(40);
    expect(executed).toHaveLength(0);
    expect((await driver.stats()).paused).toBe(true);
    expect((await driver.stats()).consuming).toBe(false);
    await driver.resume();
    await waitFor(() => executed.length === 1, '恢复后执行');
    await driver.close();
  });

  it('清空与取消', async () => {
    const driver = makeDriver();
    await driver.start(makeRunner(async () => undefined));
    await driver.pause();
    const a = makeRecord();
    const b = makeRecord();
    await driver.enqueue(a);
    await driver.enqueue(b);
    expect(await driver.cancel(a.id)).toBe(true);
    expect(await driver.cancel('not-exist')).toBe(false);
    expect(await driver.drain()).toBe(1);
    expect(driver.pendingCount()).toBe(0);
    await driver.resume();
    await driver.close();
  });
});

describe('MemoryQueueDriver 失败链路（TC-JOB-003/004）', () => {
  it('按退避序列重试，耗尽后进死信（真实等待毫秒级序列）', async () => {
    const driver = makeDriver();
    let attempts = 0;
    const stamps: number[] = [];
    const runner = makeRunner(async () => {
      attempts++;
      stamps.push(Date.now());
      throw new Error('下游故障');
    });
    await driver.start(runner);
    const record = makeRecord({ attempts: 4, backoff: [10, 20, 30], name: 'flaky' });
    await driver.enqueue(record);
    await waitFor(() => runner.deadLetters.length === 1, '进入死信', 5000);

    expect(attempts).toBe(4); // 首次 + 3 次重试
    expect(stamps[1] - stamps[0]).toBeGreaterThanOrEqual(8); // 第 1 次重试等待第 1 项
    expect(stamps[2] - stamps[1]).toBeGreaterThanOrEqual(18); // 第 2 次重试等待第 2 项
    expect(stamps[3] - stamps[2]).toBeGreaterThanOrEqual(28); // 第 3 次重试等待第 3 项
    expect(runner.deadLetters[0].reason).toContain('下游故障');

    const dead = await driver.listDeadLetters();
    expect(dead).toHaveLength(1);
    expect(dead[0].id).toBe(record.id);
    expect(dead[0].attemptsMade).toBe(4);
    expect(dead[0].queue).toBe('default');
    await driver.close();
  });

  it('死信可重放且计数归零（TC-JOB-004）', async () => {
    const driver = makeDriver();
    let fail = true;
    let success = 0;
    const runner = makeRunner(async () => {
      if (fail) throw new Error('临时故障');
      success++;
    });
    await driver.start(runner);
    await driver.enqueue(makeRecord({ attempts: 2, backoff: [5], name: 'retry-me' }));
    await waitFor(() => runner.deadLetters.length === 1, '进入死信', 3000);
    const dead = await driver.listDeadLetters();
    expect(dead).toHaveLength(1);

    fail = false;
    expect(await driver.requeueDeadLetter(dead[0].id)).toBe(true);
    await waitFor(() => success === 1, '重放成功');
    await waitFor(() => driver.pendingCount() === 0, '重放任务已消费');
    expect(await driver.listDeadLetters()).toHaveLength(0);
    expect(await driver.requeueDeadLetter('not-exist')).toBe(false);
    await driver.close();
  });

  it('终态失败（PermanentJobError）不重试，直接进死信', async () => {
    const driver = makeDriver();
    let attempts = 0;
    const runner = makeRunner(async () => {
      attempts++;
      throw new PermanentJobError('参数非法，重试无意义');
    });
    await driver.start(runner);
    await driver.enqueue(makeRecord({ attempts: 5, backoff: [5, 5], name: 'permanent' }));
    await waitFor(() => runner.deadLetters.length === 1, '直接进死信');
    expect(attempts).toBe(1);
    await driver.close();
  });

  it('死信上限生效：超出后丢弃最旧，purge 清空', async () => {
    const driver = makeDriver({ deadLetterMax: 2 });
    await driver.start(
      makeRunner(async () => {
        throw new Error('always fail');
      }),
    );
    for (let i = 0; i < 4; i++) await driver.enqueue(makeRecord({ name: `fail-${i}`, attempts: 1 }));
    await waitFor(() => driver.pendingCount() === 0, '全部任务已被消费');
    const dead = await driver.listDeadLetters();
    expect(dead).toHaveLength(2);
    expect(dead.map((item) => item.name).sort()).toEqual(['fail-2', 'fail-3']);
    expect(await driver.purgeDeadLetters()).toBe(2);
    expect(await driver.listDeadLetters()).toHaveLength(0);
    await driver.close();
  });
});

describe('MemoryQueueDriver 停机（FR-10 / TC-JOB-005）', () => {
  it('停机等待在途任务完成', async () => {
    const driver = makeDriver();
    let finished = false;
    await driver.start(
      makeRunner(async () => {
        await tick(60);
        finished = true;
      }),
    );
    await driver.enqueue(makeRecord());
    await waitFor(() => driver.pendingCount() === 0, '任务已被取出');
    const requeued = await driver.close(500);
    expect(finished).toBe(true);
    expect(requeued).toBe(0);
  });

  it('停机超时后在途任务重新入队（驱动侧语义）', async () => {
    const driver = makeDriver();
    await driver.start(
      makeRunner(async () => {
        await tick(400);
      }),
    );
    await driver.enqueue(makeRecord({ name: 'slow' }));
    await waitFor(() => driver.pendingCount() === 0, '任务已被取出');
    const requeued = await driver.close(30);
    expect(requeued).toBe(1);
    expect(driver.pendingCount()).toBe(1); // 已重新回到等待队列
  });

  it('停机后拒绝新任务', async () => {
    const driver = makeDriver();
    await driver.start(makeRunner(async () => undefined));
    await driver.close(0);
    await expect(driver.enqueue(makeRecord())).rejects.toThrow(/停机/);
  });

  it('start 可重复调用；未知队列统计为零', async () => {
    const driver = makeDriver();
    const runner = makeRunner(async () => undefined);
    await driver.start(runner);
    await driver.start(runner);
    await driver.ensureQueue('extra');
    const stats = await driver.stats(['extra', 'unknown']);
    expect(stats.queues.map((item) => item.name)).toEqual(['extra', 'unknown']);
    expect(stats.totals.waiting).toBe(0);
    await driver.close();
  });

  it('重新 start 后继续消费停机时排队的任务', async () => {
    const driver = makeDriver();
    const executed: string[] = [];
    await driver.start(makeRunner(async (record) => void executed.push(record.id)));
    await driver.pause();
    await driver.enqueue(makeRecord());
    await driver.close(0);
    await driver.start(makeRunner(async (record) => void executed.push(record.id)));
    await driver.resume();
    await waitFor(() => executed.length === 1, '重启后继续执行');
    await driver.close();
  });
});

describe('MemoryQueueDriver 驱动审查修复回归', () => {
  it('限速按队列生效：一队列令牌耗尽不阻塞其他队列（与 bullmq per-Worker limiter 对齐）', async () => {
    const driver = makeDriver({ concurrency: 10, rateLimit: 1 });
    const executed: string[] = [];
    await driver.start(makeRunner(async (record) => void executed.push(record.name)));
    // busy 队列灌 5 个：容量 1、每秒补 1，第 1 个拿走满桶后其余只能排队等补充
    for (let i = 0; i < 5; i++) await driver.enqueue(makeRecord({ queue: 'busy', name: `busy-${i}` }));
    // idle 队列 1 个：必须立即执行，不被 busy 队列的限速拖住（旧实现全局单桶会被饿死）
    await driver.enqueue(makeRecord({ queue: 'idle', name: 'idle-1' }));
    await waitFor(() => executed.includes('idle-1'), '其他队列不受限速队列阻塞', 500);
    expect(executed[0]).toBe('busy-0'); // 入堆序在前者先拿各自队列的满桶
    await driver.close();
  });

  it('假时钟下 close() 不死循环：等待真实在途 Promise + 独立超时定时器', async () => {
    const fakeNow = 1_000_000; // 恒定时钟：旧实现按 now() 推进 deadline 永不满足 → 轮询死循环
    const driver = new MemoryQueueDriver({ concurrency: 1, rateLimit: 0, deadLetterMax: 10, now: () => fakeNow });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await driver.start(makeRunner(async () => void (await gate)));
    await driver.enqueue(makeRecord({ name: 'stuck', runAt: fakeNow }));
    await waitFor(() => driver.pendingCount() === 0, '任务已被取出');
    const requeued = await driver.close(50);
    expect(requeued).toBe(1);
    expect(driver.pendingCount()).toBe(1);
    release?.();
  }, 3000);

  it('失败处理链路异常被隔离：onDeadLetter 抛错不产生 unhandled rejection，消费循环继续', async () => {
    const driver = makeDriver();
    const processed: string[] = [];
    const runner = makeRunner(async (record) => {
      if (record.name === 'boom') throw new Error('必然失败');
      processed.push(record.name);
    });
    runner.onDeadLetter = () => {
      throw new Error('告警回调炸了');
    };
    await driver.start(runner);
    await driver.enqueue(makeRecord({ name: 'boom', attempts: 1 }));
    await driver.enqueue(makeRecord({ name: 'after-boom' }));
    await waitFor(() => processed.includes('after-boom'), '后续任务照常消费', 3000);
    expect((await driver.listDeadLetters()).map((item) => item.name)).toContain('boom');
    await driver.close();
  });

  it('listDeadLetters 返回深拷贝 payload：修改返回项不污染归档与重放', async () => {
    const driver = makeDriver();
    let fail = true;
    const payloads: unknown[] = [];
    const runner = makeRunner(async (record) => {
      if (fail) throw new Error('临时故障');
      payloads.push(record.payload);
    });
    await driver.start(runner);
    await driver.enqueue(makeRecord({ attempts: 2, backoff: [5], payload: { v: 1 } }));
    await waitFor(() => runner.deadLetters.length === 1, '进入死信', 3000);
    const [dead] = await driver.listDeadLetters();
    (dead.payload as { v: number }).v = 999;
    fail = false;
    expect(await driver.requeueDeadLetter(dead.id)).toBe(true);
    await waitFor(() => payloads.length === 1, '重放执行', 3000);
    expect(payloads[0]).toEqual({ v: 1 }); // 归档数据未被视图修改污染
    await driver.close();
  });

  it('listDeadLetters 同毫秒失败按归档序倒序（tie-breaker 保证翻页稳定）', async () => {
    const driver = new MemoryQueueDriver({ concurrency: 1, rateLimit: 0, deadLetterMax: 10, now: () => 1_000_000 });
    const runner = makeRunner(async () => {
      throw new Error('always fail');
    });
    await driver.start(runner);
    const ids: string[] = [];
    for (let i = 0; i < 4; i++) {
      const id = `same-ms-${i}`;
      ids.push(id);
      await driver.enqueue(makeRecord({ id, name: 'fail', attempts: 1, runAt: 1_000_000 }));
      // 用同步条件等待（onDeadLetter 回调计数）；waitFor 逐轮 sleep 5ms 让事件循环
      // 得以触发唤醒定时器——async 条件在这里不可用（Promise 恒真值，等待形同虚设）
      await waitFor(() => runner.deadLetters.length >= i + 1, `死信 ${id} 归档`, 3000);
    }
    // failedAt 全部相同（固定时钟）：排序回落归档序倒序（后归档在前），两次读取结果一致
    const first = (await driver.listDeadLetters()).map((item) => item.id);
    const second = (await driver.listDeadLetters()).map((item) => item.id);
    expect(first).toEqual([...ids].reverse());
    expect(first).toEqual(second);
    await driver.close();
  });

  it('applyRuntimeOptions 只改驱动私有副本，不回写构造入参对象', async () => {
    const options = { concurrency: 1, rateLimit: 0, deadLetterMax: 10 };
    const driver = new MemoryQueueDriver(options);
    driver.ensureQueue('default');
    driver.applyRuntimeOptions({ concurrency: 5 });
    expect(options.concurrency).toBe(1); // 传入对象未被污染（多实例防串扰）
    expect((await driver.stats()).queues[0]?.concurrency).toBe(5); // 驱动副本即时生效
  });
});
