/*
 * @file 单测：传输事件面（M10 E-12）
 * @description 覆盖事件面语义：in-process 进程内扇出（多订阅方 / 异常隔离 / 退订 / 非法主题 /
 *   无订阅方空操作）、redis 驱动的跨实例广播（共享 FakePubSubBus 复现多副本）、
 *   载荷不可序列化的快速失败、退订后频道释放，以及 TransportService 的委托与统计埋点。
 *   单测一律使用真实定时器（不 mock 时钟），避免「假绿」。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/transport
 */

import { describe, expect, it } from 'vitest';
import { InProcessTransportDriver } from '../drivers/in-process.driver.js';
import { RedisTransportDriver } from '../drivers/redis.driver.js';
import { TransportRegistry } from '../registry.js';
import { TransportService } from '../transport.service.js';
import {
  InvalidTopicError,
  TransportError,
  TransportEventsUnsupportedError,
} from '../errors.js';
import type { TransportDriverPort } from '../driver.port.js';
import type { TransportEventHandler, TransportEventMeta } from '../types.js';
import { FakePubSubBus, FakeRedis, waitFor } from './test-helpers.js';

/** 构造 in-process 驱动实例 */
function makeInProcess(instanceId = 'inst-a'): InProcessTransportDriver {
  return new InProcessTransportDriver(new TransportRegistry('both'), { instanceId });
}

/** 构造共享同一事件总线的 redis 驱动实例（= 两个副本进程） */
function makeRedisInstance(
  bus: FakePubSubBus,
  instanceId: string,
): { driver: RedisTransportDriver; registry: TransportRegistry } {
  const registry = new TransportRegistry('both');
  const driver = new RedisTransportDriver(registry, {
    url: 'redis://fake',
    prefix: 'fw:test',
    instanceId,
    defaultTimeoutMs: 1000,
    shutdownTimeoutMs: 200,
    createClient: () => new FakeRedis(bus),
  });
  return { driver, registry };
}

/** 记录事件的最小订阅方 */
function recorder(): { events: Array<{ payload: unknown; meta: TransportEventMeta }>; handler: TransportEventHandler } {
  const events: Array<{ payload: unknown; meta: TransportEventMeta }> = [];
  return { events, handler: (payload, meta) => events.push({ payload, meta }) };
}

describe('事件面：in-process 驱动（进程内扇出）', () => {
  it('publish 扇出到全部订阅方并携带 meta；退订后不再收到', async () => {
    const driver = makeInProcess('inst-single');
    const a = recorder();
    const b = recorder();
    const offB = await driver.subscribe('job.progress', b.handler);
    await driver.subscribe('job.progress', a.handler);

    await driver.publish('job.progress', { jobId: 'j1', progress: 30 });
    expect(a.events).toHaveLength(1);
    expect(b.events).toHaveLength(1);
    expect(a.events[0]?.payload).toEqual({ jobId: 'j1', progress: 30 });
    expect(a.events[0]?.meta).toMatchObject({ topic: 'job.progress', driver: 'in-process', instanceId: 'inst-single' });
    expect(a.events[0]?.meta.emittedAt).toBeGreaterThan(0);

    offB();
    await driver.publish('job.progress', { jobId: 'j1', progress: 60 });
    expect(a.events).toHaveLength(2);
    expect(b.events).toHaveLength(1);
  });

  it('单个订阅方抛异常被隔离，其余订阅方照常收到', async () => {
    const driver = makeInProcess();
    const healthy = recorder();
    await driver.subscribe('queue.alert', () => {
      throw new Error('SSE 连接已断开');
    });
    await driver.subscribe('queue.alert', healthy.handler);

    await expect(driver.publish('queue.alert', { kind: 'dead-letter' })).resolves.toBeUndefined();
    expect(healthy.events).toHaveLength(1);
  });

  it('无订阅方时发布为无害空操作；仅订阅方收到对应主题', async () => {
    const driver = makeInProcess();
    await expect(driver.publish('job.progress', { jobId: 'none' })).resolves.toBeUndefined();
    const only = recorder();
    await driver.subscribe('job.progress', only.handler);
    await driver.publish('queue.alert', { kind: 'backlog' });
    expect(only.events).toHaveLength(0);
  });

  it('非法主题在发布与订阅两侧均被拦截', async () => {
    const driver = makeInProcess();
    await expect(driver.publish('nodots', {})).rejects.toThrow(InvalidTopicError);
    await expect(driver.subscribe('nodots', () => undefined)).rejects.toThrow(InvalidTopicError);
  });
});

describe('事件面：redis 驱动（跨实例广播）', () => {
  it('A 实例发布 → B 实例订阅方收到（多副本免粘滞）', async () => {
    const bus = new FakePubSubBus();
    const instanceA = makeRedisInstance(bus, 'inst-a');
    const instanceB = makeRedisInstance(bus, 'inst-b');

    const received = recorder();
    await instanceB.driver.subscribe('job.progress', received.handler);
    await instanceA.driver.publish('job.progress', { jobId: 'j9', progress: 100 });

    expect(received.events).toHaveLength(1);
    expect(received.events[0]?.payload).toEqual({ jobId: 'j9', progress: 100 });
    expect(received.events[0]?.meta).toMatchObject({ driver: 'redis', instanceId: 'inst-b' });
  });

  it('同一主题多订阅方共享一条订阅连接，退订到零后释放频道', async () => {
    const bus = new FakePubSubBus();
    const instance = makeRedisInstance(bus, 'inst-a');
    const first = recorder();
    const second = recorder();
    const offFirst = await instance.driver.subscribe('job.progress', first.handler);
    const offSecond = await instance.driver.subscribe('job.progress', second.handler);
    expect(bus.subscriberCount('fw:test:evt:job.progress')).toBe(1);

    await instance.driver.publish('job.progress', { a: 1 });
    expect(first.events).toHaveLength(1);
    expect(second.events).toHaveLength(1);

    offFirst();
    expect(bus.subscriberCount('fw:test:evt:job.progress')).toBe(1);
    offSecond();
    await waitFor(() => bus.subscriberCount('fw:test:evt:job.progress') === 0, '频道退订');
  });

  it('载荷不可 JSON 序列化时快速失败（不静默丢事件）', async () => {
    const bus = new FakePubSubBus();
    const instance = makeRedisInstance(bus, 'inst-a');
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    await expect(instance.driver.publish('job.progress', circular)).rejects.toThrow(TransportError);
  });

  it('其他前缀的频道消息被忽略（多环境不串数据）', async () => {
    const bus = new FakePubSubBus();
    const instance = makeRedisInstance(bus, 'inst-a');
    const received = recorder();
    await instance.driver.subscribe('job.progress', received.handler);
    // 直接向「别的环境前缀」广播：订阅方不应收到
    bus.broadcast('fw:other:evt:job.progress', JSON.stringify({ jobId: 'x' }));
    expect(received.events).toHaveLength(0);
  });
});

describe('事件面：TransportService 委托与统计', () => {
  it('publish/subscribe 委托驱动，统计埋点与主题计数随退订释放', async () => {
    const registry = new TransportRegistry('both');
    const driver = new InProcessTransportDriver(registry, { instanceId: 'inst-svc' });
    const service = new TransportService(driver, registry, { instanceId: 'inst-svc', role: 'both', shutdownTimeoutMs: 200 });

    const received = recorder();
    const off = await service.subscribe('job.progress', received.handler);
    expect(service.stats().events).toMatchObject({ published: 0, received: 0, topics: 1, topicList: ['job.progress'] });

    await service.publish('job.progress', { jobId: 'j2' });
    expect(received.events).toHaveLength(1);
    expect(service.stats().events).toMatchObject({ published: 1, received: 1, topics: 1 });

    off();
    off(); // 幂等：重复取消不重复扣减
    expect(service.stats().events.topics).toBe(0);
    await expect(service.publish('nodots', {})).rejects.toThrow(InvalidTopicError);
  });

  it('驱动未实现事件面时抛 TransportEventsUnsupportedError（快速失败优于静默丢事件）', async () => {
    const rpcOnly: TransportDriverPort = {
      kind: 'in-process',
      register: () => undefined,
      start: async () => undefined,
      call: async () => undefined,
      ping: async () => true,
      handledCount: () => 0,
      close: async () => undefined,
    };
    const service = new TransportService(rpcOnly, new TransportRegistry('both'), {
      instanceId: 'inst-rpc',
      role: 'both',
      shutdownTimeoutMs: 200,
    });
    await expect(service.publish('job.progress', {})).rejects.toThrow(TransportEventsUnsupportedError);
    await expect(service.subscribe('job.progress', () => undefined)).rejects.toThrow(TransportEventsUnsupportedError);
  });
});
