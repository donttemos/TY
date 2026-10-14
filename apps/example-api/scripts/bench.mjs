/**
 * @file M8 压测基线脚本（PRD-008 FR-11 / AC：「压测基线报告可复现，登录/列表/写入三类场景有明确 QPS 与 P95」）
 * @description 自带服务生命周期，对 example-api 跑三类场景并输出可复现的基线数值：
 *   A. 登录（POST /api/v1/auth/login）——注意 @fw/auth 默认登录限流为 60s/10 次（按 IP），
 *      故本场景默认 10 次请求（正好在窗口内），并额外发 1 次验证第 11 次被限流（429/9003），
 *      既取到登录延迟基线，又证明限流生效；
 *   B. 列表查询（GET /api/v1/demo/items）——分页查询，默认 300 次 / 并发 10；
 *   C. 写入（POST /api/v1/demo/items）——默认 200 次 / 并发 5（SQLite 写锁敏感，并发保守）。
 *   输出：每场景 requests / 成功率 / QPS / P50 / P95 / P99（毫秒），并落盘 JSON 报告。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** 压测专用端口（避开 3000/3100/3200/3300/3400x/3500/3600x） */
const PORT = 3700;
const BASE = `http://127.0.0.1:${PORT}`;
const CWD = fileURLToPath(new URL('..', import.meta.url));
const ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** 命令行参数解析：--requests=N / --concurrency=C / --scenario=all|login|list|write */
function parseArgs(argv) {
  const opts = { requests: null, concurrency: null, scenario: 'all' };
  for (const a of argv.slice(2)) {
    const m = /^--([\w-]+)=(.*)$/.exec(a);
    if (!m) continue;
    if (m[1] === 'requests') opts.requests = Number(m[2]);
    if (m[1] === 'concurrency') opts.concurrency = Number(m[2]);
    if (m[1] === 'scenario') opts.scenario = m[2];
  }
  return opts;
}

const opts = parseArgs(process.argv);

/** 启动服务并等待就绪 */
async function startServer(env) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => (output += d.toString()));
  child.stderr.on('data', (d) => (output += d.toString()));
  for (let i = 0; i < 80; i++) {
    try {
      const res = await fetch(`${BASE}/health`);
      if (res.status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务 40s 内未就绪：\n${output.slice(-1200)}`);
}

async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((r) => server.child.on('exit', r));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 单次请求，返回 { ok, status, ms } */
async function once(urlPath, init) {
  const t0 = performance.now();
  try {
    const res = await fetch(BASE + urlPath, init);
    await res.arrayBuffer();
    return { ok: res.status >= 200 && res.status < 300, status: res.status, ms: performance.now() - t0 };
  } catch {
    return { ok: false, status: 0, ms: performance.now() - t0 };
  }
}

/**
 * 并发压测：固定总请求数，concurrency 个 worker 轮流取任务
 * @returns { requests, ok, failed, errorRate, qps, p50, p95, p99, max, elapsedMs, statuses }
 */
async function load(urlPath, init, total, concurrency) {
  const latencies = [];
  const statuses = {};
  let cursor = 0;
  const t0 = performance.now();
  const worker = async () => {
    for (;;) {
      const idx = cursor++;
      if (idx >= total) return;
      const r = await once(urlPath, init);
      latencies.push(r.ms);
      statuses[r.status] = (statuses[r.status] ?? 0) + 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
  const elapsedMs = performance.now() - t0;
  const sorted = [...latencies].sort((a, b) => a - b);
  const pct = (p) => (sorted.length ? Number(sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)].toFixed(2)) : 0);
  const ok = Object.entries(statuses).filter(([s]) => Number(s) >= 200 && Number(s) < 300).reduce((n, [, c]) => n + c, 0);
  return {
    requests: total,
    ok,
    failed: total - ok,
    errorRate: Number(((total - ok) / total).toFixed(4)),
    qps: Number((total / (elapsedMs / 1000)).toFixed(1)),
    p50: pct(50),
    p95: pct(95),
    p99: pct(99),
    max: Number(Math.max(...sorted, 0).toFixed(2)),
    elapsedMs: Math.round(elapsedMs),
    statuses,
  };
}

/** 打印单项结果 */
function report(name, r) {
  console.log(
    `${name.padEnd(16)} requests=${String(r.requests).padStart(4)} ok=${String(r.ok).padStart(4)} ` +
      `qps=${String(r.qps).padStart(7)} p50=${String(r.p50).padStart(7)}ms p95=${String(r.p95).padStart(7)}ms ` +
      `p99=${String(r.p99).padStart(7)}ms max=${String(r.max).padStart(7)}ms 状态=${JSON.stringify(r.statuses)}`,
  );
}

async function main() {
  console.log('=== M8 压测基线（PRD-008 FR-11）===');
  const server = await startServer({
    APP_ENV: 'dev',
    DB_DRIVER: process.env.BENCH_DB_DRIVER ?? 'sqlite',
    DB_URL: process.env.BENCH_DB_URL ?? 'file:./dev.db',
    CACHE_DRIVER: 'memory',
    MQ_DRIVER: 'memory',
    TENANT_ENABLED: 'false',
    LOG_LEVEL: 'error',
  });

  const reportData = { generatedAt: new Date().toISOString(), port: PORT, scenarios: {} };
  try {
    const loginBody = JSON.stringify({ account: 'admin', password: 'Admin@123456' });
    const loginInit = { method: 'POST', headers: { 'content-type': 'application/json' }, body: loginBody };
    const writeInit = () => ({
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: `bench-${Date.now()}` }),
    });

    if (opts.scenario === 'all' || opts.scenario === 'login') {
      // 登录：默认 10 次（限流窗口内），并发 2
      const n = opts.requests ?? 10;
      const c = opts.concurrency ?? 2;
      const r = await load('/api/v1/auth/login', loginInit, n, c);
      report('登录', r);
      reportData.scenarios.login = r;
      // 限流验证：紧接再发 1 次，应被 429/9003 拦下
      const throttled = await once('/api/v1/auth/login', loginInit);
      console.log(`  限流验证（第 ${n + 1} 次）：status=${throttled.status} ${throttled.status === 429 ? '（限流生效 ✓）' : '（未触发，可能窗口已滑过）'}`);
      reportData.scenarios.loginThrottle = { nth: n + 1, status: throttled.status };
    }

    if (opts.scenario === 'all' || opts.scenario === 'list') {
      const n = opts.requests ?? 300;
      const c = opts.concurrency ?? 10;
      const r = await load('/api/v1/demo/items?page=1&pageSize=20', {}, n, c);
      report('列表查询', r);
      reportData.scenarios.list = r;
    }

    if (opts.scenario === 'all' || opts.scenario === 'write') {
      const n = opts.requests ?? 200;
      const c = opts.concurrency ?? 5;
      const r = await load('/api/v1/demo/items', writeInit(), n, c);
      report('写入', r);
      reportData.scenarios.write = r;
    }
  } finally {
    await stopServer(server);
  }

  const outDir = path.join(ROOT, 'docs', 'bench');
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'bench-latest.json');
  fs.writeFileSync(outFile, JSON.stringify(reportData, null, 2));
  console.log(`\n报告已写入 ${path.relative(ROOT, outFile)}`);

  // 门禁：三类场景均须有明确数值且错误率可控（写入在 SQLite 并发下允许少量锁冲突）
  const s = reportData.scenarios;
  const fail = [];
  if (s.login && s.login.errorRate > 0) fail.push('登录存在失败请求');
  if (s.list && s.list.errorRate > 0.01) fail.push('列表查询错误率 > 1%');
  if (s.write && s.write.errorRate > 0.05) fail.push('写入错误率 > 5%');
  if (fail.length) {
    console.log('压测门禁未通过：', fail.join('；'));
    process.exit(1);
  }
  console.log('压测门禁通过：三类场景均有可复现的 QPS 与 P95 数值。');
}

main();
