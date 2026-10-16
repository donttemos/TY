/*
 * @file @fw/storage 对外入口
 * @description 统一导出存储层全部公共 API（服务、模块、驱动、端口、key 工具与类型），
 *   禁止从深路径引用内部文件；驱动特有类型（fs / @aws-sdk/client-s3）不出现在导出面。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

// ---------- 模块装配 ----------
export { StorageModule, buildStorageOptions, parseExts } from './storage.module.js';
export type { StorageEnvLike, StorageModuleOptions } from './storage.module.js';
export { STORAGE_PORT, STORAGE_OPTIONS, STORAGE_SERVICE } from './tokens.js';

// ---------- 服务 ----------
export { StorageService, STORAGE_SERVICE_DEFAULTS } from './storage.service.js';

// ---------- 驱动 ----------
export { LocalStorage } from './drivers/local.driver.js';
export { S3Storage } from './drivers/s3.driver.js';
export { createS3Client, bodyToBuffer } from './drivers/s3-client.js';
export type { S3ClientLike, S3CommandFactory, S3CommandLike, S3ClientOptions } from './drivers/s3-client.js';

// ---------- 端口与工具 ----------
export type { StoragePort, StorageObjectMeta } from './storage.port.js';
export { assertKey, extOf, DEFAULT_ALLOWED_EXTS, DEFAULT_MAX_BYTES, MAX_KEY_LENGTH } from './key.js';

// ---------- 类型 ----------
export type { StorageDriverName, StorageRuntimeOptions, StorageUploadInput, StoredFile } from './types.js';
