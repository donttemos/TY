/*
 * @file StorageModule 装配单测
 * @description 驱动枚举装配、s3 配置完整性启动即失败、自定义端口注入（PRD-010 E-09 / TC-STO-*）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */
import { describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { Test } from '@nestjs/testing';
import { StorageModule, buildStorageOptions, parseExts } from '../storage.module.js';
import { LocalStorage } from '../drivers/local.driver.js';
import { StorageService } from '../storage.service.js';
import { STORAGE_OPTIONS, STORAGE_PORT } from '../tokens.js';
import type { StoragePort } from '../storage.port.js';

describe('buildStorageOptions', () => {
  it('全默认：local 驱动 + ./uploads + 20MB + 收紧白名单', () => {
    const options = buildStorageOptions({});
    expect(options.driver).toBe('local');
    expect(options.localRoot).toBe('./uploads');
    expect(options.maxBytes).toBe(20 * 1024 * 1024);
    expect(options.allowedExts).toContain('.png');
    expect(options.allowedExts).not.toContain('.exe');
    expect(options.s3ForcePathStyle).toBe(true);
    expect(options.s3Region).toBe('us-east-1');
  });

  it('env 全量映射（含敏感键与白名单解析）', () => {
    const options = buildStorageOptions({
      STORAGE_DRIVER: 's3',
      STORAGE_LOCAL_ROOT: '/data/up',
      STORAGE_S3_ENDPOINT: 'http://minio:9000',
      STORAGE_S3_REGION: 'ap-guangzhou',
      STORAGE_S3_BUCKET: 'fw-files',
      STORAGE_S3_ACCESS_KEY_ID: 'AKID',
      STORAGE_S3_SECRET_ACCESS_KEY: 'SECRET',
      STORAGE_S3_FORCE_PATH_STYLE: false,
      STORAGE_MAX_MB: 5,
      STORAGE_ALLOWED_EXTS: 'PNG, .pdf ,jpg',
    });
    expect(options.driver).toBe('s3');
    expect(options.localRoot).toBe('/data/up');
    expect(options.s3Endpoint).toBe('http://minio:9000');
    expect(options.s3Region).toBe('ap-guangzhou');
    expect(options.s3Bucket).toBe('fw-files');
    expect(options.s3AccessKeyId).toBe('AKID');
    expect(options.s3SecretAccessKey).toBe('SECRET');
    expect(options.s3ForcePathStyle).toBe(false);
    expect(options.maxBytes).toBe(5 * 1024 * 1024);
    expect(options.allowedExts).toEqual(['.png', '.pdf', '.jpg']);
  });

  it('overrides 优先级最高', () => {
    const options = buildStorageOptions({ STORAGE_MAX_MB: 5 }, { maxBytes: 1, driver: 'local' });
    expect(options.maxBytes).toBe(1);
    expect(options.driver).toBe('local');
  });

  it('parseExts：未配置 undefined / 空串 undefined / 补点归一', () => {
    expect(parseExts(undefined)).toBeUndefined();
    expect(parseExts('  ')).toBeUndefined();
    expect(parseExts('zip')).toEqual(['.zip']);
  });
});

describe('StorageModule.forRoot', () => {
  async function boot(env: Parameters<typeof buildStorageOptions>[0], port?: StoragePort) {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ env, ...(port ? { port } : {}) })],
    }).compile();
    await moduleRef.init();
    return moduleRef;
  }

  it('local 驱动装配 LocalStorage 与 StorageService', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'fw-storage-mod-'));
    try {
      const moduleRef = await boot({ STORAGE_LOCAL_ROOT: tmpRoot });
      const port = moduleRef.get<StoragePort>(STORAGE_PORT);
      expect(port.kind).toBe('local');
      expect(port).toBeInstanceOf(LocalStorage);
      const service = moduleRef.get(StorageService);
      const stored = await service.save({ buffer: Buffer.from('m'), originalName: 'a.txt' });
      await expect(service.read(stored.key)).resolves.toEqual(Buffer.from('m'));
      await service.remove(stored.key);
      await moduleRef.close();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });

  it('自定义端口注入后忽略 STORAGE_DRIVER', async () => {
    const fake: StoragePort = {
      kind: 's3',
      async put() {},
      async get() {
        throw new Error('not used');
      },
      async delete() {},
      async exists() {
        return true;
      },
      async stat() {
        return null;
      },
      async ping() {
        return true;
      },
      async close() {},
    };
    const moduleRef = await boot({ STORAGE_DRIVER: 's3' }, fake);
    expect(moduleRef.get<StoragePort>(STORAGE_PORT)).toBe(fake);
    await moduleRef.close();
  });

  it('s3 驱动缺桶名 → 启动即失败（不猜默认值）', async () => {
    await expect(boot({ STORAGE_DRIVER: 's3' })).rejects.toThrow(/必须配置 STORAGE_S3_BUCKET/);
  });

  it('exposeService=false 时不注册门面', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [StorageModule.forRoot({ env: {}, exposeService: false })],
    }).compile();
    await moduleRef.init();
    expect(moduleRef.get(STORAGE_PORT, { strict: false })).toBeTruthy();
    expect(() => moduleRef.get(StorageService)).toThrow();
    await moduleRef.close();
  });

  it('STORAGE_OPTIONS 与端口同模块导出', async () => {
    const moduleRef = await boot({});
    const options = moduleRef.get(STORAGE_OPTIONS, { strict: false }) as { driver: string };
    expect(options.driver).toBe('local');
    await moduleRef.close();
  });
});
