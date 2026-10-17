/*
 * @file traceId / requestId 中间件
 * @description 每个请求生成或透传双 ID，写入异步上下文（贯穿日志 / 响应头 / 错误信封 / 审计）：
 *   traceId——上游带 X-Trace-Id 时直接复用（跨服务链路贯通，OTel 语义）；
 *   requestId——M12 W2（PRD-012 OBS-09，ADR-0026）：单请求 ULID，上游带合法 X-Request-Id 时复用、
 *   非法值替换；生命周期 = 单次 HTTP 请求，不跨服务透传（跨服务语义归 traceId，NG12-5）。
 *   REQUEST_ID_ENABLED=false 时回退为「仅 traceId」（零行为差异）；REQUEST_ID_HEADER 可改头名。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-09）：requestId 双 ID 分层（生成/复用/回带/ALS）
 * @module core
 * @since v0.1.0
 */
import type { NextFunction, Request, Response } from 'express';
import { REQUEST_ID_PATTERN, generateRequestId, generateTraceId, runWithRequestContext } from '@fw/logger';

/** 默认请求 ID 头名（可用 REQUEST_ID_HEADER 覆盖） */
const DEFAULT_REQUEST_ID_HEADER = 'X-Request-Id';

/**
 * traceId / requestId 中间件：注册在最外层（bootstrap 内 app.use）
 * @param req HTTP 请求
 * @param res HTTP 响应（写入 X-Trace-Id 与 X-Request-Id 响应头）
 * @param next 下一个处理函数
 */
export function traceMiddleware(req: Request, res: Response, next: NextFunction): void {
  const header = req.headers['x-trace-id'];
  const upstream = Array.isArray(header) ? header[0] : header;
  // 上游提供的 traceId 复用（跨服务链路贯通），否则服务端生成
  const traceId = upstream && /^[0-9a-f-]{8,64}$/i.test(upstream) ? upstream : generateTraceId();

  // M12 W2 OBS-09：requestId 默认开启；REQUEST_ID_ENABLED=false 时回退仅 traceId（零行为差异）
  const enabled = process.env.REQUEST_ID_ENABLED !== 'false';
  const headerName = (process.env.REQUEST_ID_HEADER || DEFAULT_REQUEST_ID_HEADER).toLowerCase();
  const rawId = req.headers[headerName as keyof typeof req.headers];
  const upstreamRequestId = Array.isArray(rawId) ? rawId[0] : typeof rawId === 'string' ? rawId : undefined;
  // 上游合法 requestId 复用；缺失或非法值一律服务端生成（反向验证：非法值被替换）
  const requestId = enabled
    ? upstreamRequestId && REQUEST_ID_PATTERN.test(upstreamRequestId)
      ? upstreamRequestId
      : generateRequestId()
    : undefined;

  const tenantHeader = req.headers['x-tenant-id'];
  const tenantId = typeof tenantHeader === 'string' && /^[1-9][0-9]*$/.test(tenantHeader)
    ? tenantHeader
    : undefined;
  res.setHeader('X-Trace-Id', traceId);
  if (requestId) res.setHeader(process.env.REQUEST_ID_HEADER || DEFAULT_REQUEST_ID_HEADER, requestId);
  runWithRequestContext({ traceId, spanId: '', ...(requestId ? { requestId } : {}), ...(tenantId ? { tenantId } : {}) }, next);
}
