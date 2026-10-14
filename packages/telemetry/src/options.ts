/*
 * @file 链路追踪配置构建
 * @description 由 OTEL_* 环境变量构建运行时配置；`env` 为结构子集（真实 Env 天然满足，
 *   测试可传桩对象）。与 @fw/config 的 env-schema 默认值保持一致，缺省值仅用于桩对象兜底。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import type { TelemetryRuntimeOptions } from './types.js';

/** 环境变量结构子集（真实 Env 天然满足；测试可传桩对象） */
export interface TelemetryEnvLike {
  /** 运行环境（服务名兜底用） */
  APP_ENV?: string;
  /** 总开关 */
  OTEL_ENABLED?: boolean;
  /** 服务名 */
  OTEL_SERVICE_NAME?: string;
  /** OTLP 采集端点 */
  OTEL_EXPORTER_URL?: string;
  /** 采样比例 */
  OTEL_SAMPLE_RATIO?: number;
  /** 错误 span 全采 */
  OTEL_SAMPLE_ERRORS?: boolean;
}

/** 各项默认值（与 @fw/config 的 env-schema 保持一致，仅用于桩对象兜底） */
export const TELEMETRY_DEFAULTS = {
  enabled: false,
  sampleRatio: 0.1,
  sampleErrors: true,
} as const;

/**
 * 由环境变量构建链路追踪运行时配置
 * @param env 环境变量来源
 * @param overrides 覆盖项（优先级最高）
 * @returns TelemetryRuntimeOptions
 */
export function buildTelemetryOptions(
  env: TelemetryEnvLike,
  overrides: Partial<TelemetryRuntimeOptions> = {},
): TelemetryRuntimeOptions {
  const appEnv = env.APP_ENV ?? 'default';
  return {
    enabled: overrides.enabled ?? env.OTEL_ENABLED ?? TELEMETRY_DEFAULTS.enabled,
    // 服务名缺省取 `fw-<APP_ENV>`：同一采集端下可按环境区分服务实例
    serviceName:
      overrides.serviceName ??
      (env.OTEL_SERVICE_NAME && env.OTEL_SERVICE_NAME.length > 0 ? env.OTEL_SERVICE_NAME : `fw-${appEnv}`),
    exporterUrl: overrides.exporterUrl ?? (env.OTEL_EXPORTER_URL && env.OTEL_EXPORTER_URL.length > 0 ? env.OTEL_EXPORTER_URL : undefined),
    sampleRatio: overrides.sampleRatio ?? env.OTEL_SAMPLE_RATIO ?? TELEMETRY_DEFAULTS.sampleRatio,
    sampleErrors: overrides.sampleErrors ?? env.OTEL_SAMPLE_ERRORS ?? TELEMETRY_DEFAULTS.sampleErrors,
  };
}
