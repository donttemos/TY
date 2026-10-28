/*
 * @file fw review 编排单测（PRD-017 FR-17-23）
 * @description 不联网验证编排：素材来自清单、dry-run 不调用模型、未知模型/无清单/产物缺失
 *   都给出可照做的报错；正常路径打印结论并把文件内容交给模型。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runReview } from '../review.js';
import type { AiConfig } from '../config.js';

let tmpDir: string;

const config: AiConfig = { baseUrl: 'https://ai.local/v1', apiKey: 'sk-test', model: 'review-model' };

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-review-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写清单 + 产物 */
function seedProject(options: { withManifest?: boolean; withFile?: boolean } = {}): void {
  const { withManifest = true, withFile = true } = options;
  const service = path.join(tmpDir, 'src/modules/order/order.service.ts');
  fs.mkdirSync(path.dirname(service), { recursive: true });
  if (withFile) fs.writeFileSync(service, 'export class OrderService {}', 'utf8');
  if (withManifest) {
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Order',
            kebab: 'order',
            modulePath: 'src/modules/order/order.module.ts',
            moduleClass: 'OrderModule',
            seedPath: 'prisma/seed/order.seed.ts',
            seedExport: 'seedOrderPermissions',
            permissionCodes: ['order:read'],
            updatedAt: '2026-10-22',
            files: [{ path: 'src/modules/order/order.service.ts', hash: 'h' }],
          },
        ],
      }),
      'utf8',
    );
  }
}

/** 收集日志的 IO */
function makeIo() {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m: string) => logs.push(m), error: (m: string) => errors.push(m) }, logs, errors };
}

describe('runReview', () => {
  it('收集清单产物、调用模型并打印结论', async () => {
    seedProject();
    const { io, logs } = makeIo();
    let sentBody = '';
    const fetchImpl = (async (_url: string, init: RequestInit) => {
      sentBody = String(init.body);
      return new Response(JSON.stringify({ choices: [{ message: { content: '[P1] a.ts:3 — 缺校验 → 补 DTO' } }] }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const outcome = await runReview({}, { io, config, fetchImpl });

    expect(outcome.content).toContain('[P1]');
    expect(outcome.collected.files.map((file) => file.path)).toEqual(['src/modules/order/order.service.ts']);
    expect(sentBody).toContain('OrderService');
    const output = logs.join('\n');
    expect(output).toContain('待审 1 个文件');
    expect(output).toContain('代码将发送到');
    expect(output).toContain('审查结果');
  });

  it('体积超预算时分片调用并合并结论', async () => {
    // 三个各 2KB 的文件，预算 1KB → 每个文件一片
    const paths = ['src/modules/tag/tag.service.ts', 'src/modules/tag/tag.controller.ts', 'src/modules/tag/tag.module.ts'];
    for (const rel of paths) {
      const absolute = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      // 每个约 3KB：两个能装进 8KB 预算、三个装不下 → 正好两片，且不触发按行切段
      fs.writeFileSync(absolute, `// ${rel}\n${'x'.repeat(3000)}`, 'utf8');
    }
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Tag', kebab: 'tag', modulePath: paths[2], moduleClass: 'TagModule',
            seedPath: 'prisma/seed/tag.seed.ts', seedExport: 'seedTagPermissions',
            permissionCodes: ['tag:read'], updatedAt: '2026-10-27',
            files: paths.map((item) => ({ path: item, hash: 'h' })),
          },
        ],
      }),
      'utf8',
    );

    const { io, logs } = makeIo();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: `结论 ${calls}` } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await runReview({ chunkBytes: 8192 }, { io, config, fetchImpl });

    expect(calls).toBe(2);
    expect(outcome.content).toContain('## 分片 1/2');
    expect(outcome.content).toContain('结论 1');
    expect(outcome.content).toContain('## 分片 2/2');
    expect(logs.join('\n')).toContain('分 2 片执行');
  });

  it('跨片重复的同一问题在汇总里只出现一次', async () => {
    const paths = ['src/modules/tag/a.ts', 'src/modules/tag/b.ts'];
    for (const rel of paths) {
      const absolute = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `// ${rel}\n${'q'.repeat(3000)}`, 'utf8');
    }
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Tag', kebab: 'tag', modulePath: paths[0], moduleClass: 'TagModule',
            seedPath: 'prisma/seed/tag.seed.ts', seedExport: 'seedTagPermissions',
            permissionCodes: ['tag:read'], updatedAt: '2026-10-27',
            files: paths.map((item) => ({ path: item, hash: 'h' })),
          },
        ],
      }),
      'utf8',
    );

    const { io, logs } = makeIo();
    // 两次调用返回同一问题：模拟不同分片重复报同一处
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ choices: [{ message: { content: '[P1] a.ts:1 缺少校验 → 补 DTO' } }] }),
        { status: 200 },
      )) as unknown as typeof fetch;

    await runReview({ chunkBytes: 4096 }, { io, config, fetchImpl });
    const output = logs.join('\n');
    expect(output).toContain('合并重复 1 条');
    expect(output.match(/a\.ts:1 — 缺少校验/g)).toHaveLength(1);
  });

  it('split=model：按模型分组，结论标题带模型名', async () => {
    const seed = [
      { model: 'Tag', kebab: 'tag', file: 'src/modules/tag/tag.service.ts' },
      { model: 'Product', kebab: 'product', file: 'src/modules/product/product.service.ts' },
    ];
    for (const item of seed) {
      const absolute = path.join(tmpDir, item.file);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `// ${item.model}\nexport const x = 1;`, 'utf8');
    }
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: seed.map((item) => ({
          model: item.model, kebab: item.kebab, modulePath: item.file, moduleClass: `${item.model}Module`,
          seedPath: `prisma/seed/${item.kebab}.seed.ts`, seedExport: `seed${item.model}Permissions`,
          permissionCodes: [`${item.kebab}:read`], updatedAt: '2026-10-27',
          files: [{ path: item.file, hash: 'h' }],
        })),
      }),
      'utf8',
    );

    const { io, logs } = makeIo();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: `结论 ${calls}` } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await runReview({ split: 'model' }, { io, config, fetchImpl });
    expect(calls).toBe(2);
    expect(outcome.content).toContain('分片 1/2 · Tag');
    expect(outcome.content).toContain('分片 2/2 · Product');
    expect(logs.join('\n')).toContain('按模型分组');
  });

  it('per-file 模式逐文件调用（3 个文件 → 3 次）', async () => {
    const paths = ['src/modules/tag/a.ts', 'src/modules/tag/b.ts', 'src/modules/tag/c.ts'];
    for (const rel of paths) {
      const absolute = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `// ${rel}\nexport const x = 1;`, 'utf8');
    }
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Tag', kebab: 'tag', modulePath: paths[0], moduleClass: 'TagModule',
            seedPath: 'prisma/seed/tag.seed.ts', seedExport: 'seedTagPermissions',
            permissionCodes: ['tag:read'], updatedAt: '2026-10-27',
            files: paths.map((item) => ({ path: item, hash: 'h' })),
          },
        ],
      }),
      'utf8',
    );

    const { io, logs } = makeIo();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      return new Response(JSON.stringify({ choices: [{ message: { content: `逐文件结论 ${calls}` } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await runReview({ perFile: true }, { io, config, fetchImpl });
    expect(calls).toBe(3);
    expect(outcome.content).toContain('逐文件结论 3');
    expect(logs.join('\n')).toContain('逐文件发送：共 3 次调用');
  });

  it('单片失败不影响其余分片的结论', async () => {
    const paths = ['src/modules/tag/a.ts', 'src/modules/tag/b.ts'];
    for (const rel of paths) {
      const absolute = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `// ${rel}\n${'y'.repeat(3000)}`, 'utf8');
    }
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Tag', kebab: 'tag', modulePath: paths[0], moduleClass: 'TagModule',
            seedPath: 'prisma/seed/tag.seed.ts', seedExport: 'seedTagPermissions',
            permissionCodes: ['tag:read'], updatedAt: '2026-10-27',
            files: paths.map((item) => ({ path: item, hash: 'h' })),
          },
        ],
      }),
      'utf8',
    );

    const { io, logs } = makeIo();
    let calls = 0;
    const fetchImpl = (async () => {
      calls += 1;
      if (calls === 1) throw new Error('分片超时');
      return new Response(JSON.stringify({ choices: [{ message: { content: '其余分片结论' } }] }), { status: 200 });
    }) as unknown as typeof fetch;

    const outcome = await runReview({ chunkBytes: 4096 }, { io, config, fetchImpl });
    expect(outcome.content).toContain('其余分片结论');
    expect(logs.join('\n')).toContain('个分片失败');
  });

  it('dry-run 展示真实分片与超大文件切段', async () => {
    // 3 个小文件 + 1 个 40KB 文件：预演必须显示分片，而不是笼统列 4 个文件
    const small = ['src/modules/tag/a.ts', 'src/modules/tag/b.ts', 'src/modules/tag/c.ts'];
    for (const rel of small) {
      const absolute = path.join(tmpDir, rel);
      fs.mkdirSync(path.dirname(absolute), { recursive: true });
      fs.writeFileSync(absolute, `// ${rel}\n${'z'.repeat(3000)}`, 'utf8');
    }
    const big = 'prisma/seed.ts';
    fs.mkdirSync(path.dirname(path.join(tmpDir, big)), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, big), '// seed\n'.repeat(2000), 'utf8');
    fs.writeFileSync(
      path.join(tmpDir, 'fw.gen.json'),
      JSON.stringify({
        version: 1,
        entries: [
          {
            model: 'Tag', kebab: 'tag', modulePath: small[0], moduleClass: 'TagModule',
            seedPath: big, seedExport: 'seedTagPermissions',
            permissionCodes: ['tag:read'], updatedAt: '2026-10-27',
            files: [...small, big].map((item) => ({ path: item, hash: 'h' })),
          },
        ],
      }),
      'utf8',
    );

    const { io, logs } = makeIo();
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const outcome = await runReview({ dry: true, chunkBytes: 8192 }, { io, config, fetchImpl });

    expect(outcome.content).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled();
    const output = logs.join('\n');
    expect(output).toContain('将分');
    expect(output).toContain('单片预算 8KB');
    expect(output).toMatch(/prisma\/seed\.ts（第 1-\d+ 行 \/ 共 \d+ 行）/);
  });

  it('dry-run 不联网但仍列出将发送的文件', async () => {
    seedProject();
    const { io, logs } = makeIo();
    const fetchImpl = vi.fn() as unknown as typeof fetch;

    const outcome = await runReview({ dry: true }, { io, config, fetchImpl });

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(outcome.content).toBeNull();
    expect(logs.join('\n')).toContain('dry-run：未联网');
    expect(logs.join('\n')).toContain('order.service.ts');
  });

  it('指定不存在的模型时报错并列出可用模型', async () => {
    seedProject();
    await expect(runReview({ models: ['Nope'] }, { config })).rejects.toThrow(/Order/);
  });

  it('没有清单时明确要求先生成', async () => {
    seedProject({ withManifest: false });
    await expect(runReview({}, { config })).rejects.toThrow(/fw gen crud/);
  });

  it('清单有记录但产物全缺失时给出具体原因', async () => {
    seedProject({ withFile: false });
    await expect(runReview({}, { config })).rejects.toThrow(/没有可审查的文件[\s\S]*文件不存在/);
  });

  it('缺少密钥时在联网前失败（dry-run 不需要密钥）', async () => {
    seedProject();
    await expect(runReview({}, { env: {} })).rejects.toThrow(/FW_AI_API_KEY/);
    const dry = await runReview({ dry: true }, { env: {}, io: makeIo().io });
    expect(dry.content).toBeNull();
  });
});
