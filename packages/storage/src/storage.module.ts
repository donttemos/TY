/*
 * @file StorageModule：文件存储能力装配
 * @description `StorageModule.forRoot()` 按 `STORAGE_DRIVER` 装配存储驱动（local 零依赖；
 *   s3 走 @aws-sdk/client-s3 懒加载、未安装启动即失败）、构建运行时配置并注册 StorageService。
 *   切换驱动只改配置：业务代码 diff = 0（PRD-010 E-09 / ADR-0015）。
 *   非法取值在启动时即失败（zod 枚举 + s3 配置完整性双保险）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { loadEnv } from '@fw/config';
import { LocalStorage } from './drivers/local.driver.js';
import { S3Storage } from './drivers/s3.driver.js';
import { createS3Client } from './drivers/s3-client.js';
import { DEFAULT_ALLOWED_EXTS, DEFAULT_MAX_BYTES } from './key.js';
import { StorageService } from './storage.service.js';
import type { StoragePort } from './storage.port.js';
import { STORAGE_OPTIONS, STORAGE_PORT, STORAGE_SERVICE } from './tokens.js';
import type { StorageDriverName, StorageRuntimeOptions } from './types.js';

/** 环境变量结构子集（真实 Env 天然满足；测试可传桩对象） */
export interface StorageEnvLike {
  STORAGE_DRIVER?: StorageDriverName;
  STORAGE_LOCAL_ROOT?: string;
  STORAGE_S3_ENDPOINT?: string;
  STORAGE_S3_REGION?: string;
  STORAGE_S3_BUCKET?: string;
  STORAGE_S3_ACCESS_KEY_ID?: string;
  STORAGE_S3_SECRET_ACCESS_KEY?: string;
  STORAGE_S3_FORCE_PATH_STYLE?: boolean;
  STORAGE_MAX_MB?: number;
  STORAGE_ALLOWED_EXTS?: string;
}

/** 各项默认值（与 @fw/config 的 env-schema 保持一致，仅用于桩对象兜底） */
const DEFAULTS = {
  driver: 'local' as StorageDriverName,
  localRoot: './uploads',
  s3Region: 'us-east-1',
  s3ForcePathStyle: true,
  maxMb: 20,
  allowedExts: DEFAULT_ALLOWED_EXTS,
};

/**
 * 由环境变量构建存储运行时配置
 * @param env 环境变量来源
 * @param overrides 覆盖项（优先级最高）
 * @returns StorageRuntimeOptions
 */
export function buildStorageOptions(env: StorageEnvLike, overrides: Partial<StorageRuntimeOptions> = {}): StorageRuntimeOptions {
  const maxBytes = overrides.maxBytes ?? (env.STORAGE_MAX_MB ?? DEFAULTS.maxMb) * 1024 * 1024;
  return {
    driver: overrides.driver ?? env.STORAGE_DRIVER ?? DEFAULTS.driver,
    localRoot: overrides.localRoot ?? env.STORAGE_LOCAL_ROOT ?? DEFAULTS.localRoot,
    s3Endpoint: overrides.s3Endpoint ?? env.STORAGE_S3_ENDPOINT,
    s3Region: overrides.s3Region ?? env.STORAGE_S3_REGION ?? DEFAULTS.s3Region,
    s3Bucket: overrides.s3Bucket ?? env.STORAGE_S3_BUCKET,
    s3AccessKeyId: overrides.s3AccessKeyId ?? env.STORAGE_S3_ACCESS_KEY_ID,
    s3SecretAccessKey: overrides.s3SecretAccessKey ?? env.STORAGE_S3_SECRET_ACCESS_KEY,
    s3ForcePathStyle: overrides.s3ForcePathStyle ?? env.STORAGE_S3_FORCE_PATH_STYLE ?? DEFAULTS.s3ForcePathStyle,
    maxBytes,
    allowedExts: overrides.allowedExts ?? parseExts(env.STORAGE_ALLOWED_EXTS) ?? [...DEFAULTS.allowedExts],
  };
}

/** 逗号分隔扩展名清单 → 小写含点数组（空/未配置返回 undefined 走默认） */
export function parseExts(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const items = raw
    .split(',')
    .map((item) => item.trim().toLowerCase())
    .filter((item) => item !== '');
  if (items.length === 0) return undefined;
  return items.map((item) => (item.startsWith('.') ? item : `.${item}`));
}

/** forRoot 入参 */
export interface StorageModuleOptions {
  /** 环境变量来源，缺省读进程环境 */
  env?: StorageEnvLike;
  /** 直接覆盖运行时配置（测试用） */
  overrides?: Partial<StorageRuntimeOptions>;
  /** 自定义存储端口（测试注入 fake；传入后忽略 STORAGE_DRIVER） */
  port?: StoragePort;
  /** 是否注册 StorageService 门面（默认 true） */
  exposeService?: boolean;
}

/**
 * 存储全局模块
 */
@Global()
@Module({})
export class StorageModule {
  /**
   * 装配存储能力
   * @param options 环境、覆盖项与自定义端口
   * @returns 动态模块定义
   */
  static forRoot(options: StorageModuleOptions = {}): DynamicModule {
    // 真实 Env（@fw/config）与桩对象都满足 StorageEnvLike；结构收窄取 STORAGE_* 子集
    const env = (options.env ?? loadEnv()) as StorageEnvLike;
    const runtime = buildStorageOptions(env, options.overrides);

    const providers: Provider[] = [
      {
        // 异步工厂：s3 驱动内部动态 import('@aws-sdk/client-s3')，local 驱动下 SDK 不入依赖图
        provide: STORAGE_PORT,
        useFactory: async (): Promise<StoragePort> => {
          if (options.port) return options.port;
          if (runtime.driver === 'local') return new LocalStorage(runtime.localRoot);
          // s3 驱动配置完整性：桶名必填（启动即失败，不猜默认桶）
          if (!runtime.s3Bucket) {
            throw new Error('STORAGE_DRIVER=s3 时必须配置 STORAGE_S3_BUCKET（启动即失败，不猜默认值）');
          }
          const { client, commands } = await createS3Client({
            endpoint: runtime.s3Endpoint,
            region: runtime.s3Region ?? DEFAULTS.s3Region,
            bucket: runtime.s3Bucket,
            accessKeyId: runtime.s3AccessKeyId,
            secretAccessKey: runtime.s3SecretAccessKey,
            forcePathStyle: runtime.s3ForcePathStyle,
          });
          return new S3Storage(client, commands, runtime.s3Bucket);
        },
      },
      { provide: STORAGE_OPTIONS, useValue: runtime },
    ];
    if (options.exposeService !== false) {
      providers.push(
        {
          provide: StorageService,
          useFactory: (port: StoragePort, opts: StorageRuntimeOptions): StorageService => new StorageService(port, opts),
          inject: [STORAGE_PORT, STORAGE_OPTIONS],
        },
        { provide: STORAGE_SERVICE, useExisting: StorageService },
      );
    }

    return {
      module: StorageModule,
      global: true,
      providers,
      exports: [STORAGE_PORT, STORAGE_OPTIONS, ...(options.exposeService !== false ? [StorageService, STORAGE_SERVICE] : [])],
    };
  }
}
