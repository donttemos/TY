/*
 * @file 传输层链路追踪插桩
 * @description M8 T-M8-06（PRD-008 FR-07）：traceId 贯穿传输调用——
 *   - 调用方：TransportService.call 包 CLIENT span（`transport.call <address>`）；
 *   - 处理方：驱动分发点包 SERVER span（`transport.handle <address>`）——redis 驱动经信封
 *     `traceparent` 字段过线提取父上下文，in-process 同进程直通活跃上下文；
 *   - 只依赖 @opentelemetry/api 的全局 no-op 语义：未注册 SDK 时全部退化为非记录 span，
 *     零外部依赖、零行为变化（与负责 SDK 装配的 @fw/telemetry 解耦）。
 *   跨进程链路：调用方 span →（信封 traceparent）→ 处理方 span，同一 traceId，
 *   采集端可见完整调用链（TC-TNT-006）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { context, propagation, trace, type Context, type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';

/** tracer 名（采集端按 instrumentation scope 过滤） */
const TRACER_NAME = 'fw.transport';

/** 根上下文（模块加载时捕获：此时无活跃 span，等价根） */
const ROOT_CONTEXT = context.active();

/** 记录异常并置错误状态（span 非记录态时为零成本 no-op） */
function failSpan(span: Span, error: unknown): void {
  span.recordException(error instanceof Error ? error : String(error));
  span.setStatus({
    code: SpanStatusCode.ERROR,
    message: error instanceof Error ? error.message : String(error),
  });
}

/**
 * 调用方 span：包裹一次传输调用（CLIENT）
 * @param address 传输地址
 * @param driver 驱动名（属性记录，采集端可按驱动筛选）
 * @param fn 业务逻辑（span 经活跃上下文透传其内）
 * @returns 业务返回值
 */
export async function withClientSpan<T>(address: string, driver: string, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    `transport.call ${address}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { 'transport.address': address, 'transport.driver': driver },
    },
    async (span: Span): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        failSpan(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * 处理方 span：包裹一次请求处理（SERVER）
 * @param address 传输地址
 * @param parent 父上下文：redis 驱动传信封提取结果；in-process 传 undefined（取活跃上下文，
 *   此时活跃上下文中即调用方的 CLIENT span，父子关系天然成立）
 * @param fn 业务逻辑
 * @returns 业务返回值
 */
export async function withServerSpan<T>(
  address: string,
  parent: Context | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    `transport.handle ${address}`,
    {
      kind: SpanKind.SERVER,
      attributes: { 'transport.address': address },
    },
    parent ?? context.active(),
    async (span: Span): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        failSpan(span, error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * 注入当前活跃上下文到载体（得到 traceparent 头字符串）
 * @returns 载体对象；无活跃 span 或未注册传播器时不含 traceparent 键
 */
export function injectTraceparent(): Record<string, string> {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set(c, k, v) {
      c[k] = v;
    },
  });
  return carrier;
}

/**
 * 从信封 traceparent 提取父上下文
 * @param traceparent 上游注入的 traceparent 头（可能缺失）
 * @returns 父上下文；缺失、非法或未注册传播器时返回 undefined（按根 span 处理）
 */
export function extractTraceparent(traceparent: string | undefined): Context | undefined {
  if (!traceparent) return undefined;
  return propagation.extract(
    ROOT_CONTEXT,
    { traceparent },
    {
      get(c, k) {
        return (c as Record<string, string>)[k];
      },
      keys(c) {
        return Object.keys(c as Record<string, string>);
      },
    },
  );
}
