/*
 * @file 存储门面服务单测
 * @description 上传校验（大小/扩展名默认收紧）与 key 生成约定（PRD-010 E-09 NFR / TC-STO-*）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */
import { describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { BizError, ErrorCode } from '@fw/core';
import { LocalStorage } from '../drivers/local.driver.js';
import { DEFAULT_ALLOWED_EXTS, DEFAULT_MAX_BYTES } from '../key.js';
import { StorageService, STORAGE_SERVICE_DEFAULTS } from '../storage.service.js';
import type { StoragePort } from '../storage.port.js';
import type { StorageRuntimeOptions } from '../types.js';

/** 内存端口 fake（记录调用；逐字节透传） */
function makeFakePort(): StoragePort & { objects: Map<string, Buffer> } {
  const objects = new Map<string, Buffer>();
  return {
    kind: 'local',
    objects,
    async put(key, data) {
      objects.set(key, data);
    },
    async get(key) {
      const data = objects.get(key);
      if (!data) throw new BizError(ErrorCode.NOT_FOUND, '文件不存在或已删除');
      return data;
    },
    async delete(key) {
      objects.delete(key);
    },
    async exists(key) {
      return objects.has(key);
    },
    async stat(key) {
      const data = objects.get(key);
      return data ? { key, size: data.length } : null;
    },
    async ping() {
      return true;
    },
    async close() {},
  };
}

function makeService(overrides: Partial<StorageRuntimeOptions> = {}, port = makeFakePort()): StorageService {
  const options: StorageRuntimeOptions = {
    driver: 'local',
    localRoot: './tmp',
    s3ForcePathStyle: true,
    maxBytes: DEFAULT_MAX_BYTES,
    allowedExts: DEFAULT_ALLOWED_EXTS,
    ...overrides,
  };
  return new StorageService(port, options);
}

describe('StorageService.validate', () => {
  it('合法文件通过（默认白名单内的扩展名）', () => {
    expect(() => makeService().validate({ buffer: Buffer.from('ok'), originalName: '报告.xlsx' })).not.toThrow();
  });

  it('空内容拒绝', () => {
    expect(() => makeService().validate({ buffer: Buffer.alloc(0), originalName: 'a.png' })).toThrow(BizError);
  });

  it('超限拒绝（默认 20MB；不静默截断）', () => {
    const big = Buffer.alloc(DEFAULT_MAX_BYTES + 1);
    expect(() => makeService().validate({ buffer: big, originalName: 'a.png' })).toThrow(/超出大小上限（20MB）/);
  });

  it('白名单外扩展名拒绝（含无扩展名与双扩展名取最后一段）', () => {
    const service = makeService();
    expect(() => service.validate({ buffer: Buffer.from('x'), originalName: 'evil.exe' })).toThrow(/不支持的文件类型：.exe/);
    expect(() => service.validate({ buffer: Buffer.from('x'), originalName: 'noext' })).toThrow(/不支持的文件类型：\(无扩展名\)/);
    expect(() => service.validate({ buffer: Buffer.from('x'), originalName: 'a.tar.gz' })).toThrow(/不支持的文件类型：.gz/);
  });

  it('配置收紧后白名单即时生效', () => {
    const service = makeService({ allowedExts: ['.png'] });
    expect(() => service.validate({ buffer: Buffer.from('x'), originalName: 'a.pdf' })).toThrow(/不支持的文件类型：.pdf/);
    expect(service.allowedExts).toEqual(['.png']);
  });

  it('配置放宽上限即时生效', () => {
    const service = makeService({ maxBytes: 1024 });
    expect(service.maxBytes).toBe(1024);
    expect(() => service.validate({ buffer: Buffer.alloc(1025), originalName: 'a.png' })).toThrow(/超出大小上限/);
  });
});

describe('StorageService.save', () => {
  it('key 形如 <yyyyMM>/<uuid><ext> 且逐字节落盘', async () => {
    const port = makeFakePort();
    const service = makeService({}, port);
    const data = Buffer.from('payload');
    const stored = await service.save({ buffer: data, originalName: '截图.PNG', mimeType: 'image/png' });
    expect(stored.key).toMatch(/^\d{6}\/[0-9a-f-]{36}\.png$/);
    expect(stored.originalName).toBe('截图.PNG');
    expect(stored.mimeType).toBe('image/png');
    expect(stored.size).toBe(data.length);
    expect(port.objects.get(stored.key)?.equals(data)).toBe(true);
  });

  it('无 MIME 缺省 application/octet-stream', async () => {
    const service = makeService();
    const stored = await service.save({ buffer: Buffer.from('x'), originalName: 'a.txt' });
    expect(stored.mimeType).toBe('application/octet-stream');
  });

  it('校验不过不触达端口', async () => {
    const port = makeFakePort();
    const service = makeService({}, port);
    await expect(service.save({ buffer: Buffer.from('x'), originalName: 'a.exe' })).rejects.toBeInstanceOf(BizError);
    expect(port.objects.size).toBe(0);
  });
});

describe('StorageService 代理方法', () => {
  it('read / meta / remove 直通端口', async () => {
    const service = makeService();
    const stored = await service.save({ buffer: Buffer.from('roundtrip'), originalName: 'a.txt' });
    await expect(service.read(stored.key)).resolves.toEqual(Buffer.from('roundtrip'));
    await expect(service.meta(stored.key)).resolves.toMatchObject({ size: 9 });
    await service.remove(stored.key);
    await expect(service.meta(stored.key)).resolves.toBeNull();
    await expect(service.remove(stored.key)).resolves.toBeUndefined();
  });

  it('STORAGE_SERVICE_DEFAULTS 与包默认一致', () => {
    expect(STORAGE_SERVICE_DEFAULTS.maxBytes).toBe(DEFAULT_MAX_BYTES);
    expect(STORAGE_SERVICE_DEFAULTS.allowedExts).toEqual(DEFAULT_ALLOWED_EXTS);
  });

  it('local 端点下端到端保存可读回（临时目录）', async () => {
    const tmpRoot = await mkdtemp(path.join(tmpdir(), 'fw-storage-svc-'));
    try {
      const local = new LocalStorage(tmpRoot);
      const service = new StorageService(local, {
        driver: 'local',
        localRoot: tmpRoot,
        s3ForcePathStyle: true,
        maxBytes: DEFAULT_MAX_BYTES,
        allowedExts: DEFAULT_ALLOWED_EXTS,
      });
      const spy = vi.spyOn(local, 'put');
      const stored = await service.save({ buffer: Buffer.from('e2e'), originalName: 'e2e.txt' });
      expect(spy).toHaveBeenCalledOnce();
      await expect(service.read(stored.key)).resolves.toEqual(Buffer.from('e2e'));
      await service.remove(stored.key);
      await local.close();
    } finally {
      await rm(tmpRoot, { recursive: true, force: true });
    }
  });
});
