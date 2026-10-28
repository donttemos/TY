/*
 * @file 生成物漂移检测单测（PRD-017 FR-17-14）
 * @description 锁死「不悄悄覆盖用户代码」的判断依据：指纹一致才算未改动；
 *   文件被删算 missing；老清单没有指纹一律 untracked，绝不推断成安全。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkArtifactDrift, hashContent, hashFile, mergeArtifactHashes, type GenManifestEntry } from '../manifest.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-drift-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 造条目 */
const entry = (model: string, files?: { path: string; hash: string }[]): GenManifestEntry => ({
  model,
  kebab: model.toLowerCase(),
  modulePath: `src/modules/${model.toLowerCase()}/${model.toLowerCase()}.module.ts`,
  moduleClass: `${model}Module`,
  seedPath: `prisma/seed/${model.toLowerCase()}.seed.ts`,
  seedExport: `seed${model}Permissions`,
  permissionCodes: [`${model.toLowerCase()}:read`],
  updatedAt: '2026-10-22',
  ...(files ? { files } : {}),
});

/** 写文件并返回指纹 */
const write = (relPath: string, content: string): string => {
  const absolute = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
  return hashContent(content);
};

describe('hash 工具', () => {
  it('同内容同指纹，不同内容不同指纹', () => {
    expect(hashContent('a')).toBe(hashContent('a'));
    expect(hashContent('a')).not.toBe(hashContent('b'));
  });

  it('hashFile 对不存在的文件返回 null', () => {
    expect(hashFile(path.join(tmpDir, 'nope.ts'))).toBeNull();
  });
});

describe('mergeArtifactHashes', () => {
  it('只替换本次写过的路径，未触碰的产物沿用旧指纹', () => {
    const merged = mergeArtifactHashes(
      [
        { path: 'src/modules/order/order.service.ts', hash: 'old-service' },
        { path: 'src/views/order/index.vue', hash: 'old-view' },
      ],
      [{ path: 'src/views/order/index.vue', hash: 'new-view' }],
    );
    expect(merged).toEqual([
      { path: 'src/modules/order/order.service.ts', hash: 'old-service' },
      { path: 'src/views/order/index.vue', hash: 'new-view' },
    ]);
  });

  it('老清单没有指纹时直接采用本次结果（不产生 undefined）', () => {
    const merged = mergeArtifactHashes(undefined, [{ path: 'src/api/order.ts', hash: 'h1' }]);
    expect(merged).toEqual([{ path: 'src/api/order.ts', hash: 'h1' }]);
  });

  it('按路径排序，保证清单 diff 稳定', () => {
    const merged = mergeArtifactHashes(
      [
        { path: 'src/b.ts', hash: 'b' },
        { path: 'src/a.ts', hash: 'a' },
      ],
      [],
    );
    expect(merged.map((item) => item.path)).toEqual(['src/a.ts', 'src/b.ts']);
  });
});

describe('checkArtifactDrift', () => {
  it('指纹一致 → unchanged（用户没改过）', () => {
    const hash = write('src/modules/product/product.service.ts', 'export class S {}');
    const [drift] = checkArtifactDrift(tmpDir, [
      entry('Product', [{ path: 'src/modules/product/product.service.ts', hash }]),
    ]);
    expect(drift.files[0].status).toBe('unchanged');
    expect(drift.affected).toBe(0);
  });

  it('内容变了 → modified（重新生成会跳过它，不会覆盖）', () => {
    write('src/modules/product/product.service.ts', 'export class S {}');
    const [drift] = checkArtifactDrift(tmpDir, [
      entry('Product', [{ path: 'src/modules/product/product.service.ts', hash: 'stale' }]),
    ]);
    expect(drift.files[0].status).toBe('modified');
    expect(drift.affected).toBe(1);
  });

  it('文件被删 → missing', () => {
    const [drift] = checkArtifactDrift(tmpDir, [
      entry('Product', [{ path: 'src/modules/product/gone.ts', hash: 'whatever' }]),
    ]);
    expect(drift.files[0].status).toBe('missing');
    expect(drift.affected).toBe(1);
  });

  it('老清单没有指纹 → 不产生条目，也绝不标记为未改动', () => {
    const [drift] = checkArtifactDrift(tmpDir, [entry('Product')]);
    expect(drift.files).toEqual([]);
    expect(drift.affected).toBe(0);
    expect(drift.files.some((file) => file.status === 'untracked')).toBe(false);
  });

  it('多模型各自独立统计', () => {
    const productHash = write('src/modules/product/a.ts', 'A');
    write('src/modules/category/b.ts', 'B-changed');
    const drifts = checkArtifactDrift(tmpDir, [
      entry('Product', [{ path: 'src/modules/product/a.ts', hash: productHash }]),
      entry('Category', [{ path: 'src/modules/category/b.ts', hash: 'old' }]),
    ]);
    expect(drifts.find((item) => item.model === 'Product')?.affected).toBe(0);
    expect(drifts.find((item) => item.model === 'Category')?.affected).toBe(1);
  });
});
