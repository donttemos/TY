/*
 * @file 后端 traceId 旁路记录（M10/E-17）
 * @description 统一请求层在收到响应时记录最近一次 `X-Trace-Id`（request.ts 的响应/错误拦截器
 *   调用 rememberTraceId）。前端 RUM 上报携带该值，使「前端报的错误」与「后端同请求的日志」
 *   在追踪系统里同链可见——不依赖 OTel 前端 SDK 的轻量关联方式。
 * @author donttemo
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-09）：BizError 增 requestId（additive）
 * @created 2026-10-17
 * @module admin-web/utils
 */

/** 最近一次后端响应 traceId（无响应 / 无响应头时为 null） */
let lastTraceId: string | null = null;

/**
 * 记录后端响应 traceId（由 request.ts 拦截器调用）
 * @param value X-Trace-Id 响应头值（缺失 / 非字符串时忽略，保留上一次有效值）
 */
export function rememberTraceId(value: unknown): void {
  if (typeof value === 'string' && value) lastTraceId = value;
}

/** 读取最近一次后端响应 traceId（RUM 上报关联用） */
export function getLastTraceId(): string | null {
  return lastTraceId;
}

/** 重置（测试 / 登出清理用） */
export function resetTraceId(): void {
  lastTraceId = null;
  lastRequestId = null;
}

/** 最近一次后端响应 requestId（M12 W2 OBS-09；无响应 / 无响应头时为 null） */
let lastRequestId: string | null = null;

/**
 * 记录后端响应 requestId（由 request.ts 拦截器调用）
 * @param value X-Request-Id 响应头值（缺失 / 非字符串时忽略，保留上一次有效值）
 */
export function rememberRequestId(value: unknown): void {
  if (typeof value === 'string' && value) lastRequestId = value;
}

/** 读取最近一次后端响应 requestId（报障双 ID 展示用） */
export function getLastRequestId(): string | null {
  return lastRequestId;
}
