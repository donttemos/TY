/*
 * @file @fw/telemetry 对外入口
 * @description 统一导出链路追踪模块全部公共 API，禁止从深路径引用内部文件
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
export { TelemetryModule, type TelemetryModuleOptions } from './telemetry.module.js';
export { TelemetryService } from './telemetry.service.js';
export { buildTelemetryOptions, TELEMETRY_DEFAULTS, type TelemetryEnvLike } from './options.js';
export { RatioErrorSamplingProcessor, traceIdRatio } from './sampling.js';
export { readActiveSpanIds, registerLoggerSpanBridge, type ActiveSpanIds } from './span-bridge.js';
export { otelMiddleware, createOtelExpressMiddleware, type OtelExpressMiddleware } from './otel.middleware.js';
export {
  loadOtelSdk,
  loadOtlpExporter,
  resetOtelLoaderCache,
  MISSING_SDK_MESSAGE,
  type OtelSdkModule,
  type OtlpExporterModule,
} from './otel-loader.js';
export { TelemetryConfigError, TelemetryUnavailableError } from './errors.js';
export type {
  ReadableSpanLike,
  SamplingProcessorOptions,
  SpanExporterLike,
  TelemetryRuntimeOptions,
} from './types.js';
export { TELEMETRY_OPTIONS, TELEMETRY_SERVICE, OTEL_MIDDLEWARE } from './tokens.js';
