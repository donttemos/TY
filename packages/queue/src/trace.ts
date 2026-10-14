/*
 * @file 队列链路追踪插桩
 * @description M8 T-M8-06（PRD-008 FR-07）：traceId 贯穿异步任务——
 *   - 生产侧：QueueService.dispatch 包 PRODUCER span，并把活跃上下文序列化为 traceparent 写入
 *     JobRecord（bullmq 整 record 序列化，天然随任务过线）；
 *   - 消费侧：QueueService.invoke 从 JobRecord 提取父上下文后包 CONSUMER span，
 *     使任务执行续接派发时的链路（跨进程/跨重试亦可关联）。
 *   只依赖 @opentelemetry/api 的全局 no-op 语义：未启用追踪时全部退化为非记录 span，零行为变化。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/queue
 */

import { context, propagation, trace, type Context, type Span, SpanKind, SpanStatusCode } from '@opentelemetry/api';

/** tracer 名（采集端按 instrumentation scope 过滤） */
const TRACER_NAME = 'fw.queue';

/** 根上下文（模块加载时捕获：此时无活跃 span，等价根） */
const ROOT_CONTEXT = context.active();

/**
 * 生产侧 span：包裹一次任务派发（PRODUCER）
 * @param name 任务名
 * @param queue 队列名
 * @param fn 派发逻辑（span 经活跃上下文透传其内，供 traceparent 注入取用）
 * @returns 派发返回值
 */
export async function withProducerSpan<T>(name: string, queue: string, fn: () => Promise<T>): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    `queue.dispatch ${name}`,
    {
      kind: SpanKind.PRODUCER,
      attributes: { 'messaging.system': 'fw-queue', 'messaging.destination.name': queue, 'messaging.operation': 'dispatch' },
    },
    async (span: Span): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * 消费侧 span：包裹一次任务执行（CONSUMER）
 * @param name 任务名
 * @param queue 队列名
 * @param parent 父上下文（由 record.traceparent 提取；缺失时取活跃上下文）
 * @param fn 执行逻辑
 * @returns 执行返回值
 */
export async function withConsumerSpan<T>(
  name: string,
  queue: string,
  parent: Context | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  return trace.getTracer(TRACER_NAME).startActiveSpan(
    `queue.process ${name}`,
    {
      kind: SpanKind.CONSUMER,
      attributes: { 'messaging.system': 'fw-queue', 'messaging.destination.name': queue, 'messaging.operation': 'process' },
    },
    parent ?? context.active(),
    async (span: Span): Promise<T> => {
      try {
        return await fn();
      } catch (error) {
        span.recordException(error instanceof Error ? error : String(error));
        span.setStatus({ code: SpanStatusCode.ERROR, message: error instanceof Error ? error.message : String(error) });
        throw error;
      } finally {
        span.end();
      }
    },
  );
}

/**
 * 注入当前活跃上下文为 traceparent 头字符串（写入 JobRecord 随任务过线）
 * @returns traceparent 头；无活跃 span 或未注册传播器时返回 undefined
 */
export function currentTraceparent(): string | undefined {
  const carrier: Record<string, string> = {};
  propagation.inject(context.active(), carrier, {
    set(c, k, v) {
      c[k] = v;
    },
  });
  return carrier.traceparent;
}

/**
 * 从 JobRecord 的 traceparent 提取父上下文
 * @param traceparent 任务记录中的 traceparent（可能缺失）
 * @returns 父上下文；缺失、非法或未注册传播器时返回 undefined
 */
export function parentFromTraceparent(traceparent: string | undefined): Context | undefined {
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
