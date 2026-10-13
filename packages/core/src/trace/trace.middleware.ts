/*
 * @file traceId 中间件
 * @description 每个请求生成或透传 traceId，写入异步上下文（贯穿日志 / 响应头 / 错误对象）；上游带 X-Trace-Id 时直接复用。
 * @author donttemo
 * @created 2026-10-09
 * @module core
 * @since v0.1.0
 */
import type { NextFunction, Request, Response } from 'express';
import { generateTraceId, runWithRequestContext } from '@fw/logger';

/**
 * traceId 中间件：注册在最外层（bootstrap 内 app.use）
 * @param req HTTP 请求
 * @param res HTTP 响应（写入 X-Trace-Id 响应头）
 * @param next 下一个处理函数
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-trace-id'];
  const upstream = Array.isArray(header) ? header[0] : header;
  // 上游提供的 traceId 复用（跨服务链路贯通），否则服务端生成
  const traceId = upstream && /^[0-9a-f-]{8,64}$/i.test(upstream) ? upstream : generateTraceId();
  const tenantHeader = req.headers['x-tenant-id'];
  const tenantId = typeof tenantHeader === 'string' && /^[1-9][0-9]*$/.test(tenantHeader)
    ? tenantHeader
    : undefined;
  res.setHeader('X-Trace-Id', traceId);
  runWithRequestContext({ traceId, spanId: '', ...(tenantId ? { tenantId } : {}) }, next);
}
