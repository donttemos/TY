/*
 * @file 审查素材收集单测（PRD-017 FR-17-23）
 * @description 锁死边界：只收清单产物 + 两个接线文件；缺文件/超大/超量都要「跳过并说原因」，
 *   绝不截断半截代码——模型看到半截文件会给出错误结论，比不审更糟。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { GenManifestEntry } from '../../gen/manifest.js';
import { collectReviewFiles, DEFAULT_LIMITS, fallbackArtifactPaths, selectEntries } from '../collect.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-review-collect-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写文件（自动建目录） */
const write = (relPath: string, content: string): void => {
  const absolute = path.join(tmpDir, relPath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, content, 'utf8');
};

/** 造清单条目 */
const entry = (model: string, files: string[]): GenManifestEntry => ({
  model,
  kebab: model.toLowerCase(),
  modulePath: `src/modules/${model.toLowerCase()}/${model.toLowerCase()}.module.ts`,
  moduleClass: `${model}Module`,
  seedPath: `prisma/seed/${model.toLowerCase()}.seed.ts`,
  seedExport: `seed${model}Permissions`,
  permissionCodes: [`${model.toLowerCase()}:read`],
  updatedAt: '2026-10-22',
  files: files.map((file) => ({ path: file, hash: 'h' })),
});

describe('selectEntries', () => {
  it('省略模型 = 全部；kebab 与大小写都能命中', () => {
    const entries = [entry('Product', []), entry('OrderItem', [])];
    expect(selectEntries(entries)).toHaveLength(2);
    expect(selectEntries(entries, ['product'])[0].model).toBe('Product');
    expect(selectEntries(entries, ['orderitem'])[0].model).toBe('OrderItem');
    expect(selectEntries(entries, ['OrderItem', 'Product'])).toHaveLength(2);
  });

  it('指定不存在的模型时报错并列出可用模型', () => {
    expect(() => selectEntries([entry('Product', [])], ['Nope'])).toThrow(/Product/);
  });
});

describe('collectReviewFiles', () => {
  it('收集清单产物与两个接线文件，顺序确定', () => {
    write('src/modules/product/product.service.ts', 'export class S {}');
    write('src/app.module.ts', '// module');
    write('prisma/seed.ts', '// seed');
    const result = collectReviewFiles({
      backendRoot: tmpDir,
      entries: [entry('Product', ['src/modules/product/product.service.ts'])],
    });
    expect(result.files.map((file) => file.path)).toEqual([
      'src/modules/product/product.service.ts',
      'src/app.module.ts',
      'prisma/seed.ts',
    ]);
    expect(result.models).toEqual(['Product']);
    expect(result.skipped).toEqual([]);
  });

  it('文件不存在时跳过并说明原因，不中断整次收集', () => {
    write('src/app.module.ts', '// module');
    const result = collectReviewFiles({
      backendRoot: tmpDir,
      entries: [entry('Product', ['src/modules/product/gone.ts'])],
    });
    expect(result.files.map((file) => file.path)).toEqual(['src/app.module.ts']);
    expect(result.skipped[0]).toMatchObject({ path: 'src/modules/product/gone.ts', reason: '文件不存在' });
  });

  it('单文件超限跳过而不是截断', () => {
    write('src/modules/product/product.service.ts', 'x'.repeat(2048));
    const result = collectReviewFiles({
      backendRoot: tmpDir,
      entries: [entry('Product', ['src/modules/product/product.service.ts'])],
      maxBytesPerFile: 1024,
    });
    expect(result.files).toEqual([]);
    expect(result.skipped[0].reason).toMatch(/超过上限/);
  });

  it('文件数与总量上限都生效', () => {
    write('a.ts', 'aaa');
    write('b.ts', 'bbb');
    const limitedByCount = collectReviewFiles({
      backendRoot: tmpDir,
      entries: [entry('Product', ['a.ts', 'b.ts'])],
      maxFiles: 1,
    });
    expect(limitedByCount.files).toHaveLength(1);
    expect(limitedByCount.skipped[0].reason).toMatch(/文件数超过上限/);

    const limitedByBytes = collectReviewFiles({
      backendRoot: tmpDir,
      entries: [entry('Product', ['a.ts', 'b.ts'])],
      maxTotalBytes: 4,
    });
    expect(limitedByBytes.files).toHaveLength(1);
    expect(limitedByBytes.skipped[0].reason).toMatch(/总量超过上限/);
  });

  it('多个条目共用同一路径时只收一次', () => {
    write('shared.ts', 'shared');
    const result = collectReviewFiles({
      backendRoot: tmpDir,
      entries: [entry('Product', ['shared.ts']), entry('Category', ['shared.ts'])],
    });
    expect(result.files.filter((file) => file.path === 'shared.ts')).toHaveLength(1);
  });

  it('默认上限覆盖常见的生成物规模', () => {
    expect(DEFAULT_LIMITS.maxFiles).toBeGreaterThanOrEqual(20);
    expect(DEFAULT_LIMITS.maxTotalBytes).toBeGreaterThan(DEFAULT_LIMITS.maxBytesPerFile);
  });

  it('没有指纹的老清单按生成器约定回退到后端六文件 + 种子', () => {
    write('src/modules/product/product.entity.ts', 'entity');
    write('src/modules/product/product.service.ts', 'service');
    write('prisma/seed/product.seed.ts', 'seed');
    const oldEntry: GenManifestEntry = {
      model: 'Product',
      kebab: 'product',
      modulePath: 'src/modules/product/product.module.ts',
      moduleClass: 'ProductModule',
      seedPath: 'prisma/seed/product.seed.ts',
      seedExport: 'seedProductPermissions',
      permissionCodes: ['product:read'],
      updatedAt: '2026-10-20',
    };
    expect(fallbackArtifactPaths(oldEntry)).toEqual([
      'src/modules/product/product.entity.ts',
      'src/modules/product/product.repository.ts',
      'src/modules/product/product.dto.ts',
      'src/modules/product/product.service.ts',
      'src/modules/product/product.controller.ts',
      'src/modules/product/product.module.ts',
      'prisma/seed/product.seed.ts',
    ]);

    const result = collectReviewFiles({ backendRoot: tmpDir, entries: [oldEntry] });
    expect(result.files.map((file) => file.path)).toEqual([
      'src/modules/product/product.entity.ts',
      'src/modules/product/product.service.ts',
      'prisma/seed/product.seed.ts',
    ]);
    expect(result.skipped.map((item) => item.path)).toContain('src/modules/product/product.dto.ts');
  });
});
