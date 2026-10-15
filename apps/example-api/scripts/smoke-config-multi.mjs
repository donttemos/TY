/**
 * @file M10 E-02 配置中心多实例语义冒烟脚本（PRD-010 AC2 进程级复现）
 * @description 两个独立进程（= 两个副本）共享同一 SQLite 库（快照历史持久层 config_snapshots）
 *   与同一本地事实源文件（file 驱动多实例 = 共享文件系统形态），验证：
 *   A. 实例 A（3760）API 写入 log.level=debug → 实例 B（3761）GET /configs 的 meta.snapshotVersion
 *      一致（持久层版本基线对齐，无需 B 本地写操作）；
 *   B. B 列表值经事实源轮询追上（共享文件 mtime 轮询 ≤ pollSeconds+1s）；
 *   C. B 实例 POST /configs/rollback（缺省回滚上一版）→ 生效；A 侧版本号与列表值一致跟进
 *      （回滚跨实例一致，回滚本身计入历史）；
 *   D. fail-fast 形态：CONFIG_CENTER_DRIVER=nacos 但缺 CONFIG_CENTER_NACOS_SERVER_ADDR → 启动即失败。
 *   前置：dev.db 已迁移并播种（`pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT_A = 3760;
const PORT_B = 3761;
const CWD = fileURLToPath(new URL('..', import.meta.url));
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

/** 启动实例（返回 null 表示在等待窗口内未就绪——用于 fail-fast 断言） */
async function startInstance(port, extraEnv = {}) {
  const runtimeFile = extraEnv.CONFIG_CENTER_FILE;
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(port), DB_URL, DB_DRIVER: 'sqlite', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    if (child.exitCode !== null) return { child, exited: true, output };
    try {
      const { status } = await call(`http://127.0.0.1:${port}`, '/ready');
      if (status === 200) return { child, exited: false, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
    if (runtimeFile && fs.existsSync(runtimeFile)) {
      // 事实源文件在启动期被创建属正常（首次写入前可能不存在），继续等就绪
    }
  }
  child.kill();
  return { child, exited: true, output };
}

/** 停止实例 */
async function stopInstance(instance) {
  if (!instance?.child || instance.child.exitCode !== null || instance.exited) return;
  const exited = new Promise((resolve) => instance.child.on('exit', resolve));
  instance.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 轮询直到条件成立 */
async function pollUntil(fn, timeoutMs = 10000, intervalMs = 300) {
  const start = Date.now();
  let last = null;
  while (Date.now() - start < timeoutMs) {
    last = await fn();
    if (last.ok) return last;
    await sleep(intervalMs);
  }
  return last;
}

async function main() {
  console.log('—— M10 E-02 配置中心多实例语义冒烟（双进程 = 双副本，共享 SQLite 历史 + 共享事实源文件） ——\n');
  const runtimeFile = path.join(os.tmpdir(), `fw-config-multi-${Date.now()}.json`);
  fs.writeFileSync(runtimeFile, JSON.stringify({}));

  const envShared = {
    CONFIG_CENTER_ENABLED: 'true',
    CONFIG_CENTER_POLL_SECONDS: '1',
    CONFIG_CENTER_FILE: runtimeFile,
  };
  const instanceA = await startInstance(PORT_A, envShared);
  let instanceB = null;
  try {
    check('实例 A 启动（CONFIG_CENTER_ENABLED=true + 持久历史）', !instanceA.exited);
    const baseA = `http://127.0.0.1:${PORT_A}`;
    const baseB = `http://127.0.0.1:${PORT_B}`;
    const admin = await login(baseA, 'admin', 'Admin@123456');
    const auth = (token) => ({ 'content-type': 'application/json', authorization: `Bearer ${token}` });

    // ---------- A. A 实例写入，B 实例版本一致 ----------
    console.log('\n—— 阶段 A：A 写入 → B 版本基线一致（AC2 前半） ——');
    const put = await call(baseA, '/api/v1/configs/log.level', {
      method: 'PUT',
      headers: auth(admin),
      body: JSON.stringify({ value: 'debug' }),
    });
    const aVersion = put.body?.data?.snapshotVersion;
    check('实例 A PUT log.level=debug → 生效且版本号递增',
      put.status === 200 && typeof aVersion === 'number', `http=${put.status} v=${aVersion}`);

    instanceB = await startInstance(PORT_B, envShared);
    check('实例 B 启动', !instanceB.exited);
    // B 的 meta 直接读持久层基线（syncRemoteVersion）——不要求 B 轮询追上后才一致
    const metaB = await call(baseB, '/api/v1/configs', { headers: auth(admin) });
    check('实例 B GET /configs 的 meta.snapshotVersion 与 A 写入后一致（持久层基线对齐）',
      metaB.status === 200 && metaB.body?.data?.meta?.snapshotVersion === aVersion,
      `A v=${aVersion} B v=${metaB.body?.data?.meta?.snapshotVersion}`);

    // ---------- B. B 列表值经轮询追上 ----------
    console.log('\n—— 阶段 B：B 列表值经事实源轮询追上 ——');
    const valueB = await pollUntil(async () => {
      const res = await call(baseB, '/api/v1/configs', { headers: auth(admin) });
      const entry = (res.body?.data?.configs ?? []).find((c) => c.key === 'log.level');
      return { ok: entry?.value === 'debug', value: entry?.value };
    });
    check('实例 B 列表 log.level=debug（共享文件 mtime 轮询生效）', valueB?.ok === true, `value=${valueB?.value}`);

    // ---------- C. B 实例回滚，A 侧一致跟进 ----------
    console.log('\n—— 阶段 C：B 回滚上一版 → A 一致（AC2 后半） ——');
    const rollbackB = await call(baseB, '/api/v1/configs/rollback', {
      method: 'POST',
      headers: auth(admin),
      body: JSON.stringify({}),
    });
    const rbVersion = rollbackB.body?.data?.snapshotVersion;
    check('实例 B POST /configs/rollback（缺省上一版）→ 200 且回滚后版本推进',
      rollbackB.status === 201 && typeof rbVersion === 'number' && rbVersion > aVersion,
      `http=${rollbackB.status} v=${rbVersion}`);
    // A 侧版本号与生效值一致跟进
    const metaA = await call(baseA, '/api/v1/configs', { headers: auth(admin) });
    check('实例 A GET meta.snapshotVersion 与 B 回滚后一致（跨实例一致）',
      metaA.body?.data?.meta?.snapshotVersion === rbVersion,
      `A v=${metaA.body?.data?.meta?.snapshotVersion} B v=${rbVersion}`);
    const valueA = await pollUntil(async () => {
      const res = await call(baseA, '/api/v1/configs', { headers: auth(admin) });
      const entry = (res.body?.data?.configs ?? []).find((c) => c.key === 'log.level');
      return { ok: entry?.value === 'info', value: entry?.value };
    });
    check('实例 A 列表 log.level 回到 env 基线 info（回滚生效跨实例可见）', valueA?.ok === true, `value=${valueA?.value}`);
    // 回滚后的事实源文件已恢复（目标覆盖集 = {}）
    const fileOverlay = JSON.parse(fs.readFileSync(runtimeFile, 'utf-8'));
    check('事实源文件回滚为空覆盖集（持久化目标 = 回滚目标）', Object.keys(fileOverlay).length === 0,
      `keys=${Object.keys(fileOverlay).length}`);

    // ---------- D. nacos fail-fast ----------
    console.log('\n—— 阶段 D：nacos 驱动 fail-fast 形态 ——');
    const badNacos = await startInstance(3762, {
      ...envShared,
      CONFIG_CENTER_DRIVER: 'nacos',
      CONFIG_CENTER_NACOS_SERVER_ADDR: '',
    });
    check('nacos 驱动缺 SERVER_ADDR → 启动即失败（fail-fast）',
      badNacos.exited === true && /CONFIG_CENTER_NACOS_SERVER_ADDR/.test(badNacos.output ?? ''),
      String(badNacos.output ?? '').slice(-120).replace(/\n/g, ' '));
  } finally {
    await stopInstance(instanceB);
    await stopInstance(instanceA);
    try {
      fs.unlinkSync(runtimeFile);
    } catch {
      /* 清理失败不影响结果 */
    }
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
