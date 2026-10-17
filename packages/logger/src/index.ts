/*
 * @file @fw/logger 对外入口
 * @description 统一导出日志模块全部公共 API，禁止从深路径引用内部文件
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-09/10/11）：导出 requestId 生成/读取与身份上下文
 * @module logger
 * @since v0.1.0
 */
export { Logger, configureLogger, setModuleLevel, resetIdentityFieldsCache } from './logger.js';
export type { LogLevel, LogRecord, LogOptions, LogSink } from './logger.js';
export { MASK, redactText, redactValue } from './redact.js';
export {
  requestContextStorage,
  generateTraceId,
  generateRequestId,
  REQUEST_ID_PATTERN,
  runWithRequestContext,
  getRequestContext,
  patchRequestContext,
  getTraceId,
  getSpanId,
  getRequestId,
  setSpanContextProvider,
} from './context.js';
export type { RequestContext } from './context.js';
