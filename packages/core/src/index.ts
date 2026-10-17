/*
 * @file @fw/core 对外入口
 * @description 统一导出核心模块全部公共 API，禁止从深路径引用内部文件
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-09/12）：导出指标段注册表
 * @module core
 * @since v0.1.0
 */
export { ErrorCode, ERROR_CODE_META, HTTP_TO_ERROR_CODE } from './errors/error-codes.js';
export type { BizErrorCode, ErrorCodeMeta, ErrorBody } from './errors/error-codes.js';
export { BizError } from './errors/biz-error.js';
export type { FieldIssue } from './errors/biz-error.js';
export { registerMetricsSection, unregisterMetricsSection, renderExtraMetricSections } from './metrics/metrics-registry.js';
export { traceMiddleware } from './trace/trace.middleware.js';
export { ResponseInterceptor } from './response/response.interceptor.js';
export type { OkBody } from './response/response.interceptor.js';
export { GlobalExceptionFilter } from './exception/global-exception.filter.js';
export { HealthController, READINESS_PROBES } from './health/health.controller.js';
export type { ReadinessProbe } from './health/health.controller.js';
export { setupGracefulShutdown, runGracefulShutdown } from './lifecycle/graceful-shutdown.js';
export type { GracefulShutdownOptions } from './lifecycle/graceful-shutdown.js';
export { FwCoreModule } from './fw-core.module.js';
export type { FwCoreModuleOptions } from './fw-core.module.js';
export { bootstrap } from './bootstrap.js';
export type { BootstrapOptions, BootstrapResult } from './bootstrap.js';
