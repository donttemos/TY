/*
 * @file M3 鉴权与权限冒烟验证脚本
 * @description 对运行中的 example-api 逐项验证 PRD-003 的 AC（TC-AUTH-001~014）：
 *   未登录/无效令牌 3001、越权 3002、登录发双 token、dataScope=self 收紧、
 *   菜单按权限过滤、refresh 轮换与泄漏检出（族撤销）、登出令牌失效、
 *   账号禁用强制下线、审计日志落库、连续失败锁定 3004。
 *   前置：已执行 fw db:migrate + fw db:seed，且服务监听 127.0.0.1:3000。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api
 */

const BASE = 'http://127.0.0.1:3000';

/** 种子账号（apps/example-api/prisma/seed.ts） */
const ADMIN = { account: 'admin', password: 'Admin@123456' };
const ALICE = { account: 'alice', password: 'Alice@123456' };

/**
 * refresh 并发宽限窗口（AUTH_REFRESH_GRACE_SECONDS，默认 10s）。
 * 窗口内复用旧 refresh 属「并发刷新」的正常行为（TC-AUTH-008），
 * 必须在窗口外复用才会被判为泄漏（TC-AUTH-007），故此处按默认值等待。
 */
const REFRESH_GRACE_WAIT_MS = 11_000;

/** @Post 默认返回 201 Created，统一按 2xx 成功判定 */
function isOk(status) {
  return status >= 200 && status < 300;
}

/** 断言计数 */
let pass = 0;
let total = 0;

/**
 * 记录一条断言结果
 * @param name 断言名
 * @param ok 是否通过
 * @param detail 附加信息
 */
function check(name, ok, detail = '') {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

/** 请求工具：返回 { status, body, traceHeader } */
async function call(path, options = {}) {
  const headers = { ...(options.headers ?? {}) };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  if (options.body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(BASE + path, {
    method: options.method ?? 'GET',
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = await res.json().catch(() => ({}));
  return { status: res.status, body, traceHeader: res.headers.get('x-trace-id') };
}

/** 登录并按需断言 */
async function login(user, label) {
  const res = await call('/api/v1/auth/login', { method: 'POST', body: user });
  check(`${label} 登录返回双 token`, isOk(res.status) && res.body.code === 0 && !!res.body.data?.accessToken && !!res.body.data?.refreshToken,
    `http=${res.status} code=${res.body.code}`);
  return res.body.data ?? {};
}

async function main() {
  // ---- TC-AUTH-001/003：未登录与无效令牌 ----
  const anon = await call('/api/v1/users');
  check('未登录访问受保护端点 → 401/3001', anon.status === 401 && anon.body.code === 3001, `http=${anon.status} code=${anon.body.code}`);

  const bad = await call('/api/v1/users', { token: 'not-a-real-token' });
  check('无效令牌 → 401/3001', bad.status === 401 && bad.body.code === 3001, `http=${bad.status} code=${bad.body.code}`);

  // ---- TC-AUTH-002：登录 + me ----
  const admin = await login(ADMIN, 'admin');
  const me = await call('/api/v1/auth/me', { token: admin.accessToken });
  const meData = me.body.data ?? {};
  check('GET /auth/me 返回角色与权限码', me.status === 200 && Array.isArray(meData.permissions) && meData.roles.includes('admin') && meData.permissions.includes('role:grant'),
    `roles=${JSON.stringify(meData.roles)} perms=${meData.permissions?.length}`);

  // ---- 管理员视角：全量数据 ----
  const allUsers = await call('/api/v1/users?page=1&pageSize=20', { token: admin.accessToken });
  check('admin 用户列表（dataScope=all）', allUsers.status === 200 && allUsers.body.code === 0 && allUsers.body.data.total >= 2,
    `total=${allUsers.body.data?.total}`);

  const roles = await call('/api/v1/roles', { token: admin.accessToken });
  check('GET /roles 返回内置角色', roles.status === 200 && roles.body.data.some((r) => r.code === 'admin') && roles.body.data.some((r) => r.code === 'user'),
    `codes=${JSON.stringify(roles.body.data?.map((r) => r.code))}`);

  const perms = await call('/api/v1/permissions', { token: admin.accessToken });
  const permCount = (perms.body.data ?? []).reduce((sum, g) => sum + g.items.length, 0);
  check('GET /permissions 按 module 分组', perms.status === 200 && (perms.body.data?.length ?? 0) >= 4 && permCount === 22,
    `groups=${perms.body.data?.length} perms=${permCount}`);

  const menusAdmin = await call('/api/v1/auth/menus', { token: admin.accessToken });
  const namesAdmin = JSON.stringify(menusAdmin.body.data ?? []);
  check('admin 菜单含「审计日志」与「订单中心」', menusAdmin.status === 200 && namesAdmin.includes('审计日志') && namesAdmin.includes('订单中心'),
    `菜单根数=${menusAdmin.body.data?.length}`);

  // ---- TC-AUTH-013：dataScope=self 只返回本人 ----
  const alice = await login(ALICE, 'alice');
  const selfUsers = await call('/api/v1/users?page=1&pageSize=20', { token: alice.accessToken });
  const selfItems = selfUsers.body.data?.items ?? [];
  check('alice 用户列表 dataScope=self 仅本人', selfUsers.status === 200 && selfUsers.body.data.total === 1 && selfItems[0]?.username === 'alice',
    `total=${selfUsers.body.data?.total} first=${selfItems[0]?.username}`);

  // ---- TC-AUTH-004：越权 3002 ----
  const denied = await call('/api/v1/roles', { token: alice.accessToken });
  check('alice 访问 /roles → 403/3002', denied.status === 403 && denied.body.code === 3002, `http=${denied.status} code=${denied.body.code}`);

  // ---- TC-AUTH-010：菜单按权限过滤 ----
  const menusAlice = await call('/api/v1/auth/menus', { token: alice.accessToken });
  const namesAlice = JSON.stringify(menusAlice.body.data ?? []);
  check('alice 菜单不含未授权项（审计日志/订单中心）', menusAlice.status === 200 && !namesAlice.includes('审计日志') && !namesAlice.includes('订单中心') && namesAlice.includes('用户管理'),
    `菜单根数=${menusAlice.body.data?.length}`);

  const auditDenied = await call('/api/v1/audit-logs', { token: alice.accessToken });
  check('alice 访问 /audit-logs → 403/3002', auditDenied.status === 403 && auditDenied.body.code === 3002,
    `http=${auditDenied.status} code=${auditDenied.body.code}`);

  // ---- TC-AUTH-006/007/008：refresh 轮换与泄漏检出 ----
  const rot1 = await call('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: alice.refreshToken } });
  const newRefresh = rot1.body.data?.refreshToken;
  check('refresh 轮换成功且返回新令牌', isOk(rot1.status) && rot1.body.code === 0 && !!newRefresh && newRefresh !== alice.refreshToken,
    `http=${rot1.status}`);

  // 宽限窗口内复用：属并发刷新，不应判泄漏（TC-AUTH-008）
  const inGrace = await call('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: alice.refreshToken } });
  check('宽限窗口内复用旧 refresh 视为并发刷新（不误判）', isOk(inGrace.status) && inGrace.body.code === 0,
    `http=${inGrace.status} code=${inGrace.body.code}`);

  // 窗口外复用：判为泄漏并撤销整族（TC-AUTH-007）
  await new Promise((resolve) => setTimeout(resolve, REFRESH_GRACE_WAIT_MS));
  const reuse = await call('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: alice.refreshToken } });
  check('窗口外复用旧 refresh → 判定泄漏并拒绝', reuse.status === 401 && reuse.body.code === 3001, `http=${reuse.status} code=${reuse.body.code}`);

  const afterRevoke = await call('/api/v1/auth/refresh', { method: 'POST', body: { refreshToken: newRefresh } });
  check('泄漏后整族撤销（同族新 refresh 亦失效）', afterRevoke.status === 401, `http=${afterRevoke.status} code=${afterRevoke.body.code}`);

  // ---- TC-AUTH-011 + 强制下线：禁用账号并撤销全部会话 ----
  const aliceId = selfItems[0]?.id;
  const disabled = await call(`/api/v1/users/${aliceId}/status`, { method: 'PUT', token: admin.accessToken, body: { status: 0 } });
  check('禁用账号并强制下线', disabled.status === 200 && disabled.body.data?.status === 0 && disabled.body.data?.forcedLogout === true,
    `forcedLogout=${disabled.body.data?.forcedLogout}`);

  const aliceAfterDisable = await call('/api/v1/auth/me', { token: alice.accessToken });
  check('禁用后 alice 原 access 立即失效 → 401/3001', aliceAfterDisable.status === 401 && aliceAfterDisable.body.code === 3001,
    `http=${aliceAfterDisable.status} code=${aliceAfterDisable.body.code}`);

  const enabled = await call(`/api/v1/users/${aliceId}/status`, { method: 'PUT', token: admin.accessToken, body: { status: 1 } });
  check('恢复启用账号', enabled.status === 200 && enabled.body.data?.status === 1, `status=${enabled.body.data?.status}`);

  // ---- TC-AUTH-011：审计日志落库（显式记录变更前后值） ----
  const audit = await call('/api/v1/audit-logs?page=1&pageSize=20', { token: admin.accessToken });
  const auditItems = audit.body.data?.items ?? [];
  // 禁用与启用各留一条：按 after 取「禁用」那条，断言 before=1 / after=0
  const disableLog = auditItems.find((r) => r.targetId === aliceId && r.action === 'update' && r.afterValue?.status === 0);
  check('审计日志记录账号禁用（含前后值）', audit.status === 200 && audit.body.data.total >= 1 && !!disableLog && disableLog.beforeValue?.status === 1,
    `total=${audit.body.data?.total} before=${JSON.stringify(disableLog?.beforeValue)} after=${JSON.stringify(disableLog?.afterValue)}`);

  // ---- TC-AUTH-005：登出后令牌失效 ----
  const logout = await call('/api/v1/auth/logout', { method: 'POST', token: admin.accessToken });
  check('登出成功', isOk(logout.status) && logout.body.code === 0, `http=${logout.status} code=${logout.body.code}`);

  const afterLogout = await call('/api/v1/auth/me', { token: admin.accessToken });
  check('登出后原 access 失效 → 401/3001', afterLogout.status === 401 && afterLogout.body.code === 3001, `http=${afterLogout.status} code=${afterLogout.body.code}`);

  // ---- TC-AUTH-012：连续失败锁定（放最后，会锁住 alice） ----
  let lastCode = 0;
  let attempts = 0;
  for (let i = 1; i <= 6; i++) {
    const res = await call('/api/v1/auth/login', { method: 'POST', body: { account: ALICE.account, password: 'Wrong@000000' } });
    attempts = i;
    lastCode = res.body.code;
    if (res.body.code === 3004) break;
  }
  check(`连续失败触发锁定 3004（第 ${attempts} 次）`, lastCode === 3004, `code=${lastCode}`);
  const locked = await call('/api/v1/auth/login', { method: 'POST', body: ALICE });
  check('锁定期内正确口令亦被拒 3004', locked.status === 403 && locked.body.code === 3004, `http=${locked.status} code=${locked.body.code}`);

  console.log(`\n结果：${pass}/${total} 通过`);
  process.exit(pass === total ? 0 : 1);
}

main().catch((err) => {
  console.error('验证脚本执行失败：', err);
  process.exit(1);
});
