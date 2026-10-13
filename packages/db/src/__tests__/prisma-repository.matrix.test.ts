/*
 * @file PrismaRepository 三库一致性矩阵测试（T-M2-07）
 * @description 与 sqlite 集成测试共用 defineRepositorySuite 的同一份断言，仅按 DB_DRIVER 切换
 *   目标数据库连接；对应 ADR-0002 / ADR-0007：切换只改 datasource 两行，业务代码 diff = 0。
 *
 *   启用方式（未设置时整文件跳过，保证离线单测与覆盖率门禁不被远端依赖阻塞）：
 *     DB_DRIVER=mysql      DB_URL=mysql://root:mysql1234@106.55.32.251:3306/framework_test pnpm --filter @fw/db test
 *     DB_DRIVER=postgres   DB_URL=postgresql://user:123456cs@106.55.32.251:5432/framework_test pnpm --filter @fw/db test
 *
 *   前置：先跑 node scripts/matrix-db-setup.mjs 建表（生成方言迁移 SQL 并应用）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/db
 */

import { describe, beforeAll, afterAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { defineRepositorySuite, type MatrixTestClient } from './repository-suite.js';

/** 框架配置里的驱动名 → Prisma 客户端目录后缀（注意：配置用 postgres，Prisma provider 用 postgresql） */
const CLIENT_DIR: Record<string, string> = {
  mysql: 'matrix-client-mysql',
  postgres: 'matrix-client-postgresql',
};

const DRIVER = process.env.DB_DRIVER ?? '';
const DB_URL = process.env.DB_URL ?? '';
const CLIENT_SUFFIX = CLIENT_DIR[DRIVER];
const ENABLED = Boolean(CLIENT_SUFFIX && DB_URL);

/** 动态加载对应驱动的生成客户端（未生成时该矩阵不启用） */
async function loadClient(): Promise<MatrixTestClient> {
  if (!CLIENT_SUFFIX) throw new Error(`不支持的 DB_DRIVER: ${DRIVER}`);
  const entry = fileURLToPath(new URL(`../../prisma/${CLIENT_SUFFIX}/index.js`, import.meta.url));
  const mod = (await import(entry)) as { PrismaClient: new (opts: unknown) => unknown };
  return new mod.PrismaClient({ datasources: { db: { url: DB_URL } } }) as unknown as MatrixTestClient;
}

let client: MatrixTestClient;

beforeAll(async () => {
  client = await loadClient();
});

afterAll(async () => {
  await client?.$disconnect();
});

describe.skipIf(!ENABLED)(`远端三库矩阵（DB_DRIVER=${DRIVER || '未设置'}）`, () => {
  defineRepositorySuite({
    label: DRIVER || 'unset',
    getClient: () => client,
  });
});
