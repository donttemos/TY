/*
 * @file PrismaRepository 集成测试（真实 SQLite）
 * @description 用 prisma/test-client 对真实 SQLite 执行 PRD-002 功能用例。
 *   用例主体已抽到 repository-suite.ts，与 MySQL/PostgreSQL 矩阵测试（prisma-repository.matrix.test.ts）
 *   共用同一份断言 —— 三库一致性（T-M2-07）由此证明。
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo 迁移准备改异步 execFile：同步 spawn 在受限宿主（沙箱/部分 CI）返回 EBUSY
 * @modified 2026-10-13 donttemo 用例主体抽出为 defineRepositorySuite，供三库矩阵复用
 * @module @fw/db
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '../../prisma/test-client/index.js';
import { defineRepositorySuite, type MatrixTestClient } from './repository-suite.js';

const execFileAsync = promisify(execFile);

/** 测试库路径（独立文件，避免与开发库交叉） */
const DB_FILE = path.join(process.cwd(), 'prisma', 'test-int.db');
const DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;

let prisma: PrismaClient;

/** 带重试的迁移应用：Windows 下 pnpm exec + prisma 偶发文件锁竞态（CI 防抖） */
async function migrateDeployWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Windows 下 pnpm.cmd 需经 shell 执行；异步执行避免同步 spawn 在受限宿主返回 EBUSY
      await execFileAsync('pnpm exec prisma migrate deploy --schema prisma/test-schema.prisma', {
        cwd: process.cwd(),
        shell: true,
        env: { ...process.env, TEST_DATABASE_URL: DB_URL },
      });
      return;
    } catch (error) {
      lastError = error;
      // 退避 200ms 后重试
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  // 保证表结构最新（幂等）
  fs.rmSync(DB_FILE, { force: true });
  // Prisma 6 migrate deploy 在 Windows 上要求 SQLite 文件已存在；db push 可建库但不验证迁移。
  fs.closeSync(fs.openSync(DB_FILE, 'w'));
  await migrateDeployWithRetry();
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
});

afterAll(async () => {
  if (prisma) await prisma.$disconnect();
  fs.rmSync(DB_FILE, { force: true });
});

// 与 MySQL / PostgreSQL 矩阵测试共用同一套断言
describe('SQLite 集成（默认离线库）', () => {
  defineRepositorySuite({
    label: 'sqlite',
    getClient: () => prisma as unknown as MatrixTestClient,
  });
});
