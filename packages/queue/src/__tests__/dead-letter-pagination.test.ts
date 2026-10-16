/*
 * @file 单测：死信列表分页（@fw/queue 体验债收口）
 * @description 死信随失败累积无界增长，全量返回会同时拖垮管理页首屏与响应体。本组验证
 *   窗口下推全链路：驱动侧切片（offset/limit 语义 + 最新失败在前）、服务层页码与页大小
 *   收敛（越界值收到合法区间而非报错）、管理端点响应携带 page/pageSize 且 total 为
 *   过滤条件全集条数（非本页条数）。不传窗口时保持旧语义（全量），既有调用方零改动。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/queue
 */

import { afterEach, describe, expect, it } from 'vitest';
import { QueueAdminController } from '../admin.controller.js';
import { CronScheduler } from '../scheduler.js';
import { createQueueFixture, makeRecord, waitFor, type QueueFixture } from './test-helpers.js';

let fixture: QueueFixture | undefined;

afterEach(async () => {
  await fixture?.stop();
  fixture = undefined;
});

/** 失败即死信的 runner（attempts=1 无重试） */
function failingRunner() {
  return {
    run: async () => {
      throw new Error('必然失败');
    },
    onDeadLetter: () => undefined,
  };
}

/**
 * 灌入指定数量的死信。每条之间留出时间差，保证 failedAt 有序（最新失败排最前）。
 */
async function seedDeadLetters(target: QueueFixture, count: number, queue = 'default'): Promise<string[]> {
  const ids: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const id = `dl-${String(i + 1).padStart(3, '0')}`;
    ids.push(id);
    await target.driver.enqueue(makeRecord({ id, queue, name: 'always.fail', attempts: 1, backoff: [] }));
    await waitFor(async () => (await target.driver.listDeadLetters()).length >= i + 1, `死信 ${id} 入库`, 3000);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return ids;
}

describe('死信分页（窗口下推）', () => {
  it('驱动侧：窗口切片 offset/limit，最新失败在前；count 与列表同口径', async () => {
    fixture = createQueueFixture();
    await fixture.driver.start(failingRunner());
    const ids = await seedDeadLetters(fixture, 5);

    const all = await fixture.driver.listDeadLetters();
    expect(all).toHaveLength(5);
    // 最新失败在前（后入库的 failedAt 更大）
    expect(all.map((item) => item.id)).toEqual([...ids].reverse());
    expect(await fixture.driver.countDeadLetters()).toBe(5);

    const window = await fixture.driver.listDeadLetters(undefined, { offset: 1, limit: 2 });
    expect(window.map((item) => item.id)).toEqual([ids[3], ids[2]]);

    // 越界窗口不抛错：收敛到空集
    expect(await fixture.driver.listDeadLetters(undefined, { offset: 99, limit: 10 })).toHaveLength(0);
    expect(await fixture.driver.listDeadLetters(undefined, { offset: 0, limit: 0 })).toHaveLength(0);
  });

  it('驱动侧：按队列名过滤时窗口与计数同口径', async () => {
    fixture = createQueueFixture();
    await fixture.driver.start(failingRunner());
    await seedDeadLetters(fixture, 2, 'exports');
    await seedDeadLetters(fixture, 3, 'default');

    expect(await fixture.driver.countDeadLetters('exports')).toBe(2);
    expect(await fixture.driver.countDeadLetters()).toBe(5);
    const page = await fixture.driver.listDeadLetters('exports', { offset: 1, limit: 5 });
    expect(page).toHaveLength(1);
    expect(page.every((item) => item.queue === 'exports')).toBe(true);
  });

  it('服务层：pageDeadLetters 页码 / 页大小越界收敛，total 为全集条数', async () => {
    fixture = createQueueFixture();
    await fixture.driver.start(failingRunner());
    await seedDeadLetters(fixture, 5);

    const first = await fixture.queue.pageDeadLetters(undefined, 1, 2);
    expect(first).toMatchObject({ total: 5, page: 1, pageSize: 2 });
    expect(first.items).toHaveLength(2);

    const second = await fixture.queue.pageDeadLetters(undefined, 3, 2);
    expect(second.page).toBe(3);
    expect(second.items).toHaveLength(1); // 最后一页

    // 页码 0 / 负值收敛到 1；页大小越界收敛到 [1, 200]（MQ_DEAD_LETTER_PAGE_MAX 默认值）
    const clamped = await fixture.queue.pageDeadLetters(undefined, 0, 999);
    expect(clamped).toMatchObject({ page: 1, pageSize: 200 });
    const nan = await fixture.queue.pageDeadLetters(undefined, Number.NaN, Number.NaN);
    expect(nan).toMatchObject({ page: 1, pageSize: 20 });

    // M10/E-16：页大小上限可配（MQ_DEAD_LETTER_PAGE_MAX 覆盖后按配置值钳制）
    const custom = createQueueFixture({ deadLetterPageSizeMax: 5 });
    try {
      const capped = await custom.queue.pageDeadLetters(undefined, 1, 999);
      expect(capped).toMatchObject({ page: 1, pageSize: 5 });
    } finally {
      await custom.stop();
    }

    // 与旧接口行为兼容：不传窗口仍是全量
    expect(await fixture.queue.listDeadLetters()).toHaveLength(5);
  });

  it('管理端点：响应携带 page/pageSize，与 listDeadLetters 窗口语义一致', async () => {
    fixture = createQueueFixture();
    await fixture.driver.start(failingRunner());
    await seedDeadLetters(fixture, 5);
    const scheduler = new CronScheduler({ guard: fixture.guard, metrics: fixture.metrics, enabled: true, defaultTimeoutMs: 1000 });
    const controller = new QueueAdminController(fixture.queue, scheduler);

    const response = await controller.deadLetters(undefined, '2', '3');
    expect(response.total).toBe(5);
    expect(response.page).toBe(2);
    expect(response.pageSize).toBe(3);
    expect(response.items).toHaveLength(2); // 第 2 页：5 - 3 = 2 条

    // 缺省分页参数 = 第一页 + 20 条上限（旧调用方零改动）
    const legacy = await controller.deadLetters(undefined, '1', '20');
    expect(legacy.items).toHaveLength(5);
    expect(legacy.total).toBe(5);
  });
});
