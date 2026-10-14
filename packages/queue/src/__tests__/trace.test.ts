/*
 * @file 队列链路追踪单测
 * @description M8 T-M8-06（PRD-008 FR-07）：验证任务派发（dispatch）包 PRODUCER span 并把
 *   traceparent 写入 JobRecord，任务执行（invoke）从记录续接父上下文包 CONSUMER span——
 *   使异步任务在同一 traceId 下可见完整链路（跨进程/跨重试同样成立）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/queue
 */

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import * as api from '@opentelemetry/api';
import * as sdkNode from '@opentelemetry/sdk-node';
import { JobHandler } from '../decorators.js';
import type { Job } from '../types.js';
import { createQueueFixture, waitFor } from './test-helpers.js';

/** 已结束的 span 采集器 */
const exporter = new sdkNode.node.InMemorySpanExporter();

/** 取出指定名字的 span（取最后一个，避免历史用例污染） */
function findSpan(name: string) {
  return exporter
    .getFinishedSpans()
    .filter((span) => span.name === name)
    .at(-1);
}

/** 演示任务：仅记录执行次数 */
@JobHandler('trace.job')
class TraceJob implements Job<{ id: string }> {
  /** 执行次数 */
  runs = 0;

  /**
   * 计数
   * @param payload 载荷
   */
  async handle(payload: { id: string }): Promise<void> {
    void payload;
    this.runs++;
  }
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

describe('@fw/queue · 链路追踪插桩', () => {
  it('dispatch 产生 PRODUCER span 且属性完整', async () => {
    const { queue, driver, stop } = createQueueFixture();
    let captured: { traceparent?: string } | undefined;
    const original = driver.enqueue.bind(driver);
    vi.spyOn(driver, 'enqueue').mockImplementation(async (record) => {
      captured = record;
      return original(record);
    });

    await queue.dispatch('trace.job', { id: 'p1' });

    const span = findSpan('queue.dispatch trace.job');
    expect(span).toBeDefined();
    expect(span?.kind).toBe(api.SpanKind.PRODUCER);
    expect(span?.attributes['messaging.system']).toBe('fw-queue');
    expect(span?.attributes['messaging.destination.name']).toBe('default');
    expect(span?.attributes['messaging.operation']).toBe('dispatch');

    // 记录带上 traceparent（随任务过线）
    expect(captured?.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-[0-9a-f]{2}$/);
    expect(captured?.traceparent).toContain(span?.spanContext().traceId);

    void stop();
  });

  it('消费 span 续接派发链路：同一 traceId，CONSUMER 为 PRODUCER 的子 span', async () => {
    const { queue, stop } = createQueueFixture();
    const instance = new TraceJob();
    queue.registerInstance(instance);
    await queue.start();

    await queue.dispatch('trace.job', { id: 'p2' });
    await waitFor(() => instance.runs === 1, '任务执行');

    const producer = findSpan('queue.dispatch trace.job');
    const consumer = findSpan('queue.process trace.job');
    expect(producer).toBeDefined();
    expect(consumer).toBeDefined();
    expect(consumer?.kind).toBe(api.SpanKind.CONSUMER);
    // 跨 async 边界续接：同一 traceId
    expect(consumer?.spanContext().traceId).toBe(producer?.spanContext().traceId);
    // 父子关系成立：消费 span 的父即派发 span
    expect(consumer?.parentSpanContext?.spanId).toBe(producer?.spanContext().spanId);

    await stop();
  });

  it('任务执行异常时消费 span 记 ERROR', async () => {
    const { queue, stop } = createQueueFixture({ maxAttempts: 1 });
    queue.register('trace.boom', () => {
      throw new Error('任务执行失败');
    });
    await queue.start();

    await queue.dispatch('trace.boom', {});
    await waitFor(() => findSpan('queue.process trace.boom') !== undefined, '失败 span 结束');

    const span = findSpan('queue.process trace.boom');
    expect(span?.status.code).toBe(api.SpanStatusCode.ERROR);
    expect(span?.status.message).toContain('任务执行失败');

    await stop();
  });
});
