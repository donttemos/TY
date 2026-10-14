/*
 * @file otelMiddleware 单测
 * @description 真实注册 SDK（node 命名空间 NodeTracerProvider + SimpleSpanProcessor + InMemorySpanExporter），
 *   覆盖：根 span / traceparent 继承 / X-Trace-Id 合成父（含归一化与非法回退）/ 5xx 记 ERROR、4xx 不记 /
 *   同步异常 recordException + 重抛 / 路由模板命名 / 日志 ALS 回写。
 *   传播器必须显式注册（register({propagator})），否则 extract 静默 no-op——这正是本中间件的依赖前提。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { EventEmitter } from 'node:events';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';
// 0.223 起 NodeTracerProvider / SimpleSpanProcessor / InMemorySpanExporter 位于 node 命名空间
import * as sdk from '@opentelemetry/sdk-node';
import type { NextFunction, Request, Response } from 'express';
import { getRequestContext, runWithRequestContext } from '@fw/logger';
import { createOtelExpressMiddleware, otelMiddleware } from '../otel.middleware.js';

/** 32 位十六进制 traceId（合法形态） */
const TRACE_ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
/** 16 位十六进制 spanId */
const SPAN_ID = '0f1e2d3c4b5a6978';

// 全局 tracer provider 单文件只注册一次（registerGlobal 先注册者胜）：两个 describe 共享
const exporter = new sdk.node.InMemorySpanExporter();
const provider = new sdk.node.NodeTracerProvider({
  spanProcessors: [new sdk.node.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  // 显式注册 W3C 传播器：register() 不装默认传播器（实测 0.223），否则 traceparent 提取静默失效
  provider.register({ propagator: new sdk.core.W3CTraceContextPropagator() });
});

afterAll(async () => {
  await provider.shutdown();
});

interface FakeResponse extends EventEmitter {
  statusCode: number;
  headers: Record<string, string>;
  setHeader(key: string, value: string): void;
  getHeader(key: string): string | undefined;
}

/** 造一个可手动触发 finish 的假响应对象 */
function createResponse(): FakeResponse {
  const emitter = new EventEmitter() as FakeResponse;
  emitter.statusCode = 200;
  emitter.headers = {};
  emitter.setHeader = (key: string, value: string) => {
    emitter.headers[key] = value;
  };
  emitter.getHeader = (key: string) => emitter.headers[key];
  return emitter;
}

/** 造一个假请求对象（headers/method/path/route 可覆盖） */
function createRequest(overrides: Record<string, unknown> = {}): Request {
  return {
    method: 'GET',
    path: '/demo/1',
    headers: {},
    route: { path: '/:id' },
    ...overrides,
  } as unknown as Request;
}

describe('otelMiddleware', () => {
  const next = vi.fn();

  beforeAll(() => {
    // 传播器已在文件级 beforeAll 注册；此处仅占位说明 span 收集用共享 exporter
    expect(provider).toBeDefined();
  });

  /** 取最后一批结束的 span（SimpleSpanProcessor 同步导出） */
  function lastSpan() {
    const spans = exporter.getFinishedSpans();
    return spans[spans.length - 1];
  }

  it('无上游上下文：根 span + X-Trace-Id 响应头 + 路由模板命名', () => {
    const req = createRequest();
    const res = createResponse();
    runWithRequestContext({ traceId: 'f'.repeat(32), spanId: '' }, () => {
      otelMiddleware(req, res as unknown as Response, next as NextFunction);
    });

    expect(next).toHaveBeenCalledTimes(1);
    const traceHeader = res.getHeader('X-Trace-Id');
    expect(traceHeader).toMatch(/^[0-9a-f]{32}$/);

    res.emit('finish');
    const span = lastSpan();
    // finish 时按路由模板刷新 span 名（req.route.path 在 express 匹配后写入）
    expect(span.name).toBe('HTTP GET /:id');
    expect(span.kind).toBe(SpanKind.SERVER);
    expect(span.attributes['http.request.method']).toBe('GET');
    expect(span.attributes['url.path']).toBe('/demo/1');
    expect(span.attributes['http.response.status_code']).toBe(200);
    // 200 不记 ERROR（UNSET）
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
    // 响应头 traceId 与 span 一致（日志/响应头/span 三者 ID 对齐）
    expect(span.spanContext().traceId).toBe(traceHeader);
    // 根 span：无父 span
    expect(span.parentSpanContext).toBeUndefined();
  });

  it('带 user-agent 时记录 user_agent.original 属性', () => {
    const req = createRequest({ headers: { 'user-agent': 'probe-agent/1.0' } });
    const res = createResponse();
    otelMiddleware(req, res as unknown as Response, next as NextFunction);
    res.emit('finish');
    expect(lastSpan().attributes['user_agent.original']).toBe('probe-agent/1.0');
  });

  it('traceparent 头：子 span 继承上游 traceId 与父 spanId', () => {
    const req = createRequest({
      headers: { traceparent: `00-${TRACE_ID}-${SPAN_ID}-01` },
    });
    const res = createResponse();
    otelMiddleware(req, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    const span = lastSpan();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
    // 上游为远端父（isRemote 语义经 parentSpanContext.traceFlags 透传）
    expect(span.parentSpanContext?.traceFlags).toBe(1);
  });

  it('重复头（数组形态）取首个值：traceparent 数组仍正确提取', () => {
    const req = createRequest({
      // express 对重复请求头给出数组；非法网关可能注入多个 traceparent，按规范取首个
      headers: { traceparent: [`00-${TRACE_ID}-${SPAN_ID}-01`, 'garbage'] },
    });
    const res = createResponse();
    otelMiddleware(req, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    const span = lastSpan();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    expect(span.parentSpanContext?.spanId).toBe(SPAN_ID);
  });

  it('X-Trace-Id 头（无 traceparent）：span traceId 复用它，保持 M1 以来 BC 通道', () => {
    // 大写 + 连字符形态：归一化（去连字符、转小写）后复用
    const messy = 'A1B2-C3D4-E5F6-0718-293A-4B5C-6D7E-8F90';
    const req = createRequest({ headers: { 'x-trace-id': messy } });
    const res = createResponse();
    otelMiddleware(req, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    const span = lastSpan();
    expect(span.spanContext().traceId).toBe(TRACE_ID);
    // 合成远端父：parentSpanContext 存在且 traceId 与上游一致
    expect(span.parentSpanContext?.traceId).toBe(TRACE_ID);
    expect(res.getHeader('X-Trace-Id')).toBe(TRACE_ID);
  });

  it('X-Trace-Id 非法时回退根 span（不污染链路）', () => {
    const req = createRequest({ headers: { 'x-trace-id': 'not-a-valid-trace' } });
    const res = createResponse();
    otelMiddleware(req, res as unknown as Response, next as NextFunction);
    res.emit('finish');

    const span = lastSpan();
    expect(span.parentSpanContext).toBeUndefined();
    expect(span.spanContext().traceId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('5xx 记 ERROR；4xx 按 OTel 惯例不记', () => {
    const serverErrorRes = createResponse();
    serverErrorRes.statusCode = 500;
    otelMiddleware(createRequest(), serverErrorRes as unknown as Response, next as NextFunction);
    serverErrorRes.emit('finish');
    expect(lastSpan().status.code).toBe(SpanStatusCode.ERROR);

    const clientErrorRes = createResponse();
    clientErrorRes.statusCode = 404;
    otelMiddleware(createRequest(), clientErrorRes as unknown as Response, next as NextFunction);
    clientErrorRes.emit('finish');
    expect(lastSpan().status.code).toBe(SpanStatusCode.UNSET);
  });

  it('同步异常：recordException + ERROR 状态 + 结束 span + 原样上交 express', () => {
    const boom = new Error('sync-boom');
    const throwingNext = vi.fn(() => {
      throw boom;
    });
    const res = createResponse();
    expect(() => otelMiddleware(createRequest(), res as unknown as Response, throwingNext as NextFunction)).toThrow(boom);

    const span = lastSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('sync-boom');
    expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    expect(span.endTime).toBeDefined();
  });

  it('span ID 就地回写 logger 请求上下文（ALS 与 span 对齐）', () => {
    const req = createRequest();
    const res = createResponse();
    // next 在 span 回调内被同步调用：此刻可捕获活跃 span 的 ID 作期望值
    const captured: { traceId?: string; spanId?: string } = {};
    const capturingNext = vi.fn(() => {
      const span = trace.getActiveSpan();
      captured.traceId = span?.spanContext().traceId;
      captured.spanId = span?.spanContext().spanId;
    });
    runWithRequestContext({ traceId: '0'.repeat(32), spanId: '' }, () => {
      otelMiddleware(req, res as unknown as Response, capturingNext as NextFunction);
      // 中间件在 span 回调内 patchRequestContext：store 被就地改写为 span 的 ID
      const store = getRequestContext();
      expect(store?.traceId).toBe(captured.traceId);
      expect(store?.spanId).toBe(captured.spanId);
      // 确认是改写而非保留 trace 中间件先生成的值
      expect(store?.traceId).not.toBe('0'.repeat(32));
    });
    res.emit('finish');
  });
});

describe('createOtelExpressMiddleware（工厂：启用开关）', () => {
  it('未启用：直通 next，不建 span、不写响应头（HTTP 层零开销）', () => {
    const middleware = createOtelExpressMiddleware({ enabled: false });
    const before = exporter.getFinishedSpans().length;
    const res = createResponse();
    const nextSpy = vi.fn();
    middleware(createRequest(), res as unknown as Response, nextSpy as NextFunction);
    expect(nextSpy).toHaveBeenCalledTimes(1);
    expect(exporter.getFinishedSpans()).toHaveLength(before);
    expect(res.getHeader('X-Trace-Id')).toBeUndefined();
  });

  it('启用：返回 otelMiddleware 本体（每请求一个 SERVER span）', () => {
    const middleware = createOtelExpressMiddleware({ enabled: true });
    const res = createResponse();
    middleware(createRequest(), res as unknown as Response, vi.fn() as NextFunction);
    res.emit('finish');
    const spans = exporter.getFinishedSpans();
    expect(spans[spans.length - 1].name).toBe('HTTP GET /:id');
  });
});
