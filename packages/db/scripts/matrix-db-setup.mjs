#!/usr/bin/env node
/*
 * @file 三库一致性矩阵建表脚本（T-M2-07 前置）
 * @description 按 DB_DRIVER 选出对应方言的 Prisma schema，用 `prisma migrate diff --from-empty
 *   --to-schema-datamodel --script` 生成方言建表 SQL（对应 ADR-0002 的「重建迁移」步骤），
 *   再经 `prisma db execute --stdin` 应用（重置表 + 建表）。跨平台，不依赖 mysql/psql 客户端。
 *
 *   注意：必须用**异步** execFile —— 同步 spawn 在受限宿主（沙箱 / 部分 CI）返回 `cmd.exe EBUSY`。
 *
 *   用法：
 *     DB_DRIVER=mysql    DB_URL=mysql://root:mysql1234@106.55.32.251:3306/framework_test      node scripts/matrix-db-setup.mjs
 *     DB_DRIVER=postgres DB_URL=postgresql://user:123456cs@106.55.32.251:5432/framework_test node scripts/matrix-db-setup.mjs
 *
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/db
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/** 包根目录（packages/db） */
const PKG_DIR = path.resolve(fileURLToPath(new URL('..', import.meta.url)));

/** 框架配置驱动名 → 矩阵 schema 文件（注意 postgres ↔ postgresql 命名差异） */
const SCHEMA_MAP = {
  mysql: 'prisma/test-schema.mysql.prisma',
  postgres: 'prisma/test-schema.postgresql.prisma',
};

/** 各驱动重置表的语句（PG 需引号保留大小写；MySQL 表名默认归一为小写） */
const RESET_SQL = {
  mysql: 'DROP TABLE IF EXISTS `TestUser`;\n',
  postgres: 'DROP TABLE IF EXISTS "TestUser";\n',
};

const DRIVER = process.env.DB_DRIVER ?? '';
const DB_URL = process.env.DB_URL ?? '';
const SCHEMA = SCHEMA_MAP[DRIVER];

if (!SCHEMA) {
  console.error(`[FAIL] 不支持的 DB_DRIVER="${DRIVER}"，可选：mysql | postgres`);
  process.exit(1);
}
if (!DB_URL) {
  console.error('[FAIL] 缺少 DB_URL');
  process.exit(1);
}

/** 执行 prisma 子命令（经 pnpm exec，跨平台；异步避免受限宿主 EBUSY） */
async function runPrisma(args) {
  return execFileAsync('pnpm exec prisma ' + args, {
    cwd: PKG_DIR,
    shell: true,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: DB_URL },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function main() {
  const tmp = mkdtempSync(path.join(tmpdir(), 'fw-matrix-'));
  try {
    console.log(`[1/4] 生成 ${DRIVER} 方言建表 SQL（migrate diff --from-empty）...`);
    const { stdout: ddl } = await runPrisma(`migrate diff --from-empty --to-schema-datamodel ${SCHEMA} --script`);
    const statements = ddl.split('\n').filter((l) => l.startsWith('-- ')).map((l) => l.slice(3));
    console.log(`      生成 ${ddl.split('\n').length} 行 DDL，语句概览: ${statements.join(' / ')}`);

    // db execute 只接受 --file（沙箱下 --stdin 的管道注入会被拦截）
    const applyFile = path.join(tmp, `${DRIVER}-apply.sql`);
    writeFileSync(applyFile, RESET_SQL[DRIVER] + ddl, 'utf8');

    console.log('[2/4] 重置表（DROP TABLE IF EXISTS）...');
    console.log('[3/4] 应用建表 SQL（prisma db execute --file）...');
    await runPrisma(`db execute --file "${applyFile}" --schema ${SCHEMA}`);

    console.log('[4/4] 完成。表结构已与 schema 对齐。');
    console.log('      DDL 明细:');
    console.log(
      ddl
        .split('\n')
        .filter((l) => /CREATE (TABLE|UNIQUE INDEX)|PRIMARY KEY|NOT NULL/.test(l))
        .map((l) => '      ' + l.trim())
        .join('\n'),
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error('[FAIL] 建表失败:', (error.stderr?.toString() || error.message || '').trim());
  process.exitCode = 1;
});
