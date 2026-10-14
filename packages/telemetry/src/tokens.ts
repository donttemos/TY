/*
 * @file 依赖注入令牌
 * @description TelemetryModule 的提供者/导出令牌（与 @fw/transport 的 tokens 约定一致）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */

/** 运行时配置提供者令牌 */
export const TELEMETRY_OPTIONS = Symbol('FW_TELEMETRY_OPTIONS');

/** 链路追踪服务令牌 */
export const TELEMETRY_SERVICE = Symbol('FW_TELEMETRY_SERVICE');

/** OTel express 中间件令牌（beforeListen 钩子 app.use(app.get(OTEL_MIDDLEWARE)) 用） */
export const OTEL_MIDDLEWARE = Symbol('FW_OTEL_MIDDLEWARE');
