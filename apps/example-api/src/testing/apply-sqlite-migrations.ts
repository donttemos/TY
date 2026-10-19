/*
 * @file 集成测试建库帮手（SQLite 专用）
 * @description 共享逻辑：`prisma migrate deploy` 在部分受限环境会**静默不落盘**（exit 0 无副作用，
 *   与 turbo os error 231 同族症状）——deploy 后校验基线首表（demo_items），缺失则按目录序
 *   执行全部迁移 DDL 直建（逐行剥注释：迁移文件「-- 注释行 + 语句」同段，整段以 -- 开头
 *   即过滤会吞掉 CREATE TABLE，连锁 no such table）。仅 sqlite 方言；mysql/pg 走 CI 矩阵。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/testing
 */

import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';

/** deploy 后兜底：基线表缺失时按序直建全量迁移 DDL（幂等，已存在对象跳过） */
export async function ensureSqliteMigrationsApplied(dbUrl: string, cwd = process.cwd()): Promise<void> {
  const probe = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  let needsFullDdl = false;
  try {
    // @sql('sqlite') 基线表存在性探针
    const tables = (await probe.$queryRaw`SELECT name FROM sqlite_master WHERE type='table' AND name='demo_items'`) as Array<{ name: string }>;
    needsFullDdl = tables.length === 0;
  } finally {
    await probe.$disconnect();
  }
  if (!needsFullDdl) return;
  await applyAllSqliteMigrations(dbUrl, cwd);
}

/** 按目录序执行全部迁移 DDL（语句级忽略 already exists / duplicate column，防御性幂等） */
export async function applyAllSqliteMigrations(dbUrl: string, cwd = process.cwd()): Promise<void> {
  const migrationsDir = path.join(cwd, 'prisma', 'migrations');
  const dirs = fs.readdirSync(migrationsDir).filter((d) => /^\d+_/.test(d)).sort();
  const client = new PrismaClient({ datasources: { db: { url: dbUrl } } });
  try {
    for (const dir of dirs) {
      const sql = fs.readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8');
      // 分号切分 + 逐行剥注释行（Prisma 迁移 SQL 的注释行与语句同段）
      const stmts = sql
        .split(';')
        .map((seg) => seg.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
        .filter((seg) => seg.length > 0);
      for (const stmt of stmts) {
        try {
          // @sql('sqlite') 迁移 DDL 直建（迁移文件本身即 sqlite 方言）
          await client.$executeRawUnsafe(stmt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('already exists') || msg.includes('duplicate column')) continue;
          throw e;
        }
      }
    }
  } finally {
    await client.$disconnect();
  }
}
