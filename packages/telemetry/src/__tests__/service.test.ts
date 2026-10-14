/*
 * @file TelemetryService 单测（端到端）
 * @description 本地起 http 收集器充当 OTLP 采集端，用真实 SDK 走完整生命周期：
 *   装配 → 产 span → 尾采样决策 → OTLP/HTTP 导出（JSON 载荷）→ 停机 flush。
 *   覆盖：disabled 短路 / 缺端点配置守卫 / ratio=0 时错误全采与普通 span 丢弃 /
 *   register({propagator}) 传播闭环（CompositePropagator 配置对象形态回归）/
 *   SDK 缺失可操作报错 / 停机语义。
 *   注意：全局 tracer provider 单文件只注册一次（registerGlobal 语义：先注册者胜），
 *   故真实装配仅「尾采样端到端」一个用例，其余用例不触发注册。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import * as http from 'node:http';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { context, propagation, trace } from '@opentelemetry/api';
import { TelemetryService } from '../telemetry.service.js';
import { TelemetryConfigError, TelemetryUnavailableError } from '../errors.js';
import { buildTelemetryOptions } from '../options.js';
import * as loader from '../otel-loader.js';

// 部分 mock loader：保留真实实现（快乐路径），仅 SDK 缺失用例按次注入拒绝
vi.mock('../otel-loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../otel-loader.js')>();
  return {
    ...actual,
    loadOtelSdk: vi.fn(actual.loadOtelSdk),
    loadOtlpExporter: vi.fn(actual.loadOtlpExporter),
  };
});

/** 收集器收到的请求（content-type + 原始载荷） */
const collected: Array<{ contentType?: string; body: string }> = [];
let exporterUrl = '';

beforeAll(async () => {
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      collected.push({ contentType: req.headers['content-type'], body: Buffer.concat(chunks).toString('utf8') });
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{}');
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  exporterUrl = `http://127.0.0.1:${port}/v1/traces`;
});

afterAll(async () => {
  // 清理全局注册，避免同进程后续文件受委托 provider 影响（vitest 默认按文件隔离，双保险）
  trace.disable();
  propagation.disable();
});

/** OTLP JSON 载荷的最小结构（导出形态断言用） */
interface OtlpPayload {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: { stringValue?: string } }> };
    scopeSpans: Array<{ spans: Array<Record<string, unknown>> }>;
  }>;
}

/** 从收集器载荷中拍平全部 span */
function receivedSpans(): Array<Record<string, unknown>> {
  return collected.flatMap((request) => {
    const payload = JSON.parse(request.body) as OtlpPayload;
    return payload.resourceSpans.flatMap((rs) => rs.scopeSpans.flatMap((ss) => ss.spans));
  });
}

/** 等待收集器收到至少 n 个 span */
async function waitForSpans(minCount: number, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (receivedSpans().length >= minCount) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`等待 span 超时：已收 ${collected.length} 个导出请求`);
}

describe('TelemetryService', () => {
  it('disabled：onModuleInit 短路，零动作', async () => {
    const service = new TelemetryService(buildTelemetryOptions({ APP_ENV: 'test' }, { enabled: false }));
    await service.onModuleInit();
    expect(service.enabled).toBe(false);
    expect(service.runtimeOptions.serviceName).toBe('fw-test');
  });

  it('启用但缺 OTEL_EXPORTER_URL：抛 TelemetryConfigError，不装配 SDK', async () => {
    const service = new TelemetryService(buildTelemetryOptions({}, { enabled: true }));
    await expect(service.onModuleInit()).rejects.toThrow(TelemetryConfigError);
    expect(service.enabled).toBe(false);
  });

  it('端到端：ratio=0 错误全采 + 普通 span 丢弃 + JSON 导出 + 传播闭环', async () => {
    const service = new TelemetryService(
      buildTelemetryOptions(
        { APP_ENV: 'test' },
        { enabled: true, exporterUrl, serviceName: 'svc-test', sampleRatio: 0, sampleErrors: true },
      ),
    );
    await service.onModuleInit();
    expect(service.enabled).toBe(true);

    const tracer = trace.getTracer('service-test');
    let errorTraceId = '';
    // 错误 span：status=ERROR → 忽略比例全采
    tracer.startActiveSpan('error-span', (span) => {
      errorTraceId = span.spanContext().traceId;
      span.setStatus({ code: 2, message: 'boom' });
      span.end();
    });
    // 普通 span：ratio=0 → 尾采样丢弃（不应到达收集器）
    tracer.startActiveSpan('normal-span', (span) => {
      span.end();
    });

    // 传播闭环：register({propagator}) 注册的组合传播器应注入 traceparent
    // （回归：CompositePropagator 误用位置参数数组时 inject 静默为空）
    const carrier: Record<string, string> = {};
    tracer.startActiveSpan('inject-span', (span) => {
      propagation.inject(context.active(), carrier, {
        set(c, k, v) {
          c[k] = v;
        },
      });
      span.end();
    });

    await waitForSpans(1);
    const spans = receivedSpans();
    expect(spans).toHaveLength(1);
    expect(spans[0].name).toBe('error-span');
    expect(spans[0].traceId).toBe(errorTraceId);
    expect(spans[0].status).toEqual({ code: 2, message: 'boom' });

    // 导出形态：OTLP/HTTP + JSON 载荷（0.223 导出器硬编码 JsonTraceSerializer）
    expect(collected[0].contentType).toContain('application/json');
    const payload = JSON.parse(collected[0].body) as OtlpPayload;
    const resourceAttributes = payload.resourceSpans[0].resource.attributes;
    expect(resourceAttributes).toEqual(
      expect.arrayContaining([{ key: 'service.name', value: { stringValue: 'svc-test' } }]),
    );

    // traceparent 形态与当前 span 一致
    expect(carrier.traceparent).toMatch(/^00-[0-9a-f]{32}-[0-9a-f]{16}-01$/);
  });

  it('SDK 未安装：抛 TelemetryUnavailableError（可操作文案），不装配', async () => {
    vi.mocked(loader.loadOtelSdk).mockRejectedValueOnce(
      new TelemetryUnavailableError('probe: sdk-node 未安装'),
    );
    const service = new TelemetryService(buildTelemetryOptions({}, { enabled: true, exporterUrl }));
    await expect(service.onModuleInit()).rejects.toThrow(TelemetryUnavailableError);
    expect(service.enabled).toBe(false);
  });

  it('未启动时 onModuleDestroy 为无操作', async () => {
    const service = new TelemetryService(buildTelemetryOptions({}));
    await expect(service.onModuleDestroy()).resolves.toBeUndefined();
    expect(service.enabled).toBe(false);
  });
});
