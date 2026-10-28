/*
 * @file 生成后处理：类型校验 / 迁移 / 定向种子（PRD-016 FR-16-05 / FR-16-06）
 * @description `fw gen crud` 一条命令到底的实现，**顺序不可调换**：
 *   ① `prisma generate`：让 tsc 认识新模型；
 *   ② 双端类型校验（后端 tsc + 前端 vue-tsc 并行）——失败时调用方回滚文件，此时数据库还没动过；
 *   ③ 建迁移（`migrate dev --create-only`，**永不 apply**，因此不会触发 Prisma 的 reset 提示）；
 *   ④ 风险分级（migration.ts）：非 safe 需一次确认或 --allow-destructive；
 *   ⑤ `migrate deploy` 应用（幂等、不 reset）；
 *   ⑥ 只跑「本次生成模型」的种子文件（独立执行，不触碰全量 seed 的清场逻辑）。
 *   先校验后迁移是刻意设计：校验失败回滚文件时数据库保持一致；迁移失败则保留文件只报错。
 *   外部命令经 exec 注入，单测可替换为假执行器（不连库、不跑真实 tsc）。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/gen
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Exec } from '../deploy/exec.js';
import { defaultExec, firstLineOf, pnpmBin } from '../deploy/exec.js';
import { assessSql, summarizeAssessment, type MigrationAssessment } from './migration.js';
import type { GenIo } from './writer.js';

/**
 * 外部命令执行器（失败时抛错）
 * @description 复用 deploy/exec 的统一实现：Windows 下 `.cmd` 走 shell、其余不走，
 *   且失败信息会跳过 warn / 环境提示取真正的错误行（否则用户只看到 "Command failed: ..."）。
 */
export type Executor = Exec;

/** 处理阶段（决定失败时是否回滚文件） */
export type PostGenStage = 'generate' | 'verify' | 'migrate' | 'seed';

/** 生成后处理失败：带阶段标记，便于调用方决定回滚与否 */
export class PostGenError extends Error {
  /** 失败阶段 */
  readonly stage: PostGenStage;

  /**
   * @param stage 失败阶段
   * @param message 面向用户的中文说明
   */
  constructor(stage: PostGenStage, message: string) {
    super(message);
    this.name = 'PostGenError';
    this.stage = stage;
  }
}

/** 校验档位：full=前后端；fast=仅后端；none=跳过 */
export type VerifyLevel = 'full' | 'fast' | 'none';

/** 生成后处理选项 */
export interface PostGenOptions {
  /** 后端应用根（绝对路径） */
  backendRoot: string;
  /** 前端应用根（绝对路径）；无前端则跳过 */
  webRoot?: string;
  /** schema 绝对路径 */
  schemaFile: string;
  /** 本次生成的模型 kebab 名（用于定向种子） */
  models: string[];
  /** 是否建并应用迁移 */
  migrate: boolean;
  /** 是否执行定向种子 */
  seed: boolean;
  /** 允许破坏性迁移（等价 --allow-destructive） */
  allowDestructive?: boolean;
  /** 破坏性迁移的确认回调（TTY 交互由调用方注入；返回 false 即中止） */
  confirmDestructive?: (assessment: MigrationAssessment) => Promise<boolean>;
  /** 校验档位 */
  verify: VerifyLevel;
  /** 输出 */
  io: GenIo;
  /** 执行器（单测注入） */
  exec?: Executor;
}

/** 生成后处理结果 */
export interface PostGenResult {
  /** 新建并应用的迁移（无结构变更时 name 为 null） */
  migration: { name: string | null; applied: boolean; assessment?: MigrationAssessment };
  /** 已执行定向种子的模型 */
  seeded: string[];
  /** 已通过的校验（backend / frontend） */
  verified: string[];
}

/** 取错误信息首行（失败输出要短，PRD-016 精简原则 4） */
function firstLine(error: unknown): string {
  return firstLineOf(error);
}

/** 列出迁移目录（按名称升序，Prisma 以时间戳前缀命名） */
function listMigrations(migrationsDir: string): string[] {
  if (!fs.existsSync(migrationsDir)) return [];
  return fs
    .readdirSync(migrationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^\d/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

/** 读取指定迁移的 SQL（不存在时返回空串） */
function readMigrationSql(migrationsDir: string, name: string): string {
  const file = path.join(migrationsDir, name, 'migration.sql');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
}

/**
 * 执行生成后处理（生成类型 → 双端校验 → 迁移 → 定向种子）
 * @param options 选项
 */
export async function runPostGen(options: PostGenOptions): Promise<PostGenResult> {
  const exec: Executor = options.exec ?? defaultExec;
  const io = options.io;
  const result: PostGenResult = { migration: { name: null, applied: false }, seeded: [], verified: [] };
  const schemaRel = path.relative(options.backendRoot, options.schemaFile).split(path.sep).join('/');
  const migrationsDir = path.join(path.dirname(options.schemaFile), 'migrations');

  // ① 生成 Prisma Client：新增模型后 tsc 必须能解析到对应类型
  try {
    await exec(pnpmBin(), ['exec', 'prisma', 'generate', '--schema', schemaRel], options.backendRoot);
  } catch (error) {
    throw new PostGenError('generate', `生成 Prisma Client 失败：${firstLine(error)}。请检查 schema 是否有语法错误`);
  }

  // ② 双端类型校验（先于迁移：失败时数据库尚未变更，回滚文件才不会留下不一致）
  if (options.verify !== 'none') {
    const tasks: { name: string; run: () => Promise<void> }[] = [
      {
        name: 'backend',
        run: async () => {
          if (!fs.existsSync(path.join(options.backendRoot, 'tsconfig.json'))) return;
          await exec(pnpmBin(), ['exec', 'tsc', '-p', 'tsconfig.json', '--noEmit'], options.backendRoot);
        },
      },
    ];
    if (options.verify === 'full' && options.webRoot && fs.existsSync(path.join(options.webRoot, 'package.json'))) {
      const webRoot = options.webRoot;
      tasks.push({
        name: 'frontend',
        run: async () => {
          await exec(pnpmBin(), ['exec', 'vue-tsc', '--noEmit'], webRoot);
        },
      });
    }

    const outcomes = await Promise.allSettled(tasks.map((task) => task.run()));
    const failures = outcomes
      .map((outcome, index) => ({ outcome, name: tasks[index].name }))
      .filter((item) => item.outcome.status === 'rejected');
    if (failures.length > 0) {
      const detail = failures
        .map((item) => `${item.name}：${firstLine((item.outcome as PromiseRejectedResult).reason)}`)
        .join('；');
      throw new PostGenError('verify', `类型校验未通过（${detail}）。已回滚生成文件，可用 --no-verify 跳过校验再人工修复`);
    }
    result.verified = tasks.map((task) => task.name);
    io.log(`[gen] 类型校验通过：${result.verified.join(' + ')}`);
  }

  // ③ 建迁移（只创建不应用）：避免 migrate dev 的 apply/reset 语义碰到真实数据
  if (options.migrate) {
    const before = listMigrations(migrationsDir);
    const name = `fw_gen_${options.models[0] ?? 'model'}`;
    try {
      await exec(
        pnpmBin(),
        ['exec', 'prisma', 'migrate', 'dev', '--create-only', '--name', name, '--schema', schemaRel],
        options.backendRoot,
      );
    } catch (error) {
      throw new PostGenError(
        'migrate',
        `建迁移失败：${firstLine(error)}。可先执行 fw db:migrate 确认数据库连通与 schema 一致，或加 --no-migrate 跳过`,
      );
    }

    const created = listMigrations(migrationsDir).filter((item) => !before.includes(item));
    if (created.length === 0) {
      io.log('[gen] 无结构变更，跳过迁移');
    } else {
      const migrationName = created[created.length - 1];
      const assessment = assessSql(readMigrationSql(migrationsDir, migrationName));
      result.migration.name = migrationName;
      result.migration.assessment = assessment;
      io.log(`[gen] 迁移已生成 ${migrationName}：${summarizeAssessment(assessment)}`);

      // ④ 风险闸门：非 safe 必须显式放行，绝不在无确认时执行破坏性迁移
      if (assessment.risk !== 'safe') {
        const approved =
          options.allowDestructive === true ||
          (options.confirmDestructive ? await options.confirmDestructive(assessment) : false);
        if (!approved) {
          throw new PostGenError(
            'migrate',
            `迁移未执行：${summarizeAssessment(assessment)}。确认可接受后加 --allow-destructive 重跑（迁移文件已保留）`,
          );
        }
      }

      // ⑤ 应用迁移（deploy 幂等，永不 reset）
      try {
        await exec(pnpmBin(), ['exec', 'prisma', 'migrate', 'deploy', '--schema', schemaRel], options.backendRoot);
      } catch (error) {
        throw new PostGenError('migrate', `应用迁移失败：${firstLine(error)}。迁移文件已保留，修复后可执行 fw db:migrate 重试`);
      }
      result.migration.applied = true;
      io.log(`[gen] 迁移已应用：${migrationName}`);
    }
  }

  // ⑥ 定向种子：只跑本次模型的 seed 文件，不触发全量 seed 的清场逻辑
  if (options.seed) {
    for (const model of options.models) {
      const seedFile = path.join(options.backendRoot, 'prisma', 'seed', `${model}.seed.ts`);
      if (!fs.existsSync(seedFile)) {
        io.log(`[warn] 未找到 ${model} 的种子文件，跳过权限点写入`);
        continue;
      }
      try {
        await exec(
          pnpmBin(),
          ['exec', 'tsx', path.relative(options.backendRoot, seedFile).split(path.sep).join('/')],
          options.backendRoot,
        );
      } catch (error) {
        throw new PostGenError('seed', `写入 ${model} 权限点失败：${firstLine(error)}。可稍后执行 fw db:seed 重试`);
      }
      result.seeded.push(model);
    }
  }

  return result;
}
