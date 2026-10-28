/*
 * @file 生成后处理单测（PRD-016 FR-16-05 / FR-16-06）
 * @description 用假执行器覆盖：阶段顺序（生成 → 校验 → 迁移 → 种子）、破坏性迁移的确认与阻断、
 *   确认回调拒绝、校验失败阶段标记、无结构变更时跳过、以及定向种子只跑本次模型。
 *   不连数据库、不跑真实 tsc：执行器按命令内容模拟 prisma 建迁移目录的行为。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostGenError, runPostGen, type Executor, type PostGenOptions } from '../post-gen.js';

let tmpDir: string;
let migrationsDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-post-gen-'));
  fs.mkdirSync(path.join(tmpDir, 'prisma', 'seed'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'prisma', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), 'model Order { id String @id }\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'seed', 'order.seed.ts'), 'export {};\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), '{}', 'utf8');
  migrationsDir = path.join(tmpDir, 'prisma', 'migrations');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 假执行器：记录调用，并在 migrate dev --create-only 时按需写入迁移目录 */
function makeExec(options: { sql?: string | null; failOn?: string }): { exec: Executor; calls: string[] } {
  const calls: string[] = [];
  const exec: Executor = async (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    if (options.failOn && line.includes(options.failOn)) throw new Error(`${options.failOn} 失败：模拟错误`);
    if (line.includes('migrate dev') && line.includes('--create-only') && options.sql !== null) {
      const dir = path.join(migrationsDir, '20261022_fw_gen_order');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'migration.sql'), options.sql ?? 'CREATE TABLE "Order" ("id" TEXT);', 'utf8');
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/** 默认选项 */
function makeOptions(overrides: Partial<PostGenOptions> = {}): PostGenOptions {
  return {
    backendRoot: tmpDir,
    schemaFile: path.join(tmpDir, 'prisma', 'schema.prisma'),
    models: ['order'],
    migrate: true,
    seed: true,
    verify: 'none',
    io: { log: () => undefined, error: () => undefined },
    ...overrides,
  };
}

describe('runPostGen 阶段顺序', () => {
  it('先生成类型再校验，最后才迁移与种子', async () => {
    const { exec, calls } = makeExec({ sql: 'CREATE TABLE "Order" ("id" TEXT);' });
    const result = await runPostGen(makeOptions({ verify: 'fast', exec }));
    expect(calls[0]).toContain('prisma generate');
    expect(calls[1]).toContain('tsc -p tsconfig.json --noEmit');
    expect(calls[2]).toContain('migrate dev --create-only');
    expect(calls[3]).toContain('migrate deploy');
    expect(calls[4]).toContain('tsx prisma/seed/order.seed.ts');
    expect(result.migration.applied).toBe(true);
    expect(result.seeded).toEqual(['order']);
    expect(result.verified).toEqual(['backend']);
  });

  it('无结构变更时不产生迁移也不应用', async () => {
    const { exec, calls } = makeExec({ sql: null });
    const result = await runPostGen(makeOptions({ exec }));
    expect(result.migration.name).toBeNull();
    expect(result.migration.applied).toBe(false);
    expect(calls.some((line) => line.includes('migrate deploy'))).toBe(false);
  });

  it('--no-migrate 与 --no-seed 可分别关闭阶段', async () => {
    const { exec, calls } = makeExec({ sql: 'CREATE TABLE "Order" ("id" TEXT);' });
    const result = await runPostGen(makeOptions({ migrate: false, seed: false, exec }));
    expect(result.seeded).toEqual([]);
    expect(calls.some((line) => line.includes('migrate'))).toBe(false);
  });

  it('无种子文件时告警但不失败', async () => {
    fs.rmSync(path.join(tmpDir, 'prisma', 'seed', 'order.seed.ts'));
    const { exec } = makeExec({ sql: null });
    const result = await runPostGen(makeOptions({ exec }));
    expect(result.seeded).toEqual([]);
  });
});

describe('runPostGen 迁移风险闸门', () => {
  it('破坏性迁移默认阻断，且不应用', async () => {
    const { exec, calls } = makeExec({ sql: 'DROP TABLE "Order";' });
    await expect(runPostGen(makeOptions({ exec }))).rejects.toThrow(/迁移未执行.*--allow-destructive/s);
    expect(calls.some((line) => line.includes('migrate deploy'))).toBe(false);
    // 迁移文件保留，便于人工审查
    expect(fs.existsSync(path.join(migrationsDir, '20261022_fw_gen_order', 'migration.sql'))).toBe(true);
  });

  it('--allow-destructive 放行并可应用', async () => {
    const { exec, calls } = makeExec({ sql: 'DROP TABLE "Order";' });
    const result = await runPostGen(makeOptions({ allowDestructive: true, exec }));
    expect(result.migration.applied).toBe(true);
    expect(calls.some((line) => line.includes('migrate deploy'))).toBe(true);
  });

  it('确认回调拒绝时中止（非 TTY 的默认行为）', async () => {
    const { exec } = makeExec({ sql: 'DROP TABLE "Order";' });
    const result = runPostGen(makeOptions({ confirmDestructive: async () => false, exec }));
    await expect(result).rejects.toThrow(/迁移未执行/);
  });

  it('确认回调同意时继续执行', async () => {
    const { exec } = makeExec({ sql: 'DROP TABLE "Order";' });
    let asked = 0;
    const result = await runPostGen(
      makeOptions({
        confirmDestructive: async () => {
          asked += 1;
          return true;
        },
        exec,
      }),
    );
    expect(asked).toBe(1);
    expect(result.migration.applied).toBe(true);
  });

  it('需确认级（重命名）也要走确认，不能被当成安全迁移', async () => {
    const { exec } = makeExec({ sql: 'ALTER TABLE "Order" RENAME COLUMN "code" TO "sn";' });
    await expect(runPostGen(makeOptions({ exec }))).rejects.toThrow(/迁移需确认/);
  });
});

describe('runPostGen 失败阶段标记', () => {
  it('类型校验失败标记为 verify（调用方据此回滚文件）', async () => {
    const { exec } = makeExec({ sql: null, failOn: 'tsc' });
    const error = await runPostGen(makeOptions({ verify: 'fast', exec })).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(PostGenError);
    expect((error as PostGenError).stage).toBe('verify');
  });

  it('生成类型失败标记为 generate', async () => {
    const { exec } = makeExec({ sql: null, failOn: 'prisma generate' });
    const error = await runPostGen(makeOptions({ exec })).catch((caught: unknown) => caught);
    expect((error as PostGenError).stage).toBe('generate');
  });

  it('应用迁移失败标记为 migrate，并提示可重试命令', async () => {
    const { exec } = makeExec({ sql: 'CREATE TABLE "Order" ("id" TEXT);', failOn: 'migrate deploy' });
    const error = await runPostGen(makeOptions({ exec })).catch((caught: unknown) => caught);
    expect((error as PostGenError).stage).toBe('migrate');
    expect((error as PostGenError).message).toContain('fw db:migrate');
  });

  it('种子失败标记为 seed', async () => {
    const { exec } = makeExec({ sql: null, failOn: 'tsx' });
    const error = await runPostGen(makeOptions({ exec })).catch((caught: unknown) => caught);
    expect((error as PostGenError).stage).toBe('seed');
  });

  it('失败信息只保留首行（不把整段 stderr 抛给用户）', async () => {
    const { exec } = makeExec({ sql: null, failOn: 'prisma generate' });
    const error = await runPostGen(makeOptions({ exec })).catch((caught: unknown) => caught);
    expect((error as PostGenError).message.split('\n')).toHaveLength(1);
  });
});
