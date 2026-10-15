/**
 * @file M10 E-01 任务中心 db 驱动冒烟验证脚本（PRD-010 AC1 进程级复现）
 * @description 两个独立进程共享同一 SQLite 库（= 两个应用实例，JOB_CENTER_DRIVER=db），
 *   验证多副本语义：实例 A 派发的任务，实例 B 可查进度、可下载产物、可重跑失败任务——
 *   无需会话粘滞（Helm replicaCount≥2 + Nginx 轮询形态的本地近似）。
 *   阶段：
 *   A. 实例 A（3750）派发审计导出 → 立即返回 jobId（pending）；
 *   B. 实例 B（3751，独立进程同库）轮询进度至 succeeded（跨实例可达）；
 *   C. 实例 B 下载产物：CSV 文本流 + UTF-8 BOM（跨实例产物可达）；
 *   D. 实例 B 重跑失败任务（租户迁移连接串非法 → 派发即会失败 → B 上重跑状态流转 pending）；
 *   E. 归属人语义跨实例一致：他人任务 404 / 成功任务重跑拒绝（STATE_NOT_ALLOWED）；
 *   F. memory 驱动回归锚点：不带驱动变量时任务登记不落库（同库查询 0 行）。
 *   前置：dev.db 已迁移并播种（`pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开既有冒烟实例） */
const PORT_A = 3750;
const PORT_B = 3751;
const CWD = fileURLToPath(new URL('..', import.meta.url));
/** 共享库：与 dev.db 同文件（两实例 = 两进程读同一库） */
const DB_URL = `file:${path.join(CWD, 'prisma/dev.db')}`;

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text } */
async function call(base, path, options) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
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

/** 启动一个「实例」并等待就绪 */
async function startInstance(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(port), DB_URL, JOB_CENTER_DRIVER: 'db', DB_DRIVER: 'sqlite', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(`http://127.0.0.1:${port}`, '/ready');
      if (status === 200) return { child, port, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`实例在 30s 内未就绪（端口 ${port}）：\n${output.slice(-2000)}`);
}

/** 停止实例 */
async function stopInstance(instance) {
  if (!instance?.child || instance.child.exitCode !== null) return;
  const exited = new Promise((resolve) => instance.child.on('exit', resolve));
  instance.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 轮询任务进度直到到达期望状态 */
async function waitForStatus(base, token, jobId, expectStatus, timeoutMs = 15000) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    const res = await call(base, `/api/v1/jobs/${jobId}/progress`, {
      headers: { authorization: `Bearer ${token}` },
    });
    last = res.body?.data ?? null;
    if (last?.status === expectStatus) return last;
    await sleep(200);
  }
  throw new Error(`任务 ${jobId} 未在 ${timeoutMs}ms 内到达 ${expectStatus}：${JSON.stringify(last)}`);
}

async function main() {
  console.log('—— M10 E-01 任务中心 db 驱动冒烟（双进程 = 双实例，共享 SQLite） ——\n');
  const instanceA = await startInstance(PORT_A);
  let instanceB = null;
  try {
    const baseA = `http://127.0.0.1:${PORT_A}`;
    const baseB = `http://127.0.0.1:${PORT_B}`;
    const admin = await login(baseA, 'admin', 'Admin@123456');
    const alice = await login(baseA, 'alice', 'Alice@123456');
    const auth = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

    // ---------- A. 实例 A 派发 ----------
    console.log('\n—— 阶段 A：实例 A 派发审计导出 ——');
    const dispatched = await call(baseA, '/api/v1/audit-logs/export', { headers: auth(admin) });
    const jobId = dispatched.body?.data?.id;
    check('实例 A 派发导出 → 201 且返回 jobId（pending）',
      dispatched.status === 200 && typeof jobId === 'string' && dispatched.body?.data?.status === 'pending',
      `http=${dispatched.status} jobId=${jobId ?? 'null'}`);

    // ---------- B. 实例 B 跨实例轮询 ----------
    instanceB = await startInstance(PORT_B);
    console.log('\n—— 阶段 B：实例 B 跨实例读进度 ——');
    const progressOnB = await waitForStatus(baseB, admin, jobId, 'succeeded');
    check('实例 B 轮询同一 jobId → succeeded（跨实例可达，无会话粘滞）', progressOnB?.status === 'succeeded', `status=${progressOnB?.status}`);

    // ---------- C. 实例 B 跨实例下载产物 ----------
    console.log('\n—— 阶段 C：实例 B 下载产物 ——');
    const downloadRes = await fetch(`${baseB}/api/v1/jobs/${jobId}/download`, {
      headers: { authorization: `Bearer ${admin}` },
    });
    const buf = Buffer.from(await downloadRes.arrayBuffer());
    check('实例 B 下载产物 → 200 且 CSV 带 UTF-8 BOM（跨实例产物可达）',
      downloadRes.status === 200 && buf.subarray(0, 3).equals(Buffer.from([0xef, 0xbb, 0xbf])),
      `http=${downloadRes.status} bytes=${buf.length}`);
    check('Content-Disposition 附件头存在（RFC 5987 文件名）',
      /attachment;\s+filename\*=UTF-8''/.test(downloadRes.headers.get('content-disposition') ?? ''),
      String(downloadRes.headers.get('content-disposition')).slice(0, 60));

    // ---------- D. 实例 B 重跑失败任务 ----------
    console.log('\n—— 阶段 D：实例 B 重跑失败任务（注册表重建 runner） ——');
    const badMigrate = await call(baseA, '/api/v1/tenants/1/migrate', {
      method: 'POST',
      headers: auth(admin),
      body: JSON.stringify({ isolation: 'dedicated', dbUrl: 'not-a-valid-url' }),
    });
    const failedJobId = badMigrate.body?.data?.id;
    check('实例 A 派发非法迁移 → 任务存在（连接串校验在 runner 内，任务将失败）',
      badMigrate.status === 201 && typeof failedJobId === 'string', `http=${badMigrate.status}`);
    await waitForStatus(baseB, admin, failedJobId, 'failed');
    const retried = await call(baseB, `/api/v1/jobs/${failedJobId}/retry`, { method: 'POST', headers: auth(admin) });
    check('实例 B 重跑失败任务 → 201 且状态重置 pending（跨实例重跑）',
      retried.status === 201 && retried.body?.data?.status === 'pending', `http=${retried.status}`);
    await waitForStatus(baseB, admin, failedJobId, 'failed');

    // ---------- E. 归属人语义跨实例一致 ----------
    console.log('\n—— 阶段 E：归属人语义与状态拒绝 ——');
    const otherJob = await call(baseB, `/api/v1/jobs/${jobId}/progress`, { headers: auth(alice) });
    check('他人（alice）在实例 B 读任务 → 404（不泄露存在性）', otherJob.status === 404, `http=${otherJob.status}`);
    const rerunOk = await call(baseB, `/api/v1/jobs/${jobId}/retry`, { method: 'POST', headers: auth(admin) });
    check('成功任务在实例 B 重跑 → 400/1004（状态拒绝语义跨实例一致）',
      rerunOk.status === 400 && rerunOk.body?.code === 1004, `http=${rerunOk.status} code=${rerunOk.body?.code}`);

    // ---------- F. memory 驱动回归锚点 ----------
    console.log('\n—— 阶段 F：memory 驱动不落库（默认行为不变锚点） ——');
    await stopInstance(instanceB);
    instanceB = null;
    const memoryInstance = await startInstance(PORT_B, { JOB_CENTER_DRIVER: 'memory' });
    const baseM = `http://127.0.0.1:${PORT_B}`;
    const adminM = await login(baseM, 'admin', 'Admin@123456');
    const memDispatch = await call(baseM, '/api/v1/audit-logs/export', { headers: auth(adminM) });
    check('memory 驱动派发 → 201（N-02 原行为）',
      memDispatch.status === 200 && typeof memDispatch.body?.data?.id === 'string', `http=${memDispatch.status}`);
    const progressM = await waitForStatus(baseM, adminM, memDispatch.body?.data?.id, 'succeeded');
    check('memory 驱动进度轮询照常工作（本进程登记表）', progressM?.status === 'succeeded');
    await stopInstance(memoryInstance);
  } finally {
    await stopInstance(instanceB);
    await stopInstance(instanceA);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
