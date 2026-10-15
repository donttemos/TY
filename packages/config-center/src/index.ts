/*
 * @file @fw/config-center 对外入口
 * @description 统一导出配置中心全部公共 API，禁止从深路径引用内部文件
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
export { ConfigCenterService } from './center.js';
export type { ConfigCenterOptions } from './center.js';
export { FileConfigDriver } from './drivers/file.driver.js';
export type { FileConfigDriverOptions } from './drivers/file.driver.js';
export type {
  ConfigAuditPort,
  ConfigChangeRecord,
  ConfigChangeSource,
  ConfigCenterMeta,
  ConfigDriverPort,
  ConfigEntryView,
  ConfigWriteContext,
  ConfigWriteResult,
  Unsubscribe,
} from './types.js';
