/*
 * @file 单测：SSE 实时推送服务（EventsService）
 * @description 覆盖 E-12 服务侧语义：票据签发（主题按权限裁剪）/ 一次性核销（并发核销只有一个
 *   成功）/ 过期与非法票据拒绝 / 事件发布委托与失败降级 / 积压巡检的边沿触发（跨阈值只告警一次，
 *   回落复位）。列表与票据用桩驱动，不依赖真实 Redis / 队列。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/events
 */

import { describe, expect, it, vi } from 'vitest';
import type { CacheStorePort } from '@fw/cache';
import type { QueueService, QueueStats } from '@fw/queue';
import type { TransportService } from '@fw/transport';
import type { RequestUser } from '@fw/auth';
import { EventsService, JOB_TOPIC, QUEUE_TOPIC } from './events.service.js';
import { setQueueAlertSink } from './queue-alerts.js';
import { setJobEventSink } from '../jobs/job-events.js';

/** 票据存储桩：内存 Map + TTL 秒级忽略（单测周期远小于 TTL） */
function makeStore(): CacheStorePort {
  const map = new Map<string, string>();
  return {
    kind: 'memory',
    get: async (key: string) => map.get(key),
    set: async (key: string, value: string) => {
      map.set(key, value);
    },
    setNx: async (key: string, value: string) => (map.has(key) ? false : (map.set(key, value), true)),
    del: async (keys: readonly string[]) => {
      let removed = 0;
      for (const key of keys) if (map.delete(key)) removed += 1;
      return removed;
    },
    exists: async (key: string) => map.has(key),
    expire: async () => false,
    mget: async (keys: readonly string[]) => keys.map((key) => map.get(key)),
    sadd: async () => undefined,
    smembers: async () => [],
    compareAndDelete: async () => false,
    compareAndExpire: async () => false,
    tokenBucketTake: async () => ({ allowed: true, remaining: 0, retryAfterMs: 0 }),
    ping: async () => true,
    close: async () => undefined,
  } as unknown as CacheStorePort;
}

/** 传输服务桩：记录发布与订阅；`fail` 置真模拟事件面不可用 */
function makeTransport(): { published: Array<{ topic: string; payload: unknown }>; state: { fail: boolean }; service: TransportService } {
  const published: Array<{ topic: string; payload: unknown }> = [];
  const state = { fail: false };
  const service = {
    publish: async (topic: string, payload: unknown) => {
      if (state.fail) throw new Error('redis down');
      published.push({ topic, payload });
    },
    subscribe: async () => () => undefined,
    stats: () => ({ events: { published: published.length, received: 0, topics: 0, topicList: [] } }),
  } as unknown as TransportService;
  return { published, state, service };
}

/** 队列服务桩：可切换等待数 */
function makeQueue(waiting: number): { service: QueueService; setWaiting: (n: number) => void; statsCalls: () => number } {
  const state = { waiting, calls: 0 };
  const stats: QueueStats = {
    driver: 'memory',
    paused: false,
    consuming: true,
    queues: [],
    totals: { waiting, active: 0, completed: 0, deadLetter: 0, backlog: waiting },
  };
  const service = {
    stats: async () => {
      state.calls += 1;
      return { ...stats, totals: { ...stats.totals, waiting: state.waiting, backlog: state.waiting } };
    },
  } as unknown as QueueService;
  return { service, setWaiting: (n: number) => (state.waiting = n), statsCalls: () => state.calls };
}

/** 用户桩 */
function makeUser(permissions: string[] = []): RequestUser {
  return {
    id: 'u1',
    username: 'alice',
    roles: [],
    permissions,
    dataScope: 'all',
    via: 'jwt',
  };
}

describe('EventsService：票据', () => {
  it('签发票据：任务面人人可用，队列面需 system:queue:list', async () => {
    const transport = makeTransport();
    const service = new EventsService(transport.service, makeQueue(0).service, makeStore());

    const plain = await service.issueTicket(makeUser());
    expect(plain.expiresIn).toBe(60);
    expect(plain.topics).toEqual(['job']);
    expect(plain.ticket).toMatch(/^[0-9a-f-]{36}$/);

    const ops = await service.issueTicket(makeUser(['system:queue:list']));
    expect(ops.topics).toEqual(['job', 'queue']);
  });

  it('票据一次性：核销成功后再次核销返回 null；未签发/非法 JSON 同样拒绝', async () => {
    const transport = makeTransport();
    const store = makeStore();
    const service = new EventsService(transport.service, makeQueue(0).service, store);

    const { ticket } = await service.issueTicket(makeUser(['system:queue:list']));
    const first = await service.redeemTicket(ticket);
    expect(first).toMatchObject({ userId: 'u1', username: 'alice', topics: ['job', 'queue'] });
    expect(await service.redeemTicket(ticket)).toBeNull();
    expect(await service.redeemTicket('not-issued')).toBeNull();

    // 存储里放入损坏载荷：解析失败同样按无效票据处理（不抛穿到调用方）
    await store.set('fw:sse:ticket:broken', '{not json', 1000);
    expect(await service.redeemTicket('broken')).toBeNull();
  });

  it('并发核销只有一个成功（用删除的原子性消竞态）', async () => {
    const transport = makeTransport();
    const service = new EventsService(transport.service, makeQueue(0).service, makeStore());
    const { ticket } = await service.issueTicket(makeUser());
    const [a, b, c] = await Promise.all([
      service.redeemTicket(ticket),
      service.redeemTicket(ticket),
      service.redeemTicket(ticket),
    ]);
    expect([a, b, c].filter((item) => item !== null)).toHaveLength(1);
  });
});

describe('EventsService：事件源装配与发布', () => {
  it('装配 job / queue 两条事件源并转发到事件面', async () => {
    const transport = makeTransport();
    const service = new EventsService(transport.service, makeQueue(0).service, makeStore());
    service.onApplicationBootstrap();
    try {
      const { emitJobEvent } = await import('../jobs/job-events.js');
      const { publishQueueAlert } = await import('./queue-alerts.js');
      emitJobEvent('progress', { id: 'j1' } as never, 'u1');
      publishQueueAlert({ kind: 'dead-letter', at: new Date().toISOString(), jobId: 'j1' });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(transport.published.map((item) => item.topic)).toEqual([JOB_TOPIC, QUEUE_TOPIC]);
      expect(transport.published[0]?.payload).toMatchObject({ kind: 'progress', ownerId: 'u1' });
    } finally {
      service.onApplicationShutdown();
      setQueueAlertSink(undefined);
      setJobEventSink(undefined);
    }
  });

  it('事件面故障时发布降级（记日志不抛穿，任务与队列不受影响）', async () => {
    const transport = makeTransport();
    const service = new EventsService(transport.service, makeQueue(0).service, makeStore());
    transport.state.fail = true;
    await expect(service.publish(JOB_TOPIC, { a: 1 })).resolves.toBeUndefined();
  });
});

describe('EventsService：积压巡检（边沿触发）', () => {
  it('跨阈值只告警一次，未回落不重复；回落后可再次触发', async () => {
    const transport = makeTransport();
    const queue = makeQueue(0);
    const service = new EventsService(transport.service, queue.service, makeStore());
    const alerts = vi.fn();
    setQueueAlertSink(alerts);

    const check = (service as unknown as { checkBacklog: () => Promise<void> }).checkBacklog.bind(service);
    try {
      await check();
      expect(alerts).not.toHaveBeenCalled();

      queue.setWaiting(150);
      await check();
      await check();
      expect(alerts).toHaveBeenCalledTimes(1);
      expect(alerts.mock.calls[0][0]).toMatchObject({ kind: 'backlog', waiting: 150, threshold: 100 });

      queue.setWaiting(10);
      await check();
      queue.setWaiting(200);
      await check();
      expect(alerts).toHaveBeenCalledTimes(2);
    } finally {
      setQueueAlertSink(undefined);
    }
  });
});
