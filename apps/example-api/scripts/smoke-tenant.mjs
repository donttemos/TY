/**
 * @file M8 多租户冒烟验证脚本（PRD-008 FR-01/FR-03）
 * @description 自带服务生命周期，分阶段验证租户层（TC-TNT-001/002/003 的可执行子集）：
 *   A. 多租户启用（TENANT_ENABLED=true + TENANT_BASE_DOMAIN=example.com）：
 *      A1 fail-closed——无租户标识的请求直接 403（AC：缺失上下文不返回全量数据）；
 *      A2 请求头回退——X-Tenant-Id: legacy 命中存量租户，admin 登录与业务查询正常；
 *      A3 子域名回退——Host: acme.example.com 解析到 acme 租户，acmeadmin 登录成功；
 *      A4 未知编码 / 停用租户均 403；
 *      A5 跨租户越权——acmeadmin（tenantId=1）携带 legacy 请求头被守卫拦截（AC：租户 A 无法访问租户 B）；
 *      A6 运维路径豁免——/health / /ready 无租户标识仍可用（与 @fw/auth 默认公开路径对齐）。
 *   B. 回归：TENANT_ENABLED=false 时无租户标识全部接口正常（单租户模式与 M7 行为一致）。
 *   说明：@fw/db 的 tenantScoped fail-closed 与 @fw/auth 的 @IgnoreTenant 审计由框架单测覆盖
 *      （db/repository-suite、auth/rbac.guard.test），本脚本聚焦 HTTP 层端到端行为。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api
 */

import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import http from 'node:http';
import { fileURLToPath } from 'node:url';

/** 冒烟专用端口（避开 3000/3100/3200 的既有实例） */
const PORT = 3300;
const BASE = `http://127.0.0.1:${PORT}`;
/** 应用目录（dist/main.js 所在） */
const CWD = fileURLToPath(new URL('..', import.meta.url));

const results = [];

/** 成功状态码（登录等控制器按 POST 语义返回 201） */
const isOk = (status) => status >= 200 && status < 300;

/** 记录并打印一项断言 */
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  ${detail}` : ''}`);
}

/** HTTP 请求：返回 { status, body, text } */
async function call(path, options) {
  const res = await fetch(BASE + path, options);
  const text = await res.text();
  let body = {};
  try {
    body = JSON.parse(text);
  } catch {
    body = {};
  }
  return { status: res.status, body, text };
}

/** 登录并返回 access token（账号字段名为 account，与 @fw/auth 登录契约一致） */
async function login(account, password, headers = {}) {
  const res = await call('/api/v1/auth/login', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify({ account, password }),
  });
  return res;
}

/**
 * 原生 http 请求：Node fetch（undici）会按 URL 覆盖 Host 头，
 * 子域名回退（acme.example.com）必须用原生 http 才能控制 Host。
 */
function callWithHost(path, options = {}, host) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      `${BASE}${path}`,
      { method: options.method ?? 'GET', headers: { ...(options.headers ?? {}), host } },
      (res) => {
        let text = '';
        res.on('data', (chunk) => {
          text += chunk;
        });
        res.on('end', () => {
          let body = {};
          try {
            body = JSON.parse(text);
          } catch {
            body = {};
          }
          resolve({ status: res.statusCode, body, text });
        });
      },
    );
    req.on('error', reject);
    if (options.body) req.write(options.body);
    req.end();
  });
}

/** 启动服务并等待就绪，输出写入内存以便失败时定位 */
async function startServer(env) {
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: CWD,
    env: { ...process.env, APP_PORT: String(PORT), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  child.stdout.on('data', (d) => {
    output += d.toString();
  });
  child.stderr.on('data', (d) => {
    output += d.toString();
  });
  for (let i = 0; i < 60; i++) {
    try {
      const { status } = await call('/health');
      if (status === 200) return { child, output: () => output };
    } catch {
      /* 未就绪，继续等待 */
    }
    await sleep(500);
  }
  child.kill();
  throw new Error(`服务在 30s 内未就绪（端口 ${PORT}）：\n${output.slice(-2000)}`);
}

/** 停止服务并等待退出 */
async function stopServer(server) {
  if (!server?.child || server.child.exitCode !== null) return;
  const exited = new Promise((resolve) => server.child.on('exit', resolve));
  server.child.kill();
  await Promise.race([exited, sleep(5000)]);
}

/** 阶段 A：多租户启用（fail-closed + 三级回退 + 越权拦截） */
async function phaseEnabled() {
  console.log('\n=== 阶段 A：多租户启用（TENANT_ENABLED=true，TC-TNT-001/003）===');
  const server = await startServer({
    TENANT_ENABLED: 'true',
    TENANT_BASE_DOMAIN: 'example.com',
    TENANT_ORDER: 'subdomain,header,jwt',
  });
  try {
    // A1 fail-closed：无租户标识 → 403（AC：缺失上下文查询直接失败）
    const noTenant = await call('/api/v1/demo-items');
    check('A1 无租户标识访问业务接口返回 403（fail-closed）', noTenant.status === 403, `[http=${noTenant.status}]`);
    check('A1 错误码为 4001（TENANT_INVALID）', noTenant.body?.code === 4001, `[code=${noTenant.body?.code}]`);

    // A2 请求头回退：legacy 租户（存量数据归属），admin（tenantId=0）可登录
    const legacyLogin = await login('admin', 'Admin@123456', { 'x-tenant-id': 'legacy' });
    check('A2 请求头回退命中 legacy 租户并登录成功', isOk(legacyLogin.status), `[http=${legacyLogin.status}]`);
    const adminToken = legacyLogin.body?.data?.accessToken;
    check('A2 返回 access token', typeof adminToken === 'string' && adminToken.length > 0);
    const list = await call('/api/v1/demo-items', { headers: { authorization: `Bearer ${adminToken}`, 'x-tenant-id': 'legacy' } });
    check('A2 legacy 租户内业务查询正常', list.status === 200, `[http=${list.status}]`);

    // A3 子域名回退：Host: acme.example.com → acme 租户（id=1）
    const acmeLogin = await callWithHost('/api/v1/auth/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ account: 'acmeadmin', password: 'Acme@123456' }),
    }, 'acme.example.com');
    check('A3 子域名回退命中 acme 租户并登录成功', isOk(acmeLogin.status), `[http=${acmeLogin.status}]`);
    const acmeToken = acmeLogin.body?.data?.accessToken;
    check('A3 返回 acme access token', typeof acmeToken === 'string' && acmeToken.length > 0);
    const acmeList = await callWithHost('/api/v1/demo-items', { headers: { authorization: `Bearer ${acmeToken}` } }, 'acme.example.com');
    check('A3 acme 租户内业务查询正常', acmeList.status === 200, `[http=${acmeList.status}]`);

    // A4 未知编码与停用租户均 403
    const unknown = await call('/api/v1/demo-items', { headers: { 'x-tenant-id': 'ghost' } });
    check('A4 未知租户编码返回 403', unknown.status === 403, `[http=${unknown.status}]`);
    const disabled = await call('/api/v1/demo-items', { headers: { 'x-tenant-id': 'off' } });
    check('A4 停用租户返回 403', disabled.status === 403, `[http=${disabled.status}]`);

    // A5 跨租户越权：acmeadmin 携带 legacy 租户头被守卫拦截（AC：租户 A 用户无法访问租户 B）
    const cross = await call('/api/v1/demo-items', {
      headers: { authorization: `Bearer ${acmeToken}`, 'x-tenant-id': 'legacy' },
    });
    check('A5 跨租户访问被守卫拦截返回 403', cross.status === 403, `[http=${cross.status}]`);
    check('A5 错误码为 4001', cross.body?.code === 4001, `[code=${cross.body?.code}]`);

    // A6 运维路径豁免：/health、/ready 无租户标识仍可用
    const health = await call('/health');
    const ready = await call('/ready');
    check('A6 /health 无租户标识可用', health.status === 200, `[http=${health.status}]`);
    check('A6 /ready 无租户标识可用', ready.status === 200 || ready.status === 503, `[http=${ready.status}]`);
  } finally {
    await stopServer(server);
  }
}

/** 阶段 B：回归（TENANT_ENABLED=false 单租户模式与 M7 行为一致） */
async function phaseDisabled() {
  console.log('\n=== 阶段 B：单租户模式回归（TENANT_ENABLED=false）===');
  const server = await startServer({});
  try {
    const loginRes = await login('admin', 'Admin@123456');
    check('B1 单租户模式无租户标识登录正常', isOk(loginRes.status), `[http=${loginRes.status}]`);
    const token = loginRes.body?.data?.accessToken;
    const list = await call('/api/v1/demo-items', { headers: { authorization: `Bearer ${token}` } });
    check('B2 带令牌查询无需租户标识', list.status === 200, `[http=${list.status}]`);
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await phaseEnabled();
  await phaseDisabled();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.error('失败项：');
    for (const item of failed) console.error(` - ${item.name}`);
    process.exit(1);
  }
}

main().catch((error) => {
  console.error('冒烟执行异常:', error);
  process.exit(1);
});
