/*
 * @file OpenTelemetry HTTP 中间件
 * @description 每个请求一个 SERVER span，父上下文按优先级解析：
 *   1) 标准 `traceparent` 头（上游 OTel 服务 / 网关携带）——提取为远端父 span，实现跨服务同 traceId；
 *   2) 框架自有 `X-Trace-Id` 头（M1 起的 BC 通道）——合成远端父上下文，span traceId 复用它，
 *      保证未接 OTel 的上游（或老客户端）链路在追踪系统里仍可关联；
 *   3) 都没有——根 span，服务端生成新 traceId。
 *   span 的 traceId/spanId 会就地写回 @fw/logger 的请求上下文并刷新 X-Trace-Id 响应头，
   使日志、响应头、span 三者 ID 一致。span 名在响应结束时用路由模板刷新（`HTTP GET /:id`）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import type { NextFunction, Request, Response } from 'express';
import { context, propagation, trace, type Context, type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';
import { patchRequestContext } from '@fw/logger';

/** 根上下文（无父 span 时使用） */
const ROOT_CONTEXT = context.active();

/** traceId 合法形态：32 位十六进制（与 @fw/logger 的 generateTraceId 一致） */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;

/** HTTP 头读取器（headers 对象不是 TextMap 接口，需适配） */
const headerGetter = {
  get(carrier: unknown, key: string): string | undefined {
    const value = (carrier as Record<string, unknown>)[key];
    if (Array.isArray(value)) return typeof value[0] === 'string' ? value[0] : undefined;
    return typeof value === 'string' ? value : undefined;
  },
  keys(carrier: unknown): string[] {
    return Object.keys(carrier as Record<string, unknown>);
  },
};

/** express 中间件函数类型 */
export type OtelExpressMiddleware = (req: Request, res: Response, next: NextFunction) => void;

/**
 * OpenTelemetry 中间件：注册在 trace 中间件之后、路由之前（bootstrap 的 beforeListen 钩子）
 * @param req HTTP 请求
 * @param res HTTP 响应
 * @param next 下一个处理函数
 */
export function otelMiddleware(req: Request, res: Response, next: NextFunction): void {
  const tracer = trace.getTracer('fw.http');
  const parentContext = resolveParentContext(req);
  const spanName = `HTTP ${req.method} ${req.path}`;

  tracer.startActiveSpan(
    spanName,
    {
      kind: SpanKind.SERVER,
      attributes: {
        'http.request.method': req.method,
        'url.path': req.path,
        ...(typeof req.headers['user-agent'] === 'string' ? { 'user_agent.original': req.headers['user-agent'] } : {}),
      },
    },
    parentContext,
    (span: Span) => {
      // 日志与响应头对齐 span ID（traceMiddleware 先生成的 X-Trace-Id 可能与 span traceId 不同）
      const spanContext = span.spanContext();
      patchRequestContext({ traceId: spanContext.traceId, spanId: spanContext.spanId });
      res.setHeader('X-Trace-Id', spanContext.traceId);

      res.on('finish', () => {
        // 路由模板此时才可解析（express 匹配完成后写入 req.route）
        const routePath = (req as { route?: { path?: string } }).route?.path;
        if (routePath) span.updateName(`HTTP ${req.method} ${routePath}`);
        span.setAttribute('http.response.status_code', res.statusCode);
        // 5xx 记 ERROR（错误全采据此生效）；4xx 为客户端错误，按 OTel 惯例不记 ERROR
        span.setStatus({ code: res.statusCode >= 500 ? SpanStatusCode.ERROR : SpanStatusCode.UNSET });
        span.end();
      });

      try {
        next();
      } catch (error) {
        // 同步异常（罕见）：记录后结束 span 并上交 express
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        span.end();
        throw error;
      }
    },
  );
}

/**
 * 解析父上下文：traceparent → X-Trace-Id → 根
 * @param req HTTP 请求
 * @returns OTel 上下文
 */
function resolveParentContext(req: Request): Context {
  const headers = req.headers as Record<string, unknown>;

  // 1) 标准 traceparent：提取失败（头缺失或非法）时返回根上下文
  const extracted = propagation.extract(ROOT_CONTEXT, headers, headerGetter);
  if (extracted !== ROOT_CONTEXT) return extracted;

  // 2) X-Trace-Id：合成远端父 span，使 span traceId 与上游对齐（老客户端 / 未接 OTel 的上游）
  const upstream = normalizeTraceId(headerGetter.get(headers, 'x-trace-id'));
  if (upstream) {
    // setSpanContext 内部包 NonRecordingSpan：仅作父上下文，自身不记录
    return trace.setSpanContext(ROOT_CONTEXT, {
      traceId: upstream,
      spanId: randomSpanId(),
      traceFlags: 1,
      isRemote: true,
    });
  }

  // 3) 无上游信息：根 span
  return ROOT_CONTEXT;
}

/** 归一化 X-Trace-Id：去连字符、校验 32 位十六进制（非法返回 undefined） */
function normalizeTraceId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/-/g, '').toLowerCase();
  return TRACE_ID_PATTERN.test(compact) ? compact : undefined;
}

/** 生成 16 位十六进制 spanId（Node 20+ 全局 crypto；兜底随机数） */
function randomSpanId(): string {
  const cryptoObj = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoObj?.randomUUID) return cryptoObj.randomUUID().replace(/-/g, '').slice(0, 16);
  return Math.random().toString(16).slice(2, 10).padEnd(16, '0');
}

/**
 * 创建 OpenTelemetry express 中间件（与 @fw/tenant 的工厂模式一致）：
 *   - 启用时：每请求一个 SERVER span（逻辑同 otelMiddleware）；
 *   - 未启用时：直接 next，HTTP 层零开销（不建 span、不挂监听、不改响应头）。
 *
 * 经 bootstrap beforeListen 钩子无条件 `app.use(app.get(OTEL_MIDDLEWARE))` 注册，
 * 启用与否由工厂在装配期决定，业务侧无感。
 * @param options 运行时配置（读取 enabled 开关）
 * @returns express 中间件
 */
export function createOtelExpressMiddleware(options: { enabled: boolean }): OtelExpressMiddleware {
  if (!options.enabled) {
    return function otelDisabledMiddleware(_req: Request, _res: Response, next: NextFunction): void {
      next();
    };
  }
  return otelMiddleware;
}
