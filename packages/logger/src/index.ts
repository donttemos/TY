/*
 * @file @fw/logger 对外入口
 * @description 统一导出日志模块全部公共 API，禁止从深路径引用内部文件
 * @author donttemo
 * @created 2026-10-09
 * @module logger
 * @since v0.1.0
 */
export { Logger, configureLogger, setModuleLevel } from './logger.js';
export type { LogLevel, LogRecord, LogSink } from './logger.js';
export { MASK, redactText, redactValue } from './redact.js';
export {
  requestContextStorage,
  generateTraceId,
  runWithRequestContext,
  getRequestContext,
  patchRequestContext,
  getTraceId,
  getSpanId,
  setSpanContextProvider,
} from './context.js';
export type { RequestContext } from './context.js';
