/*
 * @file 缓存层链路追踪插桩
 * @description M8 T-M8-06（PRD-008 FR-07）：在 CacheService 的统一守卫点包一个 CLIENT span，
 *   使缓存操作并入请求链路（traceId 贯穿缓存）。只依赖 @opentelemetry/api 的全局 no-op 语义：
 *   未注册 SDK 时退化为非记录 span，零开销、零行为变化（与负责 SDK 装配的 @fw/telemetry 解耦）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/cache
 */

import { SpanKind, SpanStatusCode, trace } from '@opentelemetry/api';

/** tracer 名（采集端按 instrumentation scope 过滤） */
const TRACER_NAME = 'fw.cache';

/**
 * 缓存操作 span：包裹一次存储调用（CLIENT）
 * @param op 操作名（mget/del/has/expire 等，作为 span 名后缀）
 * @param driver 驱动名（memory/redis，记录为属性）
 * @param run 实际存储调用
 * @returns 存储调用结果
 */
export async function withCacheSpan<T>(op: string, driver: string, run: () => Promise<T>): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    `cache.${op}`,
    {
      kind: SpanKind.CLIENT,
      attributes: { 'db.system': 'cache', 'cache.operation': op, 'cache.driver': driver },
    },
    async (span): Promise<T> => {
      try {
        return await run();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({
          code: SpanStatusCode.ERROR,
          message: error instanceof Error ? error.message : String(error),
        });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
