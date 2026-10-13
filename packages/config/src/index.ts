/*
 * @file @fw/config 对外入口
 * @description 统一导出配置模块全部公共 API，禁止从深路径引用内部文件
 * @author donttemo
 * @created 2026-10-09
 * @module config
 * @since v0.1.0
 */
export { envSchema, ENUM_OPTIONS } from './env-schema.js';
export type { Env } from './env-schema.js';
export {
  APP_ENV_VALUES,
  LOG_LEVEL_VALUES,
  DB_DRIVER_VALUES,
  CACHE_DRIVER_VALUES,
  AUTH_STRATEGY_VALUES,
  MQ_DRIVER_VALUES,
  TRANSPORT_DRIVER_VALUES,
  TRANSPORT_ROLE_VALUES,
} from './env-schema.js';
export { ConfigValidationError, translateIssues } from './config-error.js';
export type { ConfigIssue } from './config-error.js';
export { loadEnv } from './loader.js';
export type { LoadOptions } from './loader.js';
export { ConfigService } from './config-service.js';
export type { AppConfig, ConfigPath, ConfigValue } from './config-service.js';
