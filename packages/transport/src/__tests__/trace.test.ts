/*
 * @file 传输层链路追踪测试
 * @description 真实注册 SDK（InMemory 导出器），验证 M8 T-M8-06（PRD-008 FR-07 / TC-TNT-006）：
 *   - in-process：TransportService.call 的 CLIENT span 与驱动分发的 SERVER span 同一 traceId，父子相连；
 *   - redis：调用方把活跃上下文经信封 traceparent 过线，处理方提取后 SERVER span 续接同一 traceId
 *     （用 FakeRedis 但 caller/worker 为两个独立驱动实例，模拟两台进程，链路只能靠信封传递）；
 *   - 未注册传播器时不注入 traceparent（字段缺省）且链路退化为各自根 span（不报错）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as sdk from '@opentelemetry/sdk-node';
import { trace } from '@opentelemetry/api';
import { TransportRegistry } from '../registry.js';
import { TransportService } from '../transport.service.js';
import { InProcessTransportDriver } from '../drivers/in-process.driver.js';
import { RedisTransportDriver } from '../drivers/redis.driver.js';
import { FakeRedis, waitFor } from './test-helpers.js';

// 全局 tracer provider 单文件只注册一次（registerGlobal 先注册者胜）
const exporter = new sdk.node.InMemorySpanExporter();
const provider = new sdk.node.NodeTracerProvider({
  spanProcessors: [new sdk.node.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  // 显式注册 W3C 传播器：register() 不装默认传播器（实测 0.223），否则信封 traceparent 提取静默失效
  provider.register({ propagator: new sdk.core.W3CTraceContextPropagator() });
});

afterAll(async () => {
  await provider.shutdown();
});

/** 取 span 名以某前缀开头的全部 span */
function spansNamed(prefix: string) {
  return exporter.getFinishedSpans().filter((span) => span.name.startsWith(prefix));
}

describe('传输层链路追踪（in-process）', () => {
  /** 装配一个 in-process 服务（role=both）并注册地址 */
  function makeService() {
    const registry = new TransportRegistry('both');
    const driver = new InProcessTransportDriver(registry, { instanceId: 'inst-a' });
    const service = new TransportService(driver, registry, {
      instanceId: 'inst-a',
      role: 'both',
      shutdownTimeoutMs: 500,
    });
    return { registry, driver, service };
  }

  it('CLIENT span 与 SERVER span 同一 traceId 且父子相连', async () => {
    const { service } = makeService();
    service.register('demo.ping', () => ({ pong: true }));

    const result = await service.call('demo.ping', { hello: 'world' });
    expect(result).toEqual({ pong: true });

    const client = spansNamed('transport.call demo.ping').at(-1);
    const server = spansNamed('transport.handle demo.ping').at(-1);
    expect(client).toBeDefined();
    expect(server).toBeDefined();
    // 同链路：traceId 一致
    expect(server?.spanContext().traceId).toBe(client?.spanContext().traceId);
    // 父子：SERVER 的父 spanId 即 CLIENT 的 spanId
    expect(server?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId);
    // 属性：CLIENT 记录地址与驱动；SERVER 只记地址
    expect(client?.attributes['transport.address']).toBe('demo.ping');
    expect(client?.attributes['transport.driver']).toBe('in-process');
    expect(server?.attributes['transport.address']).toBe('demo.ping');
  });

  it('处理器抛异常：SERVER span 记 ERROR 并回传调用方', async () => {
    const { service } = makeService();
    service.register('demo.fail', () => {
      throw new Error('handler-boom');
    });

    await expect(service.call('demo.fail', {})).rejects.toThrow('handler-boom');
    const server = spansNamed('transport.handle demo.fail').at(-1);
    expect(server?.status.code).toBe(2);
    expect(server?.events.some((event) => event.name === 'exception')).toBe(true);
  });
});

describe('传输层链路追踪（redis，跨进程）', () => {
  it('调用方 traceparent 经信封过线，处理方续接同一 traceId', async () => {
    const shared = new FakeRedis();
    const createClient = () => shared;

    // 两个独立驱动实例 + 独立注册表：模拟两台进程，链路只能靠信封传递
    const callerRegistry = new TransportRegistry('caller');
    const callerDriver = new RedisTransportDriver(callerRegistry, {
      url: 'redis://fake',
      prefix: 'fw:test',
      instanceId: 'caller-1',
      defaultTimeoutMs: 2000,
      shutdownTimeoutMs: 500,
      createClient,
    });
    const caller = new TransportService(callerDriver, callerRegistry, {
      instanceId: 'caller-1',
      role: 'caller',
      shutdownTimeoutMs: 500,
    });

    const workerRegistry = new TransportRegistry('handler');
    const workerDriver = new RedisTransportDriver(workerRegistry, {
      url: 'redis://fake',
      prefix: 'fw:test',
      instanceId: 'worker-1',
      defaultTimeoutMs: 2000,
      shutdownTimeoutMs: 500,
      createClient,
    });
    const worker = new TransportService(workerDriver, workerRegistry, {
      instanceId: 'worker-1',
      role: 'handler',
      shutdownTimeoutMs: 500,
    });

    worker.register('demo.remote', (payload) => ({ echoed: payload }));
    await workerDriver.start();
    await callerDriver.start();

    const result = await caller.call('demo.remote', { n: 1 });
    expect(result).toEqual({ echoed: { n: 1 } });

    await waitFor(() => spansNamed('transport.handle demo.remote').length === 1, '处理方 SERVER span');
    const client = spansNamed('transport.call demo.remote').at(-1);
    const server = spansNamed('transport.handle demo.remote').at(-1);
    // 跨进程同链路：SERVER 的 traceId 与 CLIENT 一致（信封 traceparent 生效）
    expect(server?.spanContext().traceId).toBe(client?.spanContext().traceId);
    // 父子关系跨进程成立：SERVER 父 spanId 即远端 CLIENT 的 spanId
    expect(server?.parentSpanContext?.spanId).toBe(client?.spanContext().spanId);

    await callerDriver.close(500);
    await workerDriver.close(500);
  });

  it('无活跃上下文时信封不含 traceparent 字段；有活跃 span 时携带', async () => {
    const shared = new FakeRedis();
    const registry = new TransportRegistry('caller');
    const driver = new RedisTransportDriver(registry, {
      url: 'redis://fake',
      prefix: 'fw:test',
      instanceId: 'caller-2',
      defaultTimeoutMs: 100, // 无消费方 → 调用按超时快速失败
      shutdownTimeoutMs: 200,
      createClient: () => shared,
    });
    // 只 start 不注册处理器 → 无消费方，请求留在队列里，可直接检查信封内容
    await driver.start();
    const requestKey = 'fw:test:req:demo.bare';

    // 无活跃 span（调用在 startActiveSpan 之外）→ injectTraceparent 得到空对象 → 信封无该字段
    const bare = driver.call('demo.bare', { n: 1 }).catch(() => undefined);
    await waitFor(() => shared.lengthOf(requestKey) === 1, '请求入队（无 span）');
    const bareEnvelope = JSON.parse(shared.lists.get(requestKey)![0] as string) as Record<string, unknown>;
    expect(bareEnvelope.address).toBe('demo.bare');
    expect('traceparent' in bareEnvelope).toBe(false);
    await bare;

    // 有活跃 span 时：信封携带 traceparent（traceId 与当前 span 一致）
    let activeTraceId = '';
    const traced = trace.getTracer('t').startActiveSpan('outer', (span) => {
      activeTraceId = span.spanContext().traceId;
      const pending = driver.call('demo.bare', { n: 2 }).catch(() => undefined);
      return pending.finally(() => span.end());
    });
    await waitFor(() => shared.lengthOf(requestKey) === 1, '请求入队（有 span）');
    const tracedEnvelope = JSON.parse(shared.lists.get(requestKey)![0] as string) as Record<string, unknown>;
    expect(typeof tracedEnvelope.traceparent).toBe('string');
    expect(tracedEnvelope.traceparent as string).toContain(activeTraceId);
    await traced;

    await driver.close(0);
  });
});
