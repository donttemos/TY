/**
 * @file M10 E-10 审计归档冒烟验证脚本（PRD-010 AC7 进程级复现）
 * @description 单实例（SQLite dev.db，AUDIT_ARCHIVE_RETENTION_DAYS=1 / BATCH_SIZE=2）验证归档闭环：
 *   A. 预置 3 条两天前的审计记录（批次=2 触发分批）+ 1 条当天记录（保留线内不动）；
 *   B. 手动触发 audit.archive（走 @fw/queue 分布式锁语义，多副本单执行由 TC-JOB-002 与
 *      docs/94b cron 分布式互斥实测覆盖，本脚本不重复）；
 *   C. 快照与落库断言：lastArchived=3、在线表行数回落 3、归档表 3 条、当天记录未动；
 *   D. 幂等重跑：再触发一次 lastArchived=0（先写后删 upsert 幂等，无重复行）；
 *   E. 冷数据出口：GET /audit-archives 分页查询命中 3 条；导出任务 jobId → succeeded →
 *      下载 CSV 带 UTF-8 BOM 且行数正确；
 *   F. 越权反向：无 audit:read 权限的账号查询归档 403/3002（归档不是越权后门）。
 *   前置：dev.db 已迁移并播种（`pnpm exec prisma migrate deploy && pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Prisma, PrismaClient } from '@prisma/client';

/** 冒烟专用端口（避开既有冒烟实例） */
const PORT = 3760;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const DB_URL = `file:${path.join(CWD, 'prisma/dev.db')}`;
/** 预置记录模块名（隔离断言范围，不与种子数据混淆） */
const MODULE = 'smoke-archive';
const OLD_IDS = ['smoke-arc-1', 'smoke-arc-2', 'smoke-arc-3'];
const FRESH_ID = 'smoke-arc-fresh';

const prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text, buffer, headers } */
async function call(base, requestPath, options = {}) {
  const res = await fetch(base + requestPath, options);
  const buf = Buffer.from(await res.arrayBuffer());
  const text = buf.toString('utf8');
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text, buffer: buf, headers: res.headers };
}

/** 登录并返回 access token */
async function login(base, account, password) {
  const res = await call(base, '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ account, password }),
  });
  return res.body?.data?.accessToken ?? null;
}

/** 启动实例并等待就绪 */
async function startInstance() {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: {
      ...process.env,
      APP_PORT: String(PORT),
      DB_URL,
      DB_DRIVER: 'sqlite',
      AUDIT_ARCHIVE_RETENTION_DAYS: '1',
      AUDIT_ARCHIVE_BATCH_SIZE: '2',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  const base = `http://127.0.0.1:${PORT}`;
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(base, '/ready');
      if (status === 200) return { child, base, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`实例在 30s 内未就绪：\n${output.slice(-2000)}`);
}

/** 停止实例 */
async function stopInstance(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return;
  const exited = new Promise((resolve) => instance.child.on('exit', resolve));
  instance.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 轮询任务直到到达期望状态 */
async function waitForStatus(base, token, jobId, expectStatus, timeoutMs = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const res = await call(base, `/api/v1/jobs/${jobId}/progress`, { headers: { authorization: `Bearer ${token}` } });
    last = res.body?.data ?? null;
    if (last?.status === expectStatus) return last;
    await sleep(200);
  }
  throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内到达 ${expectStatus}：${JSON.stringify(last)}`);
}

async function main() {
  console.log('—— M10 E-10 审计归档冒烟（PRD-010 AC7） ——\n');

  // ---------- A. 预置数据 ----------
  const twoDaysAgo = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const now = new Date();
  // 清理上次运行的残留（固定 id，幂等重跑）
  await prisma.auditLog.deleteMany({ where: { id: { in: [...OLD_IDS, FRESH_ID] } } });
  await prisma.auditLogArchive.deleteMany({ where: { id: { in: [...OLD_IDS, FRESH_ID] } } });
  const admin = await prisma.user.findFirst({ where: { username: 'admin' } });
  if (!admin) throw new Error('dev.db 未播种（缺少 admin 用户），请先执行 seed');
  await prisma.auditLog.createMany({
    data: OLD_IDS.map((id) => ({
      id,
      userId: admin.id,
      module: MODULE,
      action: 'update',
      targetType: 'order',
      targetId: `t-${id}`,
      beforeValue: { status: 'pending' },
      afterValue: { status: 'paid' },
      ip: '127.0.0.1',
      userAgent: 'smoke-audit-archive',
      traceId: `trace-${id}`,
      createdAt: twoDaysAgo,
    })),
  });
  await prisma.auditLog.create({
    data: {
      id: FRESH_ID,
      userId: admin.id,
      module: MODULE,
      action: 'create',
      targetType: 'order',
      targetId: 't-fresh',
      beforeValue: Prisma.DbNull,
      afterValue: { status: 'new' },
      ip: '127.0.0.1',
      userAgent: 'smoke-audit-archive',
      traceId: 'trace-fresh',
      createdAt: now,
    },
  });
  const onlineBefore = await prisma.auditLog.count();
  console.log(`阶段 A：预置 3 条两天前 + 1 条当天记录；在线表当前 ${onlineBefore} 行\n`);

  const instance = await startInstance();
  try {
    const { base } = instance;
    const token = await login(base, 'admin', 'Admin@123456');
    if (!token) throw new Error('admin 登录失败（seed 密码与脚本不一致？）');

    // ---------- B. 手动触发归档 ----------
    console.log('\n—— 阶段 B：cron-tick 手动触发 audit.archive ——');
    const tick = await call(base, '/api/v1/demo-queue/cron-tick?name=audit.archive', { method: 'POST' });
    // Nest @Post 默认 201 Created，200/201 均视为成功
    check('B1 归档任务已注册且取得锁执行', [200, 201].includes(tick.status) && tick.body?.data?.results?.[0]?.name === 'audit.archive' && tick.body?.data?.results?.[0]?.acquired === true, `http=${tick.status} ${JSON.stringify(tick.body?.data)}`);

    // ---------- C. 快照与落库断言 ----------
    console.log('\n—— 阶段 C：快照与落库断言 ——');
    const snap = await call(base, '/api/v1/auth-maintenance/audit-archive');
    const s = snap.body?.data ?? {};
    check('C1 快照：表达式 / 保留天数 / 批大小与配置一致', s.expression === '0 2 * * *' && s.retentionDays === 1 && s.batchSize === 2, JSON.stringify({ expression: s.expression, retentionDays: s.retentionDays, batchSize: s.batchSize }));
    check('C2 快照：lastArchived=3 且无错误', s.lastArchived === 3 && s.lastError === null, `archived=${s.lastArchived} error=${s.lastError}`);
    // 行数回落断言取 module 隔离口径（实例运行期的登录等行为也会写审计，全表计数不精确）：
    // smoke-archive 模块在线行 4 → 1（3 条旧记录迁出，1 条当天记录保留），全表计数作信息展示
    const onlineModuleAfter = await prisma.auditLog.count({ where: { module: MODULE } });
    check('C3 在线表行数回落：module=smoke-archive 4 → 1（AC7）', onlineModuleAfter === 1, `module 行 ${onlineModuleAfter}；全表 ${onlineBefore} → ${s.lastCounts?.online}`);
    const archivedRows = await prisma.auditLogArchive.findMany({ where: { module: MODULE }, orderBy: { createdAt: 'asc' } });
    check('C4 归档表 3 条且字段逐项保留（含 traceId / 前后值）', archivedRows.length === 3 && archivedRows.every((r) => OLD_IDS.includes(r.id) && r.traceId === `trace-${r.id}` && r.afterValue?.status === 'paid' && r.archivedAt !== null), `rows=${archivedRows.length}`);
    const oldLeft = await prisma.auditLog.count({ where: { id: { in: OLD_IDS } } });
    const freshLeft = await prisma.auditLog.count({ where: { id: FRESH_ID } });
    check('C5 在线表旧记录清零、保留线内记录未动', oldLeft === 0 && freshLeft === 1, `old=${oldLeft} fresh=${freshLeft}`);

    // ---------- D. 幂等重跑 ----------
    console.log('\n—— 阶段 D：幂等重跑 ——');
    await call(base, '/api/v1/demo-queue/cron-tick?name=audit.archive', { method: 'POST' });
    const snap2 = (await call(base, '/api/v1/auth-maintenance/audit-archive')).body?.data ?? {};
    check('D1 二次触发 lastArchived=0（无重复归档）', snap2.lastArchived === 0 && snap2.lastError === null, `archived=${snap2.lastArchived}`);
    check('D2 归档表仍为 3 条（无重复行）', (await prisma.auditLogArchive.count({ where: { module: MODULE } })) === 3);

    // ---------- E. 冷数据出口 ----------
    console.log('\n—— 阶段 E：归档查询与导出 ——');
    const list = await call(base, `/api/v1/audit-archives?module=${MODULE}&page=1&pageSize=10`, { headers: { authorization: `Bearer ${token}` } });
    check('E1 归档分页查询命中 3 条（audit:read）', list.status === 200 && list.body?.data?.total === 3, `http=${list.status} total=${list.body?.data?.total}`);
    const exp = await call(base, `/api/v1/audit-archives/export?module=${MODULE}`, { headers: { authorization: `Bearer ${token}` } });
    // JobView 主键为 id（jobId 语义）
    const jobId = exp.body?.data?.id ?? exp.body?.data?.jobId ?? null;
    check('E2 导出派发返回 jobId（任务中心）', exp.status === 200 && typeof jobId === 'string', `http=${exp.status} jobId=${jobId}`);
    const done = await waitForStatus(base, token, jobId, 'succeeded');
    const download = await call(base, `/api/v1/jobs/${jobId}/download`, { headers: { authorization: `Bearer ${token}` } });
    const lines = download.text.replace(/^\uFEFF/, '').trim().split(/\r?\n/);
    check('E3 CSV 产物带 UTF-8 BOM 且 1 头 + 3 行', download.status === 200 && download.buffer.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])) && lines.length === 4, `bytes=${download.buffer.length} lines=${lines.length}`);

    // ---------- F. 越权反向 ----------
    console.log('\n—— 阶段 F：越权反向验证 ——');
    const alice = await login(base, 'alice', 'Alice@123456');
    const denied = await call(base, `/api/v1/audit-archives?module=${MODULE}`, { headers: { authorization: `Bearer ${alice ?? 'invalid'}` } });
    const code = denied.body?.code ?? denied.body?.error?.code;
    check('F1 无 audit:read 的账号查询归档被拒（403/3002）', denied.status === 403 || code === '3002', `http=${denied.status} code=${code}`);
    const anon = await call(base, `/api/v1/audit-archives?module=${MODULE}`);
    check('F2 未登录查询归档被拒', anon.status === 401 || anon.status === 403, `http=${anon.status}`);
  } finally {
    await stopInstance(instance);
    await prisma.$disconnect();
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n—— 结果：${results.length - failed.length}/${results.length} 通过 ——`);
  if (failed.length > 0) {
    console.log(failed.map((r) => `FAIL  ${r.name}`).join('\n'));
    console.log('\n实例日志尾部：\n' + instance.output().slice(-1500));
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('SMOKE ERROR:', error);
  process.exit(1);
});
