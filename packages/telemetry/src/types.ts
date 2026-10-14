/*
 * @file 链路追踪公共类型
 * @description @fw/telemetry 的运行时配置与导出协议。插桩点（db / cache / queue / transport）
 *   只依赖 @opentelemetry/api 的全局 no-op 语义，不依赖本包；本包负责 SDK 装配、导出与生命周期。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */

/** 链路追踪运行时配置（由 OTEL_* 环境变量构建） */
export interface TelemetryRuntimeOptions {
  /** 总开关：false 时本模块零开销（不注册 SDK、不桥接日志，插桩点退化为非记录 span） */
  enabled: boolean;
  /** 服务名（资源属性 service.name；缺省取 `fw-<APP_ENV>`） */
  serviceName: string;
  /** OTLP/HTTP 采集端点（启用后必填，缺省启动即失败） */
  exporterUrl?: string;
  /** 采样比例（0~1）：按 traceId 低 32 位确定性决策，同链路跨服务决策一致 */
  sampleRatio: number;
  /** 错误 span 全采（status=ERROR 或记录过异常时忽略比例，保证错误链路不丢） */
  sampleErrors: boolean;
}

/** 导出的 span 最小结构（采样处理器只读这些字段） */
export interface ReadableSpanLike {
  /** span 名 */
  name: string;
  /** span 上下文（traceId / spanId / traceFlags） */
  spanContext(): { traceId: string; spanId: string; traceFlags: number };
  /** 状态码（1 = ERROR，0 = UNSET；与 @opentelemetry/api 的 SpanStatusCode 对齐） */
  status: { code: number; message?: string };
  /** 事件列表（异常事件的 name 为 'exception'） */
  events: Array<{ name: string }>;
  /** span 类型（SDK SpanKind 数值） */
  kind: number;
  /** 属性表 */
  attributes: Record<string, unknown>;
}

/** 导出器最小接口（OTLP exporter 天然满足） */
export interface SpanExporterLike {
  /** 导出一批 span（结果经回调返回，不同步抛出） */
  export(spans: unknown[], callback: (result: { code?: number; error?: Error }) => void): void;
  /** 强制刷盘（停机时调用） */
  forceFlush?(): Promise<void>;
  /** 关闭导出器 */
  shutdown?(): Promise<void>;
}

/** 采样处理器构造选项 */
export interface SamplingProcessorOptions {
  /** 采样比例（0~1） */
  sampleRatio: number;
  /** 错误 span 全采 */
  sampleErrors: boolean;
  /** 被丢弃 span 的回调（测试与调试用） */
  onDropped?: (span: ReadableSpanLike) => void;
}
