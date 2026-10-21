/**
 * @file M8 多租户冒烟验证脚本（PRD-008 FR-01/FR-02/FR-03）
 * @description 自带服务生命周期，分阶段验证租户层（TC-TNT-001/002/003 的可执行子集）：
 *   A. 多租户启用（TENANT_ENABLED=true + TENANT_BASE_DOMAIN=example.com）：
 *      A1 fail-closed——无租户标识的请求直接 403（AC：缺失上下文不返回全量数据）；
 *      A2 请求头回退——X-Tenant-Id: legacy 命中存量租户，admin 登录与业务查询正常；
 *      A3 子域名回退——Host: acme.example.com 解析到 acme 租户，acmeadmin 登录成功；
 *      A4 未知编码 / 停用租户均 403；
 *      A5 跨租户越权——acmeadmin（tenantId=1）携带 legacy 请求头被守卫拦截（AC：租户 A 无法访问租户 B）；
 *      A6 运维路径豁免——/health / /ready 无租户标识仍可用（与 @fw/auth 默认公开路径对齐）。
 *   B. 回归：TENANT_ENABLED=false 时无租户标识全部接口正常（单租户模式与 M7 行为一致）。
 *   C. dedicated 独立库路由（T-M8-02 / TC-TNT-003）：dedicated 租户经 /api/v1/demo/tenant-items
 *      的读写落在 prisma/tenant-dedicated.db（独立物理库），共享库内查无此数据；
 *      未携带租户标识仍 fail-closed。
 *   D. 数据权限四档（T-M8-04 / TC-TNT-004）：all / org / org_below / self 四档列表精确集合断言，
 *      及 org 范围外 / org_below 旁支 / self 他人的详情越权拦截（403+3002）。
 *      部门树：总部 → 研发部(rd) → 前端组(rd-fe：alice/dave/erin) / 后端组(rd-be：frank)；总部 → 市场部(mkt：grace)。
 *      org_below(研发部) 期望集合含前端组与后端组成员，即 {alice,bob,carol,dave,erin,frank}。
 *   E. 审计租户隔离（PRD-015 AC-15-07/09）：多租户启用下用**两个真实租户账号**验证——
 *      acmeauditor（acme 租户，audit:read/export，dataScope=all，无 system:tenant:ignore）作为
 *      「普通租户管理员」，admin（legacy + 平台维护码）作为「平台维护管理员」：
 *      E1 普通列表只含当前租户行；E2 tenant_id 只能同值（他租户 4001）；E3 详情跨租户 404；
 *      E4 导出产物不含他租户记录；E5 维护入口可跨租户检索/收窄/读详情；E6 普通账号访问维护入口 3002；
 *      E7 平台导出产物跨租户。导出任务**跨实例重跑**不丢租户限制由集成用例
 *      `audit-tenant-isolation.integration.spec.ts`（jobRunnerRegistry 工厂 + 真实库）取证，HTTP 层无法触发。
 *   说明：@fw/db 的 tenantScoped fail-closed 与 @fw/auth 的 @IgnoreTenant 审计由框架单测覆盖
 *      （db/repository-suite、auth/rbac.guard.test），本脚本聚焦 HTTP 层端到端行为。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-02 新增阶段 C（dedicated 独立库路由端到端验证）
 * @modified 2026-10-14 donttemo M8 T-M8-04 新增阶段 D（数据权限四档 + 详情越权校验）
 * @modified 2026-10-21 donttemo P2 新增阶段 E（审计租户隔离双账号验收，PRD-015 AC-15-07/09）：
 *   补齐「多租户仅有单测、没有双账号 HTTP 端到端」的缺口；配套种子新增 tenant_auditor 角色与
 *   acmeauditor 账号（tenantId=1，无跨租户维护码）
 * @module example-api
 */

import { spawn, execFile } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { promisify } from 'node:util';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);

/** 冒烟专用端口（避开 3000/3100/3200/3300 的既有实例） */
const PORT = 3300;
const BASE = `http://127.0.0.1:${PORT}`;
/** 应用目录（dist/main.js 所在） */
const CWD = fileURLToPath(new URL('..', import.meta.url));
/** dedicated 租户独立库（与主库同 schema；相对路径按 prisma/schema.prisma 目录解析） */
const DEDICATED_DB = path.join(CWD, 'prisma', 'tenant-dedicated.db');

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

/**
 * 重建 dedicated 独立库结构：删旧库 → 以主 schema 的副本（仅替换数据源）执行 db push。
 * 副本 schema 放在 prisma/ 下，其 `file:./tenant-dedicated.db` 与运行时的绝对 URL 指向同一文件。
 */
async function resetDedicatedDb() {
  if (fs.existsSync(DEDICATED_DB)) fs.rmSync(DEDICATED_DB);
  const schema = fs.readFileSync(path.join(CWD, 'prisma', 'schema.prisma'), 'utf8');
  const patched = schema.replace(/url\s*=\s*env\("DB_URL"\)/, 'url = "file:./tenant-dedicated.db"');
  if (!patched.includes('file:./tenant-dedicated.db')) {
    throw new Error('dedicated schema 数据源替换失败：未找到 DB_URL 占位');
  }
  const tmpSchema = path.join(CWD, 'prisma', 'smoke-dedicated.prisma');
  fs.writeFileSync(tmpSchema, patched);
  try {
    await execFileAsync(
      process.execPath,
      [path.join(CWD, 'node_modules', 'prisma', 'build', 'index.js'), 'db', 'push', '--schema', tmpSchema, '--skip-generate'],
      { cwd: CWD },
    );
  } finally {
    fs.rmSync(tmpSchema, { force: true });
  }
  if (!fs.existsSync(DEDICATED_DB)) throw new Error('dedicated 独立库未创建（db push 未生成文件）');
}

/** 阶段 C：dedicated 独立库路由（T-M8-02 / TC-TNT-003） */
async function phaseDedicated() {
  console.log('\n=== 阶段 C：dedicated 独立库路由（TC-TNT-003）===');
  await resetDedicatedDb();
  const { PrismaClient } = await import('@prisma/client');
  const mainDb = new PrismaClient({ datasources: { db: { url: 'file:./dev.db' } } });
  const server = await startServer({
    TENANT_ENABLED: 'true',
    TENANT_BASE_DOMAIN: 'example.com',
    TENANT_ORDER: 'subdomain,header,jwt',
  });
  try {
    // C1 登录 dedicated 租户管理员（账号在共享库，业务数据走独立库）
    const loginRes = await login('dedicatedadmin', 'Dedicated@123456', { 'x-tenant-id': 'dedicated' });
    check('C1 dedicated 租户管理员登录成功', isOk(loginRes.status), `[http=${loginRes.status}]`);
    const token = loginRes.body?.data?.accessToken;
    check('C1 返回 access token', typeof token === 'string' && token.length > 0);

    // C2 写入：dedicated 租户的创建请求落在独立库
    const marker = `dedicated-smoke-${Date.now()}`;
    const created = await call('/api/v1/demo/tenant-items', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'dedicated', 'content-type': 'application/json' },
      body: JSON.stringify({ title: marker }),
    });
    check('C2 dedicated 租户写入成功', isOk(created.status), `[http=${created.status}]`);
    const createdId = created.body?.data?.id;
    check('C2 返回新建条目 ID', typeof createdId === 'string' && createdId.length > 0);

    // C3 读取：dedicated 租户列表只见独立库内的数据（ freshly pushed 库，仅本条）
    const list = await call('/api/v1/demo/tenant-items?page=1&pageSize=100', {
      headers: { authorization: `Bearer ${token}`, 'x-tenant-id': 'dedicated' },
    });
    const items = list.body?.data?.items ?? [];
    check('C3 dedicated 租户列表查询成功', list.status === 200, `[http=${list.status}]`);
    check('C3 列表只含独立库数据（total=1）', list.body?.data?.total === 1, `[total=${list.body?.data?.total}]`);
    check('C3 新建条目在独立库列表中可见', items.some((item) => item.id === createdId));

  // C4 反向验证：共享库（主库）中查无此条（物理隔离）
  // 相对 sqlite 路径按 schema 目录解析（与主库 DB_URL 同语义），冒烟进程 cwd 无关
  const inMain = await mainDb.demoItem.findFirst({ where: { title: marker } });
    check('C4 共享库中不存在 dedicated 租户数据', inMain === null, `[found=${inMain?.id ?? 'null'}]`);
    const dedicatedCount = await mainDb.tenant.count({ where: { code: 'dedicated' } });
    check('C4 主库 tenants 表仍登记 dedicated 租户元数据', dedicatedCount === 1, `[count=${dedicatedCount}]`);

    // C5 fail-closed 不退化：dedicated 租户请求缺失租户标识仍 403（不回退共享库）
    const noTenant = await call('/api/v1/demo/tenant-items', { headers: { authorization: `Bearer ${token}` } });
    check('C5 缺失租户标识返回 403（fail-closed）', noTenant.status === 403, `[http=${noTenant.status}]`);
    check('C5 错误码为 4001', noTenant.body?.code === 4001, `[code=${noTenant.body?.code}]`);

    // C6 共享库租户不受影响：legacy 管理员看到的列表中没有 dedicated 数据
    const legacyLogin = await login('admin', 'Admin@123456', { 'x-tenant-id': 'legacy' });
    const legacyToken = legacyLogin.body?.data?.accessToken;
    const legacyList = await call('/api/v1/demo/tenant-items?page=1&pageSize=100', {
      headers: { authorization: `Bearer ${legacyToken}`, 'x-tenant-id': 'legacy' },
    });
    const legacyItems = legacyList.body?.data?.items ?? [];
    check('C6 共享库列表不含 dedicated 数据', !legacyItems.some((item) => item.id === createdId));
    check('C6 共享库列表仍含种子数据', legacyList.body?.data?.total >= 3, `[total=${legacyList.body?.data?.total}]`);
  } finally {
    await stopServer(server);
    await mainDb.$disconnect();
  }
}

/** 用户列表查询（pageSize=100 一页取全，四档集合断言用） */
async function listUsers(token) {
  return call('/api/v1/users?page=1&pageSize=100', { headers: { authorization: `Bearer ${token}` } });
}

/** 启用 / 禁用账号（详情越权校验目标端点） */
async function setUserStatus(token, userId, status) {
  return call(`/api/v1/users/${userId}/status`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ status }),
  });
}

/** 列表项用户名集合（排序后比较，避免顺序不稳定） */
function namesOf(list) {
  return (list.body?.data?.items ?? []).map((item) => item.username).sort();
}

/**
 * 阶段 D：数据权限四档（T-M8-04 / TC-TNT-004，PRD-008 FR-04/FR-05）
 * 单租户模式（TENANT_ENABLED=false，与阶段 B 同环境）验证：
 *   D1  all       —— admin 见全部账号；
 *   D2  self      —— selfscope 仅本人一条；
 *   D3  org       —— carol（研发部）仅见研发部成员 {bob, carol}（不含下级前端组/后端组）；
 *   D4  org       —— dave（前端组）仅见前端组成员 {alice, dave, erin}；
 *   D5  org_below —— bob（研发部）见部门及下级 {bob, carol, dave, erin, frank}；
 *   D6~D8 详情越权 —— org 范围外 / org_below 旁支 / self 他人一律 403+3002（fail-closed）；
 *   D9  org_below 范围内放行（bob 改 frank 禁用后即时恢复）；
 *   D10 审计收敛 —— org_below 档审计列表只见部门子树成员记录。
 */
async function phaseDataScope() {
  console.log('\n=== 阶段 D：数据权限四档（TC-TNT-004）===');
  const server = await startServer({});
  try {
    // D0 集中登录五个代表性账号（先取令牌，避免后续禁用操作失效）
    const tokens = {};
    const accounts = [
      ['admin', 'admin', 'Admin@123456'],
      ['selfscope', 'selfscope', 'Self@123456'],
      ['carol', 'carol', 'Carol@123456'],
      ['dave', 'dave', 'Dave@123456'],
      ['bob', 'bob', 'Bob@123456'],
    ];
    for (const [name, account, password] of accounts) {
      const res = await login(account, password);
      check(`D0 ${name} 登录成功`, isOk(res.status), `[http=${res.status}]`);
      tokens[name] = res.body?.data?.accessToken;
    }

    // D1 all：admin 见全部账号（含租户账号；单租户模式不按租户过滤，与 M3 基线一致）
    const adminList = await listUsers(tokens.admin);
    const adminNames = namesOf(adminList);
    check('D1 all 档列表查询成功', adminList.status === 200, `[http=${adminList.status}]`);
    check(
      'D1 all 档可见全部种子账号（9 个 legacy + 2 个租户账号）',
      ['admin', 'alice', 'bob', 'carol', 'dave', 'erin', 'frank', 'grace', 'selfscope', 'acmeadmin', 'dedicatedadmin'].every((n) => adminNames.includes(n)),
      `[names=${adminNames.join(',')}]`,
    );
    const idOf = (name) => (adminList.body?.data?.items ?? []).find((item) => item.username === name)?.id;

    // D2 self：仅本人一条
    const selfList = await listUsers(tokens.selfscope);
    check('D2 self 档列表仅本人一条', selfList.status === 200 && selfList.body?.data?.total === 1 && namesOf(selfList)[0] === 'selfscope',
      `[total=${selfList.body?.data?.total}]`);

    // D3 org（carol@研发部）：仅研发部成员，不含下级部门
    const carolList = await listUsers(tokens.carol);
    check('D3 org 档列表=本部门成员 {bob,carol}', carolList.status === 200 && JSON.stringify(namesOf(carolList)) === JSON.stringify(['bob', 'carol']),
      `[names=${namesOf(carolList).join(',')}]`);

    // D4 org（dave@前端组）：仅前端组成员
    const daveList = await listUsers(tokens.dave);
    check('D4 org 档列表=本部门成员 {alice,dave,erin}', daveList.status === 200 && JSON.stringify(namesOf(daveList)) === JSON.stringify(['alice', 'dave', 'erin']),
      `[names=${namesOf(daveList).join(',')}]`);

    // D5 org_below（bob@研发部）：部门及全部下级（rd + rd-fe + rd-be；alice 属前端组，应在集合内）
    const bobList = await listUsers(tokens.bob);
    check('D5 org_below 档列表=部门及下级 {alice,bob,carol,dave,erin,frank}', bobList.status === 200 && JSON.stringify(namesOf(bobList)) === JSON.stringify(['alice', 'bob', 'carol', 'dave', 'erin', 'frank']),
      `[names=${namesOf(bobList).join(',')}]`);

    // D6 详情越权：org 范围外（carol 改 frank@后端组）→ 403/3002
    const orgDenied = await setUserStatus(tokens.carol, idOf('frank'), 0);
    check('D6 org 档详情越权被拦截（范围外 403/3002）', orgDenied.status === 403 && orgDenied.body?.code === 3002,
      `[http=${orgDenied.status} code=${orgDenied.body?.code}]`);

    // D7 详情越权：self 改他人 → 403/3002
    const selfDenied = await setUserStatus(tokens.selfscope, idOf('alice'), 0);
    check('D7 self 档详情越权被拦截（他人 403/3002）', selfDenied.status === 403 && selfDenied.body?.code === 3002,
      `[http=${selfDenied.status} code=${selfDenied.body?.code}]`);

    // D8 详情越权：org_below 旁支（bob 改 grace@市场部）→ 403/3002
    const belowDenied = await setUserStatus(tokens.bob, idOf('grace'), 0);
    check('D8 org_below 档旁支越权被拦截（403/3002）', belowDenied.status === 403 && belowDenied.body?.code === 3002,
      `[http=${belowDenied.status} code=${belowDenied.body?.code}]`);

    // D9 org_below 范围内放行：bob 禁用 frank 后即时恢复（副作用自愈）
    const frankId = idOf('frank');
    const disabled = await setUserStatus(tokens.bob, frankId, 0);
    check('D9 org_below 档范围内目标可操作（200）', disabled.status === 200 && disabled.body?.code === 0, `[http=${disabled.status}]`);
    const restored = await setUserStatus(tokens.bob, frankId, 1);
    check('D9 即时恢复启用（200）', restored.status === 200 && restored.body?.code === 0, `[http=${restored.status}]`);

    // D10 审计收敛：bob（org_below + audit:read）只见部门子树成员记录
    // 登录审计为异步落盘，给一个短轮询窗口等 D0 的登录记录就绪
    let audit = null;
    for (let i = 0; i < 10; i++) {
      audit = await call('/api/v1/audit-logs?page=1&pageSize=100', { headers: { authorization: `Bearer ${tokens.bob}` } });
      if (audit.status === 200 && (audit.body?.data?.total ?? 0) > 0) break;
      await sleep(200);
    }
    const auditItems = audit?.body?.data?.items ?? [];
    const visibleIds = new Set((bobList.body?.data?.items ?? []).map((item) => item.id));
    check('D10 org_below 档审计查询成功', audit?.status === 200, `[http=${audit?.status}]`);
    check('D10 审计记录非空（部门子树成员有登录记录）', auditItems.length > 0, `[total=${audit?.body?.data?.total}]`);
    check(
      'D10 审计列表只见部门子树成员（admin/selfscope/grace 记录被收敛）',
      auditItems.every((item) => visibleIds.has(item.userId)),
      `[leak=${auditItems.filter((item) => !visibleIds.has(item.userId)).map((item) => item.userId).join(',') || '无'}]`,
    );
  } finally {
    await stopServer(server);
  }
}

/**
 * 等待异步任务终态（导出派发后轮询 /jobs/:id/progress）
 * @returns 进度视图（succeeded / failed）或 null（超时）
 */
async function waitJob(jobId, token, tenantCode) {
  const headers = { authorization: `Bearer ${token}`, 'x-tenant-id': tenantCode };
  let progress = null;
  for (let i = 0; i < 80; i += 1) {
    const res = await call(`/api/v1/jobs/${jobId}/progress`, { headers });
    progress = res.body?.data ?? null;
    if (progress && (progress.status === 'succeeded' || progress.status === 'failed')) return progress;
    await sleep(100);
  }
  return progress;
}

/** 下载任务产物为 UTF-8 文本（CSV） */
async function downloadJobText(jobId, token, tenantCode) {
  const res = await fetch(`${BASE}/api/v1/jobs/${jobId}/download`, {
    headers: { authorization: `Bearer ${token}`, 'x-tenant-id': tenantCode },
  });
  return { status: res.status, text: Buffer.from(await res.arrayBuffer()).toString('utf8') };
}

/**
 * 阶段 E：双租户审计隔离（PRD-015 AC-15-07 / AC-15-09 的 HTTP 端到端取证）
 *
 * 用两个**真实租户账号**对照验证：
 * - acmeauditor（tenantId=1，audit:read/export，dataScope=all，**无** system:tenant:ignore）=
 *   普通租户管理员：本租户审计可见、`tenant_id` 不能放大、详情不跨租户、导出产物不含他租户行；
 * - admin（tenantId=0 legacy + 全量权限含 system:tenant:ignore）= 平台维护管理员：
 *   platform* 维护入口才可跨租户检索/收窄/读详情/导出，普通接口仍受租户边界。
 *
 * 「导出任务重跑不丢租户限制」是任务中心跨实例重建（jobRunnerRegistry 工厂）语义，
 * HTTP 层对 succeeded 任务无法触发重跑——由 `audit-tenant-isolation.integration.spec.ts`
 * 用真实库 + 工厂重建覆盖。
 */
async function phaseAuditTenantIsolation() {
  console.log('\n=== 阶段 E：双租户审计隔离（PRD-015 AC-15-07/09）===');
  const server = await startServer({
    TENANT_ENABLED: 'true',
    TENANT_BASE_DOMAIN: 'example.com',
    TENANT_ORDER: 'subdomain,header,jwt',
  });
  const acmeHeaders = (token) => ({ authorization: `Bearer ${token}`, 'x-tenant-id': 'acme' });
  const legacyHeaders = (token) => ({ authorization: `Bearer ${token}`, 'x-tenant-id': 'legacy' });
  try {
    // E0 两个真实租户账号登录（acmeauditor 为新增的租户审计员示范账号）
    const auditorLogin = await login('acmeauditor', 'AcmeAudit@123456', { 'x-tenant-id': 'acme' });
    check('E0 acme 租户审计员登录成功（普通租户管理员侧）', isOk(auditorLogin.status), `[http=${auditorLogin.status}]`);
    const auditorToken = auditorLogin.body?.data?.accessToken;
    const adminLogin = await login('admin', 'Admin@123456', { 'x-tenant-id': 'legacy' });
    check('E0 legacy 平台维护管理员登录成功', isOk(adminLogin.status), `[http=${adminLogin.status}]`);
    const adminToken = adminLogin.body?.data?.accessToken;

    // E1 普通列表：只含当前租户（登录审计异步落盘，短轮询等首个租户 1 行）
    let auditorList = null;
    for (let i = 0; i < 15; i += 1) {
      auditorList = await call('/api/v1/audit-logs?page=1&pageSize=100', { headers: acmeHeaders(auditorToken) });
      if ((auditorList.body?.data?.total ?? 0) > 0) break;
      await sleep(200);
    }
    const auditorRows = auditorList?.body?.data?.items ?? [];
    check('E1 普通租户账号可见本租户审计（非空）', auditorList?.status === 200 && auditorRows.length > 0,
      `[http=${auditorList?.status} total=${auditorList?.body?.data?.total}]`);
    const auditorTenants = [...new Set(auditorRows.map((row) => row.tenantId))];
    check('E1 普通列表行集只含当前租户（tenantId 全为 1，dataScope=all 不跨租户）',
      auditorRows.length > 0 && auditorRows.every((row) => row.tenantId === '1'),
      `[tenants=${auditorTenants.join(',')}]`);

    // E2 客户端 tenant_id：同值放行 / 他租户 4001（不能靠 query 越过租户边界）
    const sameTenant = await call('/api/v1/audit-logs?tenant_id=1&page=1&pageSize=100', { headers: acmeHeaders(auditorToken) });
    check('E2 指定本租户 tenant_id 放行', sameTenant.status === 200, `[http=${sameTenant.status}]`);
    const crossTenantParam = await call('/api/v1/audit-logs?tenant_id=0', { headers: acmeHeaders(auditorToken) });
    // 4001 在错误码表映射为 HTTP 403（与租户守卫拦截同码同语义），断言双接受以稳定覆盖
    check('E2 指定他租户 tenant_id → 4001（显式跨租户尝试被看见）',
      (crossTenantParam.status === 400 || crossTenantParam.status === 403) && crossTenantParam.body?.code === 4001,
      `[http=${crossTenantParam.status} code=${crossTenantParam.body?.code}]`);

    // E3 详情：本租户可读 / 他租户 404（与不存在同口径，不泄露存在性）
    const adminList = await call('/api/v1/audit-logs?page=1&pageSize=100', { headers: legacyHeaders(adminToken) });
    const legacyRows = (adminList.body?.data?.items ?? []).filter((row) => row.tenantId === '0');
    check('E3 平台管理员在普通接口内仍只看到本租户审计（legacy 行存在）',
      adminList.status === 200 && legacyRows.length > 0 && (adminList.body?.data?.items ?? []).every((row) => row.tenantId === '0'),
      `[total=${adminList.body?.data?.total}]`);
    const ownRow = auditorRows[0];
    const legacyRow = legacyRows[0];
    const ownDetail = await call(`/api/v1/audit-logs/${ownRow?.id}`, { headers: acmeHeaders(auditorToken) });
    check('E3 本租户记录详情可读', ownDetail.status === 200 && ownDetail.body?.data?.id === ownRow?.id,
      `[http=${ownDetail.status}]`);
    const crossDetail = await call(`/api/v1/audit-logs/${legacyRow?.id}`, { headers: acmeHeaders(auditorToken) });
    check('E3 他租户记录详情 → 404/1002（记录真实存在，拒绝来自租户维度）',
      crossDetail.status === 404 && crossDetail.body?.code === 1002,
      `[http=${crossDetail.status} code=${crossDetail.body?.code}]`);

    // E4 普通导出：产物只含本租户行，不含他租户记录 ID
    const exportDispatch = await call('/api/v1/audit-logs/export', { headers: acmeHeaders(auditorToken) });
    const exportJobId = exportDispatch.body?.data?.id;
    const exportProgress = exportJobId ? await waitJob(exportJobId, auditorToken, 'acme') : null;
    const exportArtifact = exportJobId ? await downloadJobText(exportJobId, auditorToken, 'acme') : { status: 0, text: '' };
    check('E4 普通租户导出任务 succeeded',
      exportDispatch.body?.code === 0 && exportProgress?.status === 'succeeded',
      `[job=${exportJobId} status=${exportProgress?.status}]`);
    check('E4 导出产物含本租户记录、不含他租户记录',
      exportArtifact.text.includes(ownRow?.id ?? '__missing__') && !exportArtifact.text.includes(legacyRow?.id ?? '__missing__'),
      `[own=${exportArtifact.text.includes(ownRow?.id ?? '__missing__')} cross=${exportArtifact.text.includes(legacyRow?.id ?? '__missing__')}]`);

    // E5 维护入口：平台维护管理员可跨租户检索 / 收窄 / 读详情
    const platform = await call('/api/v1/audit-logs/platform?page=1&pageSize=100', { headers: legacyHeaders(adminToken) });
    const platformRows = platform.body?.data?.items ?? [];
    const platformTenants = new Set(platformRows.map((row) => row.tenantId));
    check('E5 维护入口可跨租户检索（结果同时含 legacy 与 acme 租户行）',
      platform.status === 200 && platformTenants.has('0') && platformTenants.has('1'),
      `[tenants=${[...platformTenants].join(',')}]`);
    const platformNarrow = await call('/api/v1/audit-logs/platform?tenant_id=1&page=1&pageSize=100', { headers: legacyHeaders(adminToken) });
    const narrowedRows = platformNarrow.body?.data?.items ?? [];
    check('E5 维护入口可按 tenant_id 收窄（普通端点会 4001 的维度）',
      platformNarrow.status === 200 && narrowedRows.length > 0 && narrowedRows.every((row) => row.tenantId === '1'),
      `[total=${platformNarrow.body?.data?.total}]`);
    const platformDetail = await call(`/api/v1/audit-logs/platform/${ownRow?.id}`, { headers: legacyHeaders(adminToken) });
    check('E5 维护入口可读他租户记录详情', platformDetail.status === 200 && platformDetail.body?.data?.tenantId === '1',
      `[http=${platformDetail.status}]`);

    // E6 普通租户账号访问维护入口 → 3002（租户维度放开不替代业务权限，且需跨租户码）
    const deniedPlatform = await call('/api/v1/audit-logs/platform', { headers: acmeHeaders(auditorToken) });
    check('E6 普通租户账号访问平台维护入口 → 403/3002',
      deniedPlatform.status === 403 && deniedPlatform.body?.code === 3002,
      `[http=${deniedPlatform.status} code=${deniedPlatform.body?.code}]`);
    const deniedPlatformExport = await call('/api/v1/audit-logs/platform/export', { headers: acmeHeaders(auditorToken) });
    check('E6 普通租户账号访问平台导出 → 403/3002',
      deniedPlatformExport.status === 403 && deniedPlatformExport.body?.code === 3002,
      `[code=${deniedPlatformExport.body?.code}]`);

    // E7 平台导出：产物跨租户（含 acme 与 legacy 两侧记录）
    const platformExport = await call('/api/v1/audit-logs/platform/export', { headers: legacyHeaders(adminToken) });
    const platformJobId = platformExport.body?.data?.id;
    const platformProgress = platformJobId ? await waitJob(platformJobId, adminToken, 'legacy') : null;
    const platformArtifact = platformJobId ? await downloadJobText(platformJobId, adminToken, 'legacy') : { status: 0, text: '' };
    check('E7 平台导出任务 succeeded 且产物跨租户',
      platformExport.body?.code === 0 && platformProgress?.status === 'succeeded'
      && platformArtifact.text.includes(ownRow?.id ?? '__missing__') && platformArtifact.text.includes(legacyRow?.id ?? '__missing__'),
      `[status=${platformProgress?.status} acme=${platformArtifact.text.includes(ownRow?.id ?? '__missing__')} legacy=${platformArtifact.text.includes(legacyRow?.id ?? '__missing__')}]`);
  } finally {
    await stopServer(server);
  }
}

async function main() {
  await phaseEnabled();
  await phaseDisabled();
  await phaseDedicated();
  await phaseDataScope();
  await phaseAuditTenantIsolation();
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
