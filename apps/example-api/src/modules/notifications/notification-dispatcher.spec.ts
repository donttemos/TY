/*
 * @file 单测：通知派发器（M10 E-13）
 * @description 覆盖「事件订阅 → 落库 → 广播」的映射规则：任务终态按成功/失败建对应级别消息、
 *   进度事件不产生消息、重复投递幂等（dedupeKey 命中）、任务重跑再次终态产生新消息、
 *   队列告警广播给持 system:queue:list 的收件人（无收件人则跳过）、事件面不可用时启动降级不抛、
 *   停机退订。事件面用桩注入，不依赖真实 Redis。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/notifications
 */

import { describe, expect, it, vi } from 'vitest';
import { QUEUE_PERM_LIST } from '@fw/queue';
import type { TransportService } from '@fw/transport';
import { MemoryNotificationStore } from './notification.store.js';
import { NotificationService } from './notification.service.js';
import { NotificationDispatcher } from './notification-dispatcher.js';
import { JOB_TOPIC, NOTIFICATION_TOPIC, QUEUE_TOPIC } from '../events/topics.js';
import type { JobEventPayload } from '../jobs/job-events.js';

/** 事件面桩：记录发布，暴露手工投递入口，可模拟订阅失败 */
function makeTransport(options: { failSubscribe?: boolean } = {}): {
  transport: TransportService;
  published: Array<{ topic: string; payload: Record<string, unknown> }>;
  emit: (topic: string, payload: unknown) => void;
  handlers: Map<string, Array<(payload: unknown) => void>>;
} {
  const published: Array<{ topic: string; payload: Record<string, unknown> }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => void>>();
  const transport = {
    publish: async (topic: string, payload: unknown) => {
      published.push({ topic, payload: payload as Record<string, unknown> });
    },
    subscribe: async (topic: string, handler: (payload: unknown) => void) => {
      if (options.failSubscribe) throw new Error('事件面不可用');
      const bucket = handlers.get(topic) ?? [];
      bucket.push(handler);
      handlers.set(topic, bucket);
      return () => {
        const current = handlers.get(topic) ?? [];
        handlers.set(
          topic,
          current.filter((item) => item !== handler),
        );
      };
    },
  } as unknown as TransportService;
  return {
    transport,
    published,
    handlers,
    emit: (topic: string, payload: unknown) => {
      for (const handler of [...(handlers.get(topic) ?? [])]) handler(payload);
    },
  };
}

/** 任务终态事件载荷 */
function jobEvent(overrides: Partial<JobEventPayload['job']> = {}, kind: JobEventPayload['kind'] = 'finished'): JobEventPayload {
  return {
    kind,
    ownerId: 'u1',
    job: {
      id: 'job-1',
      type: 'audit.export',
      title: '审计日志导出',
      status: 'succeeded',
      progress: 100,
      message: '已完成，可下载',
      error: null,
      traceId: 'trace-1',
      fileName: 'audit-logs.csv',
      createdAt: '2026-10-15T00:00:00.000Z',
      updatedAt: '2026-10-15T00:00:05.000Z',
      ...overrides,
    },
  };
}

/** 构造派发器 + 依赖 */
async function makeDispatcher(options: { failSubscribe?: boolean } = {}): Promise<{
  dispatcher: NotificationDispatcher;
  service: NotificationService;
  store: MemoryNotificationStore;
  bus: ReturnType<typeof makeTransport>;
}> {
  const store = new MemoryNotificationStore();
  const service = new NotificationService(store);
  const bus = makeTransport(options);
  const dispatcher = new NotificationDispatcher(bus.transport, service);
  await dispatcher.onApplicationBootstrap();
  return { dispatcher, service, store, bus };
}

describe('NotificationDispatcher：任务事件映射', () => {
  it('成功终态 → job.finished / success，并把通知广播到 notification 主题', async () => {
    const { dispatcher, service, bus } = await makeDispatcher();
    await dispatcher.onJobEvent(jobEvent());

    const listed = await service.list('u1', { page: 1, pageSize: 20 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({
      kind: 'job.finished',
      level: 'success',
      refType: 'job',
      refId: 'job-1',
      traceId: 'trace-1',
      read: false,
    });
    expect(listed.items[0]?.title).toContain('任务完成');
    expect(listed.items[0]?.content).toContain('audit-logs.csv');

    const broadcast = bus.published.filter((item) => item.topic === NOTIFICATION_TOPIC);
    expect(broadcast).toHaveLength(1);
    expect(broadcast[0]?.payload).toMatchObject({ ownerId: 'u1' });
  });

  it('失败终态 → job.failed / error，内容带失败原因', async () => {
    const { dispatcher, service } = await makeDispatcher();
    await dispatcher.onJobEvent(jobEvent({ status: 'failed', error: '产物超过上限', fileName: null }));

    const listed = await service.list('u1', { page: 1, pageSize: 20 });
    expect(listed.items[0]).toMatchObject({ kind: 'job.failed', level: 'error' });
    expect(listed.items[0]?.content).toBe('产物超过上限');
  });

  it('进度事件不产生消息（进度感知属任务条，站内信只收终态）', async () => {
    const { dispatcher, service, bus } = await makeDispatcher();
    await dispatcher.onJobEvent(jobEvent({ status: 'running', progress: 40 }, 'progress'));
    await dispatcher.onJobEvent(jobEvent({ status: 'pending', progress: 0 }, 'created'));
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(0);
    expect(bus.published).toHaveLength(0);
  });

  it('重复投递同一终态事件幂等：第二次不建消息、不重复广播', async () => {
    const { dispatcher, service, bus } = await makeDispatcher();
    const event = jobEvent();
    await dispatcher.onJobEvent(event);
    await dispatcher.onJobEvent(event);
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(1);
    expect(bus.published.filter((item) => item.topic === NOTIFICATION_TOPIC)).toHaveLength(1);
  });

  it('任务重跑后再次终态 → 幂等键随 updatedAt 变化，产生新的一条消息', async () => {
    const { dispatcher, service } = await makeDispatcher();
    await dispatcher.onJobEvent(jobEvent({ status: 'failed', error: '第一次失败', updatedAt: '2026-10-15T00:00:05.000Z' }));
    await dispatcher.onJobEvent(jobEvent({ status: 'succeeded', fileName: 'again.csv', updatedAt: '2026-10-15T00:10:00.000Z' }));
    const listed = await service.list('u1', { page: 1, pageSize: 20 });
    expect(listed.total).toBe(2);
    // 两条消息 createdAt 落在同一毫秒内 → 顺序不作断言（排序 tie-break 是 id 倒序，不保证时间语义）
    expect(listed.items.map((item) => item.kind).sort()).toEqual(['job.failed', 'job.finished']);
  });

  it('载荷缺字段（无 ownerId / 无 jobId）时安全跳过', async () => {
    const { dispatcher, service } = await makeDispatcher();
    await dispatcher.onJobEvent({ kind: 'finished', ownerId: '', job: jobEvent().job });
    await dispatcher.onJobEvent({ kind: 'finished', ownerId: 'u1', job: { ...jobEvent().job, id: '' } });
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(0);
  });
});

describe('NotificationDispatcher：队列告警映射', () => {
  it('死信告警 → 广播给持 system:queue:list 的账号（含权限码驱动的收件人解析）', async () => {
    const { dispatcher, service, store } = await makeDispatcher();
    store.permissionRecipients.set(QUEUE_PERM_LIST, ['ops-1', 'ops-2']);

    await dispatcher.onQueueAlert({ kind: 'dead-letter', at: '2026-10-15T00:00:00.000Z', jobId: 'j9', jobName: 'audit.export', attemptsMade: 3, reason: 'boom' });

    const listed = await service.list('ops-1', { page: 1, pageSize: 20 });
    expect(listed.total).toBe(1);
    expect(listed.items[0]).toMatchObject({ kind: 'queue.dead-letter', level: 'error', refType: 'queue', refId: 'j9' });
    expect(listed.items[0]?.content).toContain('boom');
    expect((await service.list('ops-2', { page: 1, pageSize: 20 })).total).toBe(1);
  });

  it('积压告警 → warning 级别；无收件人时跳过（不产生孤儿消息）', async () => {
    const { dispatcher, service, store } = await makeDispatcher();
    await dispatcher.onQueueAlert({ kind: 'backlog', at: '2026-10-15T00:00:00.000Z', waiting: 150, threshold: 100 });
    expect((await service.list('ops-1', { page: 1, pageSize: 20 })).total).toBe(0);

    store.permissionRecipients.set(QUEUE_PERM_LIST, ['ops-1']);
    await dispatcher.onQueueAlert({ kind: 'backlog', at: '2026-10-15T00:01:00.000Z', waiting: 150, threshold: 100 });
    const listed = await service.list('ops-1', { page: 1, pageSize: 20 });
    expect(listed.items[0]).toMatchObject({ kind: 'queue.backlog', level: 'warning' });
    expect(listed.items[0]?.content).toContain('150');
  });

  it('同一积压事件重复投递不重复建（幂等键含告警时刻）', async () => {
    const { dispatcher, service, store } = await makeDispatcher();
    store.permissionRecipients.set(QUEUE_PERM_LIST, ['ops-1']);
    const alert = { kind: 'backlog', at: '2026-10-15T00:01:00.000Z', waiting: 150, threshold: 100 };
    await dispatcher.onQueueAlert(alert);
    await dispatcher.onQueueAlert(alert);
    expect((await service.list('ops-1', { page: 1, pageSize: 20 })).total).toBe(1);
  });
});

describe('NotificationDispatcher：事件面生命周期', () => {
  it('事件面不可用时启动降级（不抛错，站内信退化为进消息中心可见）', async () => {
    const store = new MemoryNotificationStore();
    const service = new NotificationService(store);
    const bus = makeTransport({ failSubscribe: true });
    const dispatcher = new NotificationDispatcher(bus.transport, service);
    await expect(dispatcher.onApplicationBootstrap()).resolves.toBeUndefined();
    // 降级后仍能正常写入（REST 面不受影响）
    await service.create({ userId: 'u1', kind: 'system', level: 'info', title: 't', dedupeKey: 'k' });
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(1);
  });

  it('启动订阅两类事件源；停机退订后事件不再被处理', async () => {
    const { dispatcher, service, bus } = await makeDispatcher();
    expect(bus.handlers.get(JOB_TOPIC)).toHaveLength(1);
    expect(bus.handlers.get(QUEUE_TOPIC)).toHaveLength(1);

    dispatcher.onApplicationShutdown();
    expect(bus.handlers.get(JOB_TOPIC)).toHaveLength(0);
    expect(bus.handlers.get(QUEUE_TOPIC)).toHaveLength(0);

    // 退订后再投递：不产生消息
    bus.emit(JOB_TOPIC, jobEvent());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(0);
  });

  it('广播失败不影响落库（消息仍可在消息中心看到）', async () => {
    const store = new MemoryNotificationStore();
    const service = new NotificationService(store);
    const bus = makeTransport();
    const failing = {
      subscribe: bus.transport.subscribe,
      publish: vi.fn().mockRejectedValue(new Error('redis down')),
    } as unknown as TransportService;
    const dispatcher = new NotificationDispatcher(failing, service);
    await dispatcher.onApplicationBootstrap();
    await dispatcher.onJobEvent(jobEvent());
    expect((await service.list('u1', { page: 1, pageSize: 20 })).total).toBe(1);
  });
});
