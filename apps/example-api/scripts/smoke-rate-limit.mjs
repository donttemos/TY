/**
 * @file M10 E-03 框架级限流冒烟脚本（PRD-010 AC3）
 * @description 自带服务生命周期（端口 3770/3771），小容量 env 覆盖（RATE_LIMIT_CAPACITY=5、
 *   REFILL=1）验证：令牌桶耗尽 → 429/9003 信封形态 + Retry-After 头；豁免白名单（health/ready/
 *   metrics）在超限状态下不受影响；/metrics 出现 fw_rate_limit_* 计数段；dry-run 形态全放行。
 *   前置：dev.db 已迁移并播种（`pnpm exec tsx prisma/seed.ts`）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PORT_MAIN = 3770;
const PORT_DRY = 3771;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const DB_URL = `file:${path.join(CWD, 'prisma/dev.db')}`;

const results = [];

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, headers, text } */
async function call(base, path, options) {
  const res = await fetch(base + path, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, headers: res.headers, text };
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

/** 启动实例 */
async function startInstance(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(port), DB_URL, DB_DRIVER: 'sqlite', ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call(`http://127.0.0.1:${port}`, '/health');
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

async function main() {
  console.log('—— M10 E-03 框架级限流冒烟（容量 5 / 每秒补充 1） ——\n');
  const instance = await startInstance(PORT_MAIN, {
    RATE_LIMIT_CAPACITY: '5',
    RATE_LIMIT_REFILL_PER_SECOND: '1',
  });
  try {
    const base = `http://127.0.0.1:${PORT_MAIN}`;
    const admin = await login(base, 'admin', 'Admin@123456');
    check('登录成功（登录请求自身也受容量约束——容量 5 内完成）', typeof admin === 'string' && admin.length > 20);
    const auth = { 'content-type': 'application/json', authorization: `Bearer ${admin}` };

    // ---------- A. 令牌桶耗尽 → 429/9003 ----------
    console.log('\n—— 阶段 A：连打耗尽令牌桶 ——');
    const statuses = [];
    for (let i = 0; i < 10; i++) {
      const res = await call(base, '/api/v1/dict/user_status', { headers: auth });
      statuses.push(res);
      await sleep(30);
    }
    const okCount = statuses.filter((r) => r.status === 200).length;
    const limited = statuses.find((r) => r.status === 429);
    check(`连打 10 次 → 混合 200/429（桶容量 5，同秒补充不足）`, okCount >= 1 && okCount <= 5 && !!limited,
      `200×${okCount} 429×${statuses.length - okCount}`);
    check('429 信封形态：code=9003 + details 顶层（与统一异常过滤同形）',
      limited?.body?.code === 9003 && Array.isArray(limited.body?.details) && limited.body?.data === null,
      `code=${limited?.body?.code}`);
    check('429 携带 Retry-After 头（秒，向上取整）',
      Number(limited?.headers?.get?.('retry-after') ?? limited?.headers?.get?.('Retry-After') ?? 0) >= 1,
      `retry-after=${limited?.headers?.get?.('retry-after') ?? limited?.headers?.get?.('Retry-After')}`);

    // ---------- B. 白名单豁免 ----------
    console.log('\n—— 阶段 B：豁免白名单在超限状态下不受影响 ——');
    const health = await call(base, '/health');
    const ready = await call(base, '/ready');
    const metrics = await call(base, '/metrics');
    check('超限状态下 /health、/ready、/metrics 仍 200（RATE_LIMIT_WHITELIST 默认豁免）',
      health.status === 200 && ready.status === 200 && metrics.status === 200,
      `health=${health.status} ready=${ready.status} metrics=${metrics.status}`);
    const metricsText = metrics.text ?? '';
    check('/metrics 出现限流计数段（fw_rate_limit_denied_total ≥ 1）',
      metricsText.includes('fw_rate_limit_denied_total') &&
        Number((metricsText.match(/fw_rate_limit_denied_total (\d+)/) ?? [])[1] ?? 0) >= 1,
      (metricsText.match(/fw_rate_limit_denied_total \d+/) ?? ['n/a'])[0]);

    // ---------- C. dry-run 形态 ----------
    console.log('\n—— 阶段 C：dry-run 灰度形态（仅计数不拦截） ——');
    const dry = await startInstance(PORT_DRY, {
      RATE_LIMIT_CAPACITY: '3',
      RATE_LIMIT_REFILL_PER_SECOND: '1',
      RATE_LIMIT_DRY_RUN: 'true',
    });
    try {
      const baseDry = `http://127.0.0.1:${PORT_DRY}`;
      const adminDry = await login(baseDry, 'admin', 'Admin@123456');
      const dryStatuses = [];
      for (let i = 0; i < 8; i++) {
        const res = await call(baseDry, '/api/v1/dict/user_status', {
          headers: { 'content-type': 'application/json', authorization: `Bearer ${adminDry}` },
        });
        dryStatuses.push(res.status);
        await sleep(30);
      }
      check('dry-run 下连打 8 次 → 全部 200（超限仅计数告警不拦截）',
        dryStatuses.every((code) => code === 200), `statuses=${dryStatuses.join(',')}`);
      const dryMetrics = await call(baseDry, '/metrics');
      const dryPassed = Number((dryMetrics.text.match(/fw_rate_limit_dry_run_passed_total (\d+)/) ?? [])[1] ?? 0);
      check('dry-run 计数进 /metrics（fw_rate_limit_dry_run_passed_total ≥ 1）', dryPassed >= 1, `passed=${dryPassed}`);
    } finally {
      await stopInstance(dry);
    }
  } finally {
    await stopInstance(instance);
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (passed !== results.length) process.exit(1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
