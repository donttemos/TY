/*
 * @file 缓存层链路追踪单测
 * @description M8 T-M8-06（PRD-008 FR-07）：验证 CacheService 的统一守卫点（guarded）为每次存储调用
 *   包一个 CLIENT span，属性含 cache.operation / cache.driver，异常时记 ERROR 状态。
 *   注意：guard 位于存储调用漏斗，故读路径 span 名为 `cache.read`（非 `cache.get`）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/cache
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as api from '@opentelemetry/api';
import * as sdkNode from '@opentelemetry/sdk-node';
import { CacheService } from '../cache.service.js';
import { CacheMetrics } from '../metrics.js';
import { MemoryCacheStore } from '../drivers/memory.driver.js';
import { FaultyStore, makeOptions } from './test-helpers.js';

/** 已结束的 span 采集器 */
const exporter = new sdkNode.node.InMemorySpanExporter();

/** 取出指定名字的 span（取最后一个，避免历史用例污染） */
function findSpan(name: string) {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name === name)
    .at(-1);
}

let provider: InstanceType<typeof sdkNode.node.NodeTracerProvider>;

beforeAll(() => {
  provider = new sdkNode.node.NodeTracerProvider({
    spanProcessors: [new sdkNode.node.SimpleSpanProcessor(exporter)],
  });
  provider.register({ propagator: new sdkNode.core.W3CTraceContextPropagator() });
});

afterAll(async () => {
  await provider.shutdown();
  api.trace.disable();
});

describe('@fw/cache · 链路追踪插桩', () => {
  it('读路径产生 CLIENT span 且属性完整', async () => {
    const cache = new CacheService({
      store: new MemoryCacheStore(),
      options: makeOptions(),
      metrics: new CacheMetrics(),
    });
    await cache.get('trace:key');

    const span = findSpan('cache.read');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(api.SpanKind.CLIENT);
    expect(span?.attributes['db.system']).toBe('cache');
    expect(span?.attributes['cache.operation']).toBe('read');
    expect(span?.attributes['cache.driver']).toBe('memory');
    expect(span?.status.code).toBe(api.SpanStatusCode.UNSET);
  });

  it('cache.set 与 cache.del 各自产生独立 span', async () => {
    const cache = new CacheService({
      store: new MemoryCacheStore(),
      options: makeOptions(),
      metrics: new CacheMetrics(),
    });
    await cache.set('trace:a', 1);
    await cache.del('trace:a');

    expect(findSpan('cache.set')?.attributes['cache.operation']).toBe('set');
    expect(findSpan('cache.del')?.attributes['cache.operation']).toBe('del');
  });

  it('redis 驱动 span 的 cache.driver 记录真实驱动名', async () => {
    const cache = new CacheService({
      store: new FaultyStore(),
      options: makeOptions(),
      metrics: new CacheMetrics(),
    });
    await cache.get('trace:redis');

    expect(findSpan('cache.read')?.attributes['cache.driver']).toBe('redis');
  });

  it('存储故障时 span 记 ERROR 并附带异常事件', async () => {
    const store = new FaultyStore();
    store.broken = true;
    const cache = new CacheService({
      store,
      options: makeOptions({ failOpen: false }),
      metrics: new CacheMetrics(),
    });

    await expect(cache.get('trace:fail')).rejects.toThrow();

    const span = findSpan('cache.read');
    expect(span?.status.code).toBe(api.SpanStatusCode.ERROR);
    expect(span?.status.message).toContain('模拟缓存依赖故障');
    expect(span?.events.some((event) => event.name === 'exception')).toBe(true);
  });
});
