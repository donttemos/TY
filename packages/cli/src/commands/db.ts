/*
 * @file 数据库迁移命令：fw db:migrate / db:rollback / db:seed
 * @description 包装 Prisma CLI（migrate deploy 幂等应用迁移）；
 *   Prisma 无原生回滚，db:rollback 用 migrate diff 生成反向 SQL（--from-migrations 最新 → --to-migrations 上一个）
 *   经 db execute 执行，并清理 _prisma_migrations 记录，实现 TC-ORM-007 的「结构与数据回到上一版本」。
 *   TODO(donttemo, 2026-10-13): M6 抽象为 DatabasePort 后，本文件只保留命令编排，执行细节下沉到端口适配器。
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo 外部命令改异步执行：同步 spawn 在受限宿主（沙箱/部分 CI）返回 EBUSY，
 *   且会阻塞事件循环；异步化后与 pnpm 自身调用路径一致，命令在所有环境可用
 * @modified 2026-10-13 donttemo 校验失败分支补 return：process.exit 被拦截或行为差异时不再继续执行后续逻辑
 * @module cli
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 项目 prisma 目录（相对 cwd） */
const PRISMA_DIR = 'prisma';
/** 迁移子目录 */
const MIGRATIONS_DIR = path.join(PRISMA_DIR, 'migrations');
/** 外部命令输出上限（migrate diff 的 SQL 可能较大，默认 1MB 不够） */
const MAX_BUFFER = 32 * 1024 * 1024;

/** db 命令选项（CLI 传入） */
export interface DbCommandOptions {
  /** schema 文件路径，默认 prisma/schema.prisma */
  schema?: string;
}

/**
 * 执行外部命令并返回 stdout
 * 统一在 shell 中执行：Windows 下 pnpm / tsx 均为 .cmd，须经 shell 解析；
 * 失败时把 stderr 一并抛出，避免只看到难以定位的退出码。
 * @param command 完整命令行
 * @returns stdout 文本
 */
async function exec(command: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, {
      cwd: process.cwd(),
      shell: true,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return stdout;
  } catch (error) {
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    const output = (detail.stderr || detail.stdout || detail.message || '').trim();
    throw new Error(output ? `${command} 执行失败：\n${output}` : `${command} 执行失败`);
  }
}

/** 定位 prisma CLI（经 pnpm exec，保证用项目内版本） */
function prisma(args: string[]): Promise<string> {
  return exec(`pnpm exec prisma ${args.join(' ')}`);
}

/** 校验项目结构：schema 文件必须存在 */
function assertProject(schemaFile: string): void {
  if (!fs.existsSync(schemaFile)) {
    console.error(`未找到 ${schemaFile}：请在项目根目录执行，或用 --schema=<路径> 指定`);
    process.exit(1);
  }
}

/** 列出已提交迁移（按目录名字典序 = 时间序），返回迁移名列表 */
function listMigrations(): string[] {
  if (!fs.existsSync(MIGRATIONS_DIR)) return [];
  return fs
    .readdirSync(MIGRATIONS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => e.name)
    .sort();
}

/**
 * fw db:migrate：应用所有未执行迁移（幂等，CI/生产安全）
 * 开发环境建新迁移用 `pnpm exec prisma migrate dev --name <动作>_<表>`（保留 Prisma 原生体验）
 * @param options schema 路径等
 */
export async function runMigrate(options: DbCommandOptions = {}): Promise<void> {
  const schemaFile = options.schema ?? path.join(PRISMA_DIR, 'schema.prisma');
  assertProject(schemaFile);
  const pending = listMigrations();
  console.log(`[db:migrate] 共 ${pending.length} 个迁移，开始应用…`);
  const out = await prisma(['migrate', 'deploy', '--schema', schemaFile]);
  if (out.trim()) console.log(out);
  console.log('[db:migrate] 完成');
}

/**
 * fw db:rollback：回滚最后一次迁移（TC-ORM-007）
 * 步骤：
 *   1. 构造临时目录（previous 及更早迁移 + migration_lock.toml）作为 diff 目标状态
 *   2. migrate diff --from-migrations <全部> --to-migrations <临时目录> 生成反向 SQL
 *   3. db execute 执行反向 SQL，并清理 _prisma_migrations 记录
 * @param options schema 路径等
 */
export async function runRollback(options: DbCommandOptions = {}): Promise<void> {
  const schemaFile = options.schema ?? path.join(PRISMA_DIR, 'schema.prisma');
  assertProject(schemaFile);
  const migrations = listMigrations();
  if (migrations.length === 0) {
    console.error('[db:rollback] 无迁移可回滚');
    process.exit(1);
    return;
  }
  const latest = migrations[migrations.length - 1];
  const kept = migrations.slice(0, -1); // previous 及更早
  const previous = kept.length >= 1 ? kept[kept.length - 1] : null;

  // diff 目标状态目录：放在 migrations 同级（放内部会被 --from-migrations 误扫为迁移目录，P3015）
  const targetDir = path.join(PRISMA_DIR, '.fw-rollback-target');
  fs.rmSync(targetDir, { recursive: true, force: true });
  try {
    if (kept.length > 0) {
      fs.mkdirSync(targetDir, { recursive: true });
      // 只保留到 previous 为止的迁移（含更早，保证状态可复现）
      for (const name of kept) {
        fs.cpSync(path.join(MIGRATIONS_DIR, name), path.join(targetDir, name), { recursive: true });
      }
      // migration_lock.toml 必须随行（Prisma 靠它识别 provider）
      const lockSrc = path.join(MIGRATIONS_DIR, 'migration_lock.toml');
      if (fs.existsSync(lockSrc)) {
        fs.copyFileSync(lockSrc, path.join(targetDir, 'migration_lock.toml'));
      }
    }

    // 反向 diff：从「全部迁移的状态」回到「目标状态」
    const diffArgs = [
      'migrate', 'diff',
      '--from-migrations', MIGRATIONS_DIR,
      kept.length > 0 ? '--to-migrations' : '--to-empty',
      ...(kept.length > 0 ? [targetDir] : []),
      '--script',
    ];
    const rollbackSql = await prisma(diffArgs);
    if (!rollbackSql.trim()) {
      console.error(`[db:rollback] 迁移 ${latest} 未产生可回滚 SQL（可能无结构变更）`);
      process.exit(1);
      return;
    }

    // 落盘临时 SQL 供 db execute 执行（Prisma 的 db execute 只吃文件）
    const sqlFile = path.join(MIGRATIONS_DIR, `${latest}.rollback.sql`);
    fs.writeFileSync(sqlFile, rollbackSql, 'utf8');
    try {
      const out = await prisma(['db', 'execute', '--file', sqlFile, '--schema', schemaFile]);
      if (out.trim()) console.log(out);
      console.log(`[db:rollback] 已回滚 ${latest}，结构回到 ${previous ?? '空库'}`);
    } finally {
      fs.rmSync(sqlFile, { force: true });
    }

    // 清理 _prisma_migrations 记录，使该迁移可被再次应用（migrate deploy 幂等的前提）。
    // 表名小写无保留字冲突，三库通用（MySQL 反引号/PG 双引号/SQLite 均可省引号）
    const deleteSql = path.join(MIGRATIONS_DIR, `${latest}.cleanup.sql`);
    fs.writeFileSync(deleteSql, `DELETE FROM _prisma_migrations WHERE migration_name = '${latest}';\n`, 'utf8');
    try {
      await prisma(['db', 'execute', '--file', deleteSql, '--schema', schemaFile]);
    } finally {
      fs.rmSync(deleteSql, { force: true });
    }
  } finally {
    fs.rmSync(targetDir, { recursive: true, force: true });
  }
}

/**
 * fw db:seed：执行项目 package.json 中 prisma.seed 约定的种子脚本（FR-09 机制；
 * 初始角色/管理员/字典数据由模板项目的 prisma/seed.ts 提供，M3 起由框架 seed 扩展）
 * @param options schema 路径等（预留：seed 不使用 schema，保留接口一致）
 */
export async function runSeed(_options: DbCommandOptions = {}): Promise<void> {
  assertProject(path.join(PRISMA_DIR, 'schema.prisma'));
  const pkgPath = path.join(process.cwd(), 'package.json');
  if (!fs.existsSync(pkgPath)) {
    console.error('[db:seed] 未找到 package.json');
    process.exit(1);
    return;
  }
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { prisma?: { seed?: string } };
  if (!pkg.prisma?.seed) {
    console.error('[db:seed] package.json 未配置 prisma.seed：请添加 "prisma": { "seed": "tsx prisma/seed.ts" }');
    process.exit(1);
    return;
  }
  console.log('[db:seed] 执行种子脚本…');
  const out = await exec(pkg.prisma.seed);
  if (out.trim()) console.log(out);
  console.log('[db:seed] 完成');
}
