/*
 * @file OTel SDK 与导出器的懒加载
 * @description @opentelemetry/sdk-node 与 exporter-trace-otlp-http 为 **optional peerDependency**：
 *   OTEL_ENABLED=false 时不进入依赖图（与 @fw/transport 的 ioredis 同模式），只用 in-process /
 *   不接追踪的项目不必安装。模块类型以本文件的最小结构接口描述，避免框架层泄漏 SDK 细节。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { TelemetryUnavailableError } from './errors.js';

/** NodeTracerProvider 最小结构（sdk-node 天然满足） */
export interface NodeTracerProviderLike {
  /** 注册为全局 tracer provider（config.propagator 同时注册全局传播器） */
  register(config?: { propagator?: unknown }): void;
  /** 强制刷盘全部在途 span */
  forceFlush(): Promise<void>;
  /** 关闭 provider（停机时调用，flush 后释放） */
  shutdown(): Promise<void>;
}

/** NodeTracerProvider 构造函数最小结构 */
export interface NodeTracerProviderCtor {
  /**
   * 0.223 起 span 处理器经构造配置注入（早期版本的 addSpanProcessor 方法已移除）
   * @param config resource 资源属性 / spanProcessors 处理器列表
   */
  new (config: { resource?: unknown; spanProcessors?: unknown[] }): NodeTracerProviderLike;
}

/** SDK 的 node 命名空间最小结构（0.223 起 NodeTracerProvider 位于 node 命名空间下） */
export interface OtelNodeNamespace {
  /** tracer provider 构造器 */
  NodeTracerProvider: NodeTracerProviderCtor;
}

/** SDK 的 resources 命名空间最小结构 */
export interface OtelResourcesNamespace {
  /** 由属性表构造资源（service.name 等） */
  resourceFromAttributes?: (attributes: Record<string, string>) => unknown;
}

/** SDK 的 core 命名空间最小结构（传播器） */
export interface OtelCoreNamespace {
  /** W3C traceparent 传播器（跨服务 traceId 贯通的标准通道） */
  W3CTraceContextPropagator?: new () => unknown;
  /** W3C baggage 传播器 */
  W3CBaggagePropagator?: new () => unknown;
  /** 组合传播器：构造收配置对象 { propagators }（位置参数数组会被静默忽略） */
  CompositePropagator?: new (config: { propagators: unknown[] }) => unknown;
}

/** SDK 模块最小结构 */
export interface OtelSdkModule {
  /** node 命名空间（tracer provider） */
  node: OtelNodeNamespace;
  /** resources 命名空间（资源属性） */
  resources?: OtelResourcesNamespace;
  /** core 命名空间（传播器） */
  core?: OtelCoreNamespace;
}

/** OTLP/HTTP trace 导出器最小结构 */
export interface OtlpTraceExporterLike {
  /** 导出 span */
  export(spans: unknown[], callback: (result: { code?: number; error?: Error }) => void): void;
  /** 强制刷盘 */
  forceFlush(): Promise<void>;
  /** 关闭 */
  shutdown(): Promise<void>;
}

/** OTLP 导出器构造函数最小结构 */
export interface OtlpTraceExporterCtor {
  /** 0.223 的 http 导出器硬编码 JSON 序列化（content-type: application/json），无 protocol 选项 */
  new (config: { url: string; headers?: Record<string, string> }): OtlpTraceExporterLike;
}

/** 导出器模块最小结构 */
export interface OtlpExporterModule {
  /** OTLP/HTTP trace 导出器 */
  OTLPTraceExporter: OtlpTraceExporterCtor;
}

/** 懒加载缓存：同一进程只解析一次 */
let sdkModule: OtelSdkModule | undefined;
let exporterModule: OtlpExporterModule | undefined;

/** 缺 SDK 的可操作报错文案 */
export const MISSING_SDK_MESSAGE =
  '未安装 @opentelemetry/sdk-node：OTEL_ENABLED=true 需要 SDK（pnpm add @opentelemetry/sdk-node @opentelemetry/exporter-trace-otlp-http）。OTEL_ENABLED=false 无需安装。';

/**
 * 加载可选模块（optional peer 的统一入口）
 *
 * 区分两类失败：包未安装（给出可操作文案）与包内错误（原样抛出，不掩盖 bug）。
 * @param specifier 模块名
 * @param missingMessage 包未安装时的报错文案
 * @returns 模块对象
 * @throws TelemetryUnavailableError 包未安装
 */
export async function loadOptionalModule<T>(specifier: string, missingMessage: string): Promise<T> {
  try {
    return (await import(specifier)) as T;
  } catch (cause) {
    if (isModuleNotFound(cause)) throw new TelemetryUnavailableError(missingMessage, cause);
    throw cause;
  }
}

/**
 * 加载 OTel SDK（缺失时给出可操作提示）
 * @returns SDK 模块最小结构
 * @throws TelemetryUnavailableError 未安装 SDK
 */
export async function loadOtelSdk(): Promise<OtelSdkModule> {
  if (sdkModule) return sdkModule;
  sdkModule = await loadOptionalModule<OtelSdkModule>('@opentelemetry/sdk-node', MISSING_SDK_MESSAGE);
  return sdkModule;
}

/**
 * 加载 OTLP/HTTP 导出器（缺失时给出可操作提示）
 * @returns 导出器模块最小结构
 * @throws TelemetryUnavailableError 未安装导出器
 */
export async function loadOtlpExporter(): Promise<OtlpExporterModule> {
  if (exporterModule) return exporterModule;
  exporterModule = await loadOptionalModule<OtlpExporterModule>(
    '@opentelemetry/exporter-trace-otlp-http',
    '未安装 @opentelemetry/exporter-trace-otlp-http：OTEL_ENABLED=true 需要导出器（pnpm add @opentelemetry/exporter-trace-otlp-http）。',
  );
  return exporterModule;
}

/** 判断是否为「包未安装」类错误（与包内 bug 区分：后者原样抛出） */
function isModuleNotFound(cause: unknown): boolean {
  const code = (cause as { code?: string } | null)?.code;
  if (code === 'ERR_MODULE_NOT_FOUND' || code === 'MODULE_NOT_FOUND') return true;
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes('Cannot find package') || message.includes('Cannot find module');
}

/** 测试辅助：清空懒加载缓存（跨用例需要重新走加载分支时调用） */
export function resetOtelLoaderCache(): void {
  sdkModule = undefined;
  exporterModule = undefined;
}
