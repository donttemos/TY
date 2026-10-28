/*
 * @file 自动接线单测（PRD-016 FR-16-02/FR-16-03）
 * @description 覆盖：模块 import / imports 数组项 / 种子 import 与调用 / 权限码四类块的整块重建、
 *   清单合并的幂等与排序、删除残留（条目减少时块内容随之收缩）、以及接线目标缺失时的明确报错。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEntry, readManifest, upsertEntries, writeManifest, type GenManifest } from '../manifest.js';
import type { AppLayout } from '../render.js';
import { buildWiringPlan } from '../wiring.js';

let tmpDir: string;

/** app.module.ts 夹具（标记块与仓库中的真实文件同构） */
const APP_MODULE = [
  "import { Module } from '@nestjs/common';",
  '// <fw:gen:imports>',
  '// </fw:gen:imports>',
  '',
  '@Module({',
  '  imports: [',
  '    // <fw:gen:modules>',
  '    // </fw:gen:modules>',
  '  ],',
  '})',
  'export class AppModule {}',
].join('\n');

/** prisma/seed.ts 夹具 */
const SEED_FILE = [
  "import { PrismaClient } from '@prisma/client';",
  '// <fw:gen:seed-imports>',
  '// </fw:gen:seed-imports>',
  '',
  'const GENERATED_PERMISSION_CODES: string[] = [',
  '  // <fw:gen:perm-codes>',
  '  // </fw:gen:perm-codes>',
  '];',
  '',
  'async function main() {',
  '  // <fw:gen:seed-calls>',
  '  // </fw:gen:seed-calls>',
  '}',
].join('\n');

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-gen-wiring-'));
  fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'prisma', 'seed'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'app.module.ts'), APP_MODULE, 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'seed.ts'), SEED_FILE, 'utf8');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const layout = (): AppLayout => ({
  backendRoot: tmpDir,
  backendModulesDir: path.join(tmpDir, 'src', 'modules'),
  webRoot: tmpDir,
  schemaFile: path.join(tmpDir, 'prisma', 'schema.prisma'),
});

const entry = (model: string) =>
  makeEntry({
    model,
    kebab: model.toLowerCase(),
    modulePath: `src/modules/${model.toLowerCase()}/${model.toLowerCase()}.module.ts`,
    seedPath: `prisma/seed/${model.toLowerCase()}.seed.ts`,
    updatedAt: '2026-10-22',
  });

describe('buildWiringPlan', () => {
  it('app.module.ts 同时重建 import 与 imports 数组项', () => {
    const result = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    expect(result.plan).toHaveLength(1);
    const content = result.plan[0].content;
    expect(result.plan[0].mode).toBe('patch');
    expect(result.plan[0].path).toBe('src/app.module.ts');
    expect(content).toContain("import { ProductModule } from './modules/product/product.module.js';");
    expect(content).toContain('    ProductModule,');
    expect(content).not.toContain('OrderModule');
  });

  it('seed.ts 同时重建 import / 调用 / 权限码三块', () => {
    const result = buildWiringPlan(layout(), [entry('Product')], { backend: false, seed: true }, tmpDir);
    expect(result.plan).toHaveLength(1);
    const content = result.plan[0].content;
    expect(result.plan[0].path).toBe('prisma/seed.ts');
    expect(content).toContain("import { seedProductPermissions } from './seed/product.seed.js';");
    expect(content).toContain('  await seedProductPermissions();');
    expect(content).toContain("  'product:create',");
    expect(content).toContain("  'product:delete',");
  });

  it('多条目按 model 排序，输出稳定（重跑逐字节相同）', () => {
    const entries = [entry('Product'), entry('Category')];
    const first = buildWiringPlan(layout(), entries, { backend: true, seed: true }, tmpDir);
    const second = buildWiringPlan(layout(), [...entries].reverse(), { backend: true, seed: true }, tmpDir);
    expect(first.plan.map((f) => f.content)).toEqual(second.plan.map((f) => f.content));
    const appModule = first.plan[0].content;
    expect(appModule.indexOf('CategoryModule')).toBeLessThan(appModule.indexOf('ProductModule'));
  });

  it('条目减少时块内残留被清掉（全量重建，不是增量插入）', () => {
    const withTwo = buildWiringPlan(layout(), [entry('Product'), entry('Category')], { backend: true, seed: false }, tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.module.ts'), withTwo.plan[0].content, 'utf8');
    const withOne = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    expect(withOne.plan[0].content).not.toContain('CategoryModule');
    expect(withOne.plan[0].content).toContain('ProductModule');
  });

  it('内容无变化时不产出计划（避免无意义写入）', () => {
    const first = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.module.ts'), first.plan[0].content, 'utf8');
    const again = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    expect(again.plan).toHaveLength(0);
  });

  it('空清单会把块清空（清场后可重来）', () => {
    const seeded = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.module.ts'), seeded.plan[0].content, 'utf8');
    const cleared = buildWiringPlan(layout(), [], { backend: true, seed: false }, tmpDir);
    expect(cleared.plan[0].content).not.toContain('ProductModule');
  });

  it('目标文件缺失时降级为不接线并告警（不阻断生成）', () => {
    fs.rmSync(path.join(tmpDir, 'src', 'app.module.ts'));
    const result = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    expect(result.plan).toHaveLength(0);
    expect(result.warnings.join('\n')).toMatch(/app\.module\.ts 不存在，本次未自动接线/);
  });

  it('缺少标记块时降级为不接线并指明缺哪个块（不猜测位置）', () => {
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.module.ts'), "import { Module } from '@nestjs/common';", 'utf8');
    const result = buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir);
    expect(result.plan).toHaveLength(0);
    expect(result.warnings.join('\n')).toMatch(/缺少标记块 .*fw:gen:imports/);
    expect(result.warnings.join('\n')).toMatch(/补上成对标记后重跑/);
  });

  it('标记块重复时仍然报错（结构歧义不降级）', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'src', 'app.module.ts'),
      `${APP_MODULE}\n// <fw:gen:imports>\n// </fw:gen:imports>`,
      'utf8',
    );
    expect(() => buildWiringPlan(layout(), [entry('Product')], { backend: true, seed: false }, tmpDir)).toThrow(
      /重复出现/,
    );
  });
});

describe('清单读写', () => {
  it('不存在时返回空清单', () => {
    expect(readManifest(tmpDir).entries).toEqual([]);
  });

  it('写入后按 model 排序，可被读回', () => {
    const manifest: GenManifest = { version: 1, entries: [entry('Product'), entry('Category')] };
    writeManifest(tmpDir, manifest);
    const read = readManifest(tmpDir);
    expect(read.entries.map((e) => e.model)).toEqual(['Category', 'Product']);
    expect(read.entries[0].permissionCodes).toEqual([
      'category:create',
      'category:read',
      'category:update',
      'category:delete',
    ]);
  });

  it('upsert 同 model 覆盖、不同 model 追加', () => {
    const merged = upsertEntries({ version: 1, entries: [entry('Product')] }, [entry('Product'), entry('Order')]);
    expect(merged.entries.map((e) => e.model)).toEqual(['Order', 'Product']);
  });

  it('非法 JSON 与版本不符时给出可操作报错', () => {
    fs.writeFileSync(path.join(tmpDir, 'fw.gen.json'), '{oops', 'utf8');
    expect(() => readManifest(tmpDir)).toThrow(/不是合法 JSON/);
    fs.writeFileSync(path.join(tmpDir, 'fw.gen.json'), '{"version":2,"entries":[]}', 'utf8');
    expect(() => readManifest(tmpDir)).toThrow(/版本不支持/);
  });
});
