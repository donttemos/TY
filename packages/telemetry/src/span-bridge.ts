/*
 * @file 日志 span 桥接
 * @description 把 @opentelemetry/api 的活跃 span 映射进 @fw/logger 的上下文字段：
 *   注册一个 span 上下文提供者后，getTraceId()/getSpanId() 优先取活跃 span 的 ID
 *   （无活跃 span 时回退 AsyncLocalStorage 里的请求上下文，保持未启用追踪时的既有行为）。
 *   @fw/logger 不依赖 @opentelemetry/api——提供者是普通函数类型，禁用时永不注册。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { trace } from '@opentelemetry/api';
import { setSpanContextProvider } from '@fw/logger';

/** 活跃 span 的 ID 对（与 logger 桥接所需的最小结构） */
export interface ActiveSpanIds {
  /** traceId（32 位十六进制） */
  traceId: string;
  /** spanId（16 位十六进制） */
  spanId: string;
}

/** 全零 ID（未注册 SDK 时 noop span 的上下文）视为无效，避免污染日志字段 */
const ZERO_ID = /^0+$/;

/**
 * 读取当前活跃 span 的 ID
 * @returns ID 对；无活跃 span、span 无上下文或上下文为全零（noop span）时返回 undefined
 */
export function readActiveSpanIds(): ActiveSpanIds | undefined {
  const spanContext = trace.getActiveSpan()?.spanContext();
  if (!spanContext?.traceId || !spanContext?.spanId) return undefined;
  // 未注册 SDK 时 tracer 产出 noop span（全零 ID）：不桥接，让日志回退请求上下文
  if (ZERO_ID.test(spanContext.traceId) || ZERO_ID.test(spanContext.spanId)) return undefined;
  return { traceId: spanContext.traceId, spanId: spanContext.spanId };
}

/**
 * 注册日志 span 桥接（TelemetryModule 启用时调用一次；幂等）
 *
 * 说明：禁用了追踪的项目永不调用本函数，logger 行为零变化。
 */
export function registerLoggerSpanBridge(): void {
  setSpanContextProvider(() => {
    try {
      return readActiveSpanIds();
    } catch {
      // 桥接读取异常不得影响日志输出
      return undefined;
    }
  });
}
