/*
 * @file 尾采样 span 处理器
 * @description 进程内 tail-sampling：所有 span 先记录（SDK sampler 保持 AlwaysOn），
 *   在本处理器的 onEnd 做导出决策——
 *   - 错误 span（status=ERROR 或记录过 exception 事件）全采，保证错误链路不丢；
 *   - 其余按 traceId 低 32 位与 sampleRatio 比较，**同一 traceId 决策恒定**，
 *     跨服务的同链路 span 采样结果一致（不会出现「有的服务导出了、有的没导出」的半链路）；
 *   - 未命中比例的 span 静默丢弃（不进入导出器）。
 *   取舍说明： AlwaysOn 记录 + 尾判丢弃意味着未采样链路也有记录开销（微秒级），
 *   换来错误全采与跨服务一致性；高 QPS 场景可把 ratio 设 1 并将尾采样下沉到采集端
 *   （OTLP collector 的 tail_sampling processor），由部署手册说明。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import type { ReadableSpanLike, SamplingProcessorOptions, SpanExporterLike } from './types.js';

/** @opentelemetry/api 的 SpanStatusCode.ERROR 值（避免为常量引整个 API） */
const SPAN_STATUS_ERROR = 2;

/** traceId 合法形态：32 位十六进制 */
const TRACE_ID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * 由 traceId 推导确定性比例值（[0, 1)）
 *
 * 取 traceId 低 8 位十六进制归一化：同一 traceId 在任何进程、任何时刻结果相同，
 * 因此同链路跨服务的采样决策一致。
 * @param traceId 32 位十六进制 traceId
 * @returns [0, 1) 区间值；非法 traceId 返回 0（按不采样处理，交由错误全采兜底）
 */
export function traceIdRatio(traceId: string): number {
  if (!TRACE_ID_PATTERN.test(traceId)) return 0;
  return parseInt(traceId.slice(-8), 16) / 0x1_0000_0000;
}

/** 判断 span 是否为错误 span（status=ERROR 或携带 exception 事件） */
function isErrorSpan(span: ReadableSpanLike): boolean {
  if (span.status.code === SPAN_STATUS_ERROR) return true;
  return span.events.some((event) => event.name === 'exception');
}

/**
 * 尾采样处理器（实现 SDK SpanProcessor 语义的最小子集：onStart/onEnd/forceFlush/shutdown）
 */
export class RatioErrorSamplingProcessor {
  private readonly exporter: SpanExporterLike;
  private readonly options: SamplingProcessorOptions;

  /**
   * @param exporter OTLP 导出器
   * @param options 采样比例与错误全采开关
   */
  constructor(exporter: SpanExporterLike, options: SamplingProcessorOptions) {
    this.exporter = exporter;
    this.options = options;
  }

  /** span 开始：无需动作（记录决策全部后置到 onEnd） */
  onStart(): void {}

  /**
   * span 结束：按错误全采 + 比例决策是否导出
   * @param span 已结束的 span
   */
  onEnd(span: ReadableSpanLike): void {
    const keep =
      (this.options.sampleErrors && isErrorSpan(span)) ||
      traceIdRatio(span.spanContext().traceId) < this.options.sampleRatio;
    if (keep) {
      // 导出失败不影响业务（OTLP 采集端临时不可达时丢span，日志仍带 traceId 可定位）
      this.exporter.export([span], () => undefined);
      return;
    }
    this.options.onDropped?.(span);
  }

  /** 强制刷盘 */
  async forceFlush(): Promise<void> {
    await this.exporter.forceFlush?.();
  }

  /** 关闭（先 flush 再关导出器） */
  async shutdown(): Promise<void> {
    await this.exporter.shutdown?.();
  }
}
