/*
 * @file M11.1 双实例（双进程）rotation CAS 验证脚本（ADR-0020 DoD：dual-instance 100 concurrency）
 * @description 父进程发一个 refresh token A，派生 N 个**独立 Node 进程**（各自 PrismaClient 连接 +
 *   各自 RefreshTokenService 实例），每个进程并发 rotate(A) —— 进程间唯一共享状态是数据库，
 *   以此证明分布式 CAS：N 进程 × M 并发 ⇒ exactly 1 replacement（Rule 5）。
 *
 *   用法（在 apps/example-api 目录下，需先 pnpm build 产出 dist）：
 *     ROTATION_TEST_DB_URL='mysql://...' node scripts/dual-instance-rotation.mjs
 *   可选：PROCESSES（默认 2）、CONCURRENCY（默认 50）、JWT_SECRET。
 *   退出码：0 = exactly 1 replacement；1 = 违反不变量或基础设施错误。
 * @author donttemo
 * @created 2026-10-16
 * @module example-api/auth
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const DB_URL = process.env.ROTATION_TEST_DB_URL;
if (!DB_URL) {
  console.error('缺少 ROTATION_TEST_DB_URL（目标数据库连接串，需已完成该方言 migration deploy）');
  process.exit(1);
}
const SECRET = process.env.JWT_SECRET ?? 'm11-dual-instance-secret-0123456789abcdef0123456789abcdef';
const PROCESSES = Number(process.env.PROCESSES ?? 2);
const CONCURRENCY = Number(process.env.CONCURRENCY ?? 50);
const IS_CHILD = process.env.DUAL_CHILD === '1';
const HERE = path.dirname(fileURLToPath(import.meta.url));
// 异步 execFile：同步 spawn 在受限宿主（沙箱/部分 CI）返回 EBUSY（与 @fw/cli db 命令同款修复）
const execFileAsync = promisify(execFile);

async function childMain() {
  const { PrismaClient } = await import('@prisma/client');
  const auth = await import('@fw/auth');
  const { PrismaAuthStore } = await import('../dist/modules/auth/prisma-auth-store.js');
  const client = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const store = new PrismaAuthStore(client);
  const tokens = new auth.TokenService({ secret: SECRET, accessTtlSeconds: 900, refreshTtlSeconds: 7 * 24 * 3600 });
  const refresh = new auth.RefreshTokenService(store, tokens, 10);

  const childIndex = Number(process.env.DUAL_CHILD_INDEX);
  const oldToken = process.env.DUAL_OLD_TOKEN;
  const results = await Promise.all(
    Array.from({ length: CONCURRENCY }, () => refresh.rotate(oldToken, '10.0.0.1', `dual-instance-${childIndex}`)),
  );
  await client.$disconnect();
  process.stdout.write(
    JSON.stringify({ childIndex, tokens: results.map((r) => r.refreshToken) }) + '\n',
  );
}

async function parentMain() {
  const { PrismaClient } = await import('@prisma/client');
  const auth = await import('@fw/auth');
  const { PrismaAuthStore } = await import('../dist/modules/auth/prisma-auth-store.js');
  const client = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  const store = new PrismaAuthStore(client);
  const tokens = new auth.TokenService({ secret: SECRET, accessTtlSeconds: 900, refreshTtlSeconds: 7 * 24 * 3600 });
  const refresh = new auth.RefreshTokenService(store, tokens, 10);

  const username = `m11-dual-${Date.now()}`;
  const user = await client.user.create({
    data: { username, passwordHash: 'x', status: 1, tenantId: 1n },
  });
  const first = await refresh.issue(user.id, '10.0.0.1', 'dual-parent');

  // 派生 N 个独立进程（各自建连、各自 service 实例；进程间共享状态只有数据库）
  const self = fileURLToPath(import.meta.url);
  const children = [];
  for (let i = 0; i < PROCESSES; i++) {
    children.push(
      execFileAsync(process.execPath, [self], {
        env: {
          ...process.env,
          DUAL_CHILD: '1',
          DUAL_CHILD_INDEX: String(i),
          DUAL_OLD_TOKEN: first.refreshToken,
          ROTATION_TEST_DB_URL: DB_URL,
          JWT_SECRET: SECRET,
        },
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
      }),
    );
  }

  const stdouts = await Promise.all(children);
  const allTokens = [];
  for (const { stdout } of stdouts) {
    const line = stdout.trim().split('\n').pop();
    const parsed = JSON.parse(line);
    allTokens.push(...parsed.tokens);
  }
  const uniqueTokens = [...new Set(allTokens)];

  // 清理
  await client.refreshToken.deleteMany({ where: { userId: user.id } });
  await client.user.delete({ where: { id: user.id } });
  await client.$disconnect();

  const summary = `进程数=${PROCESSES} 每进程并发=${CONCURRENCY} 总请求=${PROCESSES * CONCURRENCY} unique replacement=${uniqueTokens.length}`;
  if (uniqueTokens.length !== 1) {
    console.error(`FAIL（违反 ADR-0020 Rule 5）：${summary}`);
    process.exit(1);
  }
  console.log(`PASS：${summary}（分布式 CAS：N 进程共享同一数据库，仍 only one B）`);
}

if (IS_CHILD) {
  await childMain();
} else {
  await parentMain();
}
