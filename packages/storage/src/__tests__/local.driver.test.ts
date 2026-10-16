/*
 * @file local 驱动单测
 * @description 真实临时目录上的读写删语义与越界防护（PRD-010 E-09 / TC-STO-*）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { BizError } from '@fw/core';
import { LocalStorage } from '../drivers/local.driver.js';

describe('LocalStorage', () => {
  let root: string;
  let storage: LocalStorage;

  beforeEach(async () => {
    root = await mkdtemp(path.join(tmpdir(), 'fw-storage-'));
    storage = new LocalStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('put → get 逐字节往返（N-02 同构纪律）', async () => {
    const data = Buffer.from([0x00, 0x01, 0xfe, 0xff, ...Buffer.from('你好 fw storage')]);
    await storage.put('202610/a-b_C.9.png', data, 'image/png');
    const out = await storage.get('202610/a-b_C.9.png');
    expect(out.equals(data)).toBe(true);
  });

  it('put 自动建目录，磁盘上 key 即相对路径', async () => {
    await storage.put('202610/dir-inner/x.bin', Buffer.from('x'));
    const abs = path.join(root, '202610', 'dir-inner', 'x.bin');
    await expect(readFile(abs)).resolves.toEqual(Buffer.from('x'));
  });

  it('get 不存在 → BizError NOT_FOUND', async () => {
    await expect(storage.get('202610/missing.txt')).rejects.toBeInstanceOf(BizError);
  });

  it('delete 幂等：存在删除、不存在不报错', async () => {
    await storage.put('202610/gone.txt', Buffer.from('gone'));
    await expect(storage.delete('202610/gone.txt')).resolves.toBeUndefined();
    await expect(storage.delete('202610/gone.txt')).resolves.toBeUndefined();
    await expect(storage.exists('202610/gone.txt')).resolves.toBe(false);
  });

  it('exists / stat：存在与不存在两态', async () => {
    await storage.put('202610/meta.bin', Buffer.alloc(7));
    await expect(storage.exists('202610/meta.bin')).resolves.toBe(true);
    await expect(storage.stat('202610/meta.bin')).resolves.toMatchObject({ key: '202610/meta.bin', size: 7 });
    await expect(storage.exists('202610/nope.bin')).resolves.toBe(false);
    await expect(storage.stat('202610/nope.bin')).resolves.toBeNull();
  });

  it('ping：根目录可建即 true', async () => {
    await expect(storage.ping()).resolves.toBe(true);
  });

  it('非法 key 一律拒绝（穿越 / 绝对路径 / 反斜杠 / 空段 / 非法字符）', async () => {
    await expect(storage.put('../escape.txt', Buffer.from('x'))).rejects.toThrow(/非法存储 key/);
    await expect(storage.get('/abs.txt')).rejects.toThrow(/非法存储 key/);
    await expect(storage.delete('a\\b.txt')).rejects.toThrow(/非法存储 key/);
    await expect(storage.stat('a//b.txt')).rejects.toThrow(/非法存储 key/);
    await expect(storage.exists('a/..%2Fb.txt')).resolves.toBe(false);
    await expect(storage.put('a/<bad>.txt', Buffer.from('x'))).rejects.toThrow(/非法存储 key/);
  });

  it('resolve 后必须落在根内（最终防线）', async () => {
    // 单段字符合法但组合越界：利用 Windows 盘符/特殊构造不可达时也应被 resolve 防线拦下
    const storage2 = new LocalStorage(path.join(root, 'sub'));
    await expect(storage2.put('..%2F..%2Fx.txt', Buffer.from('x'))).rejects.toThrow();
  });

  it('close 为空操作', async () => {
    await expect(storage.close()).resolves.toBeUndefined();
  });

  it('openStream 返回可读流（local 便利能力）', async () => {
    await storage.put('202610/stream.txt', Buffer.from('streaming'));
    const chunks: Buffer[] = [];
    for await (const chunk of storage.openStream('202610/stream.txt')) {
      chunks.push(Buffer.from(chunk as Uint8Array));
    }
    expect(Buffer.concat(chunks).toString()).toBe('streaming');
  });
});
