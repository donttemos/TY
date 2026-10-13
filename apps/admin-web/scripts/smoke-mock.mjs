/*
 * @file admin-web mock 全链路冒烟脚本
 * @description 不等后端的独立验证（PRD-005 验收 / TC-WEB）：启动 vite dev server（自动挂载 C-06 mock），
 *   以真实 HTTP 走完 认证（登录/me/错误码/禁用账号）→ 菜单 → 字典 → 用户 CRUD → 越权（3002）→
 *   无感刷新（轮换 + 旧 token 失效）→ 角色/菜单树/审计/订单 → 登出 全链路，并校验 C-06 契约关键字段；
 *   末尾若存在 dist 产物则执行 bundle 体积门禁（gzip 总量）。任一断言失败即非零退出。
 *   运行：pnpm smoke（cwd 需为 apps/admin-web）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 修 bundle 门禁统计缺陷：vendor-element-plus 由「取最后一个匹配文件」改为累加，
 *   否则 rolldown（vite 8）产物顺序变化后只量到 CSS 文件，门禁形同失效
 * @module admin-web/scripts
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.SMOKE_PORT ?? 5199);
const BASE = `http://127.0.0.1:${PORT}/api/v1`;
const READY_TIMEOUT_MS = 90_000;

/** 断言结果收集（失败不中断，走完全部再汇总，便于一次看全缺口） */
const results = [];
let currentPhase = '';

function check(name, condition, detail = '') {
  results.push({ phase: currentPhase, name, ok: Boolean(condition), detail });
  const mark = condition ? '✓' : '✗';
  console.log(`  ${mark} ${name}${detail ? ` —— ${detail}` : ''}`);
}

function phase(title) {
  currentPhase = title;
  console.log(`\n◆ ${title}`);
}

/** 统一请求助手：返回 { status, body }（body 为信封 JSON） */
async function api(method, urlPath, { token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    headers['Content-Type'] = 'application/json';
    payload = JSON.stringify(body);
  }
  const response = await fetch(`${BASE}${urlPath}`, { method, headers, body: payload });
  let json = null;
  try {
    json = await response.json();
  } catch {
    // 非 JSON 响应保持 null
  }
  return { status: response.status, body: json };
}

/** 启动 vite dev server（mock 中间件随 dev 自动挂载） */
function startVite() {
  const bin = path.join(ROOT, 'node_modules', 'vite', 'bin', 'vite.js');
  const child = spawn(process.execPath, [bin, '--port', String(PORT), '--strictPort'], {
    cwd: ROOT,
    env: { ...process.env, NODE_ENV: 'development' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const log = [];
  const remember = (chunk) => {
    log.push(chunk.toString());
    if (log.length > 200) log.shift();
  };
  child.stdout.on('data', remember);
  child.stderr.on('data', remember);
  return { child, log };
}

/** 等待 dev server 就绪 */
async function waitReady(child) {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`vite 提前退出（exit=${child.exitCode}）`);
    try {
      const response = await fetch(`http://127.0.0.1:${PORT}/`, { redirect: 'manual' });
      if (response.status < 500) return;
    } catch {
      // 尚未监听
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`vite ${READY_TIMEOUT_MS}ms 内未就绪`);
}

/** 结束 dev server（Windows 下杀进程树） */
function stopVite(child) {
  if (child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    child.kill('SIGTERM');
  }
}

/** bundle 体积门禁（dist 存在才执行；gzip 口径） */
function checkBundle() {
  const dist = path.join(ROOT, 'dist');
  if (!existsSync(dist)) {
    console.log('\n◆ bundle 门禁：dist 不存在，跳过（先 pnpm build 再 smoke 可启用）');
    return;
  }
  phase('bundle 体积门禁（gzip）');
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir)) {
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dist);
  let total = 0;
  let vendorEp = 0;
  for (const file of files) {
    const size = gzipSync(readFileSync(file)).length;
    total += size;
    // 累加而非覆盖：element-plus 的产物是「JS chunk + CSS」两个文件，取最后一个会把门禁量窄
    if (file.includes('vendor-element-plus')) vendorEp += size;
  }
  const kb = (bytes) => `${(bytes / 1024).toFixed(1)} kB`;
  check('dist gzip 总量 ≤ 600 kB', total <= 600 * 1024, `实际 ${kb(total)}`);
  check('vendor-element-plus gzip ≤ 360 kB', vendorEp <= 360 * 1024, `实际 ${kb(vendorEp)}`);
}

async function main() {
  console.log(`启动 vite dev server（mock 全链路）port=${PORT} …`);
  const { child, log } = startVite();
  try {
    await waitReady(child);
    console.log('dev server 就绪，开始冒烟…');

    // ---------- 认证 ----------
    phase('认证（登录 / me / 错误码 / 禁用账号）');
    const adminLogin = await api('POST', '/auth/login', { body: { account: 'admin', password: 'Admin@123456' } });
    check('admin 登录成功', adminLogin.body?.code === 0, `code=${adminLogin.body?.code}`);
    const adminToken = adminLogin.body?.data?.accessToken ?? '';
    const adminRefresh = adminLogin.body?.data?.refreshToken ?? '';
    check('签发双 token', Boolean(adminToken && adminRefresh), `tokenType=${adminLogin.body?.data?.tokenType}`);
    check('登录返回用户摘要', adminLogin.body?.data?.user?.username === 'admin' && Array.isArray(adminLogin.body?.data?.user?.permissions));

    const badLogin = await api('POST', '/auth/login', { body: { account: 'admin', password: 'wrong-pass' } });
    check('错误口令 → 3001', badLogin.body?.code === 3001, `code=${badLogin.body?.code} msg=${badLogin.body?.message}`);

    const lockedLogin = await api('POST', '/auth/login', { body: { account: 'carol', password: 'Carol@123456' } });
    check('禁用账号 → 3004', lockedLogin.body?.code === 3004, `code=${lockedLogin.body?.code}`);

    const me = await api('GET', '/auth/me', { token: adminToken });
    check('me 返回当前用户', me.body?.code === 0 && me.body?.data?.username === 'admin');
    check('me 权限码含 user:read / role:read', me.body?.data?.permissions?.includes('user:read') && me.body?.data?.permissions?.includes('role:read'));

    const meNoToken = await api('GET', '/auth/me');
    check('无 token 访问 me → 3001', meNoToken.body?.code === 3001, `code=${meNoToken.body?.code}`);

    const meBadToken = await api('GET', '/auth/me', { token: 'garbage.token.value' });
    check('伪造 token 访问 me → 3001', meBadToken.body?.code === 3001, `code=${meBadToken.body?.code}`);

    // ---------- 菜单与字典 ----------
    phase('菜单 / 字典（动态路由数据源）');
    const menus = await api('GET', '/auth/menus', { token: adminToken });
    const menuList = menus.body?.data ?? [];
    check('菜单树为非空数组', Array.isArray(menuList) && menuList.length >= 2, `根节点 ${menuList.length} 个`);
    const systemNode = menuList.find((m) => m.path === '/system');
    const usersMenu = systemNode?.children?.find((m) => m.path === '/system/users');
    check('系统管理含用户管理子菜单', Boolean(usersMenu), usersMenu ? `component=${usersMenu.component}` : '未找到');
    check('用户菜单带权限码 user:read', usersMenu?.permissionCode === 'user:read');
    check('控制台菜单登录即可见（无权限码）', menuList.find((m) => m.path === '/dashboard')?.permissionCode === null);

    const categories = await api('GET', '/dict/categories', { token: adminToken });
    const categoryList = categories.body?.data ?? [];
    check('字典分类非空', Array.isArray(categoryList) && categoryList.length > 0, `${categoryList.length} 个分类`);
    const firstCategory = categoryList[0];
    const items = await api('GET', `/dict/items?category_id=${encodeURIComponent(firstCategory?.id ?? '')}`, { token: adminToken });
    const itemList = items.body?.data ?? [];
    check('字典项按分类可查', Array.isArray(itemList) && itemList.length > 0, `${itemList.length} 项（${firstCategory?.code}）`);
    check('字典项含 label/value', itemList.every((i) => typeof i.label === 'string' && typeof i.value === 'string'));

    // ---------- 用户 CRUD ----------
    phase('用户 CRUD（C-06 契约 + 审计留痕）');
    const list = await api('GET', '/users?page=1&pageSize=5', { token: adminToken });
    const listData = list.body?.data;
    check('用户分页结构', list.body?.code === 0 && Array.isArray(listData?.items) && typeof listData?.total === 'number', `total=${listData?.total}`);
    check('列表项含 roleIds（C-06 契约字段）', listData?.items?.every((u) => Array.isArray(u.roleIds)));

    const smokeName = `smoke_${Date.now().toString(36)}`;
    const created = await api('POST', '/users', { token: adminToken, body: { username: smokeName, password: 'Smoke@123456', nickname: '冒烟用户', roleIds: [] } });
    check('新建用户', created.body?.code === 0 && Boolean(created.body?.data?.id), `code=${created.body?.code}`);
    const newId = created.body?.data?.id ?? '';

    const detail = await api('GET', `/users/${newId}`, { token: adminToken });
    check('用户详情回显', detail.body?.data?.username === smokeName);

    const updated = await api('PUT', `/users/${newId}`, { token: adminToken, body: { nickname: '冒烟用户改' } });
    check('更新用户资料', updated.body?.code === 0 && updated.body?.data?.nickname === '冒烟用户改');

    const deleted = await api('DELETE', `/users/${newId}`, { token: adminToken });
    check('删除用户', deleted.body?.code === 0);
    const afterDelete = await api('GET', `/users/${newId}`, { token: adminToken });
    check('删除后详情 → 1002', afterDelete.body?.code === 1002, `code=${afterDelete.body?.code}`);

    // ---------- 越权 ----------
    phase('越权拦截（3002，按钮级权限的服务端侧）');
    const aliceLogin = await api('POST', '/auth/login', { body: { account: 'alice', password: 'Alice@123456' } });
    const aliceToken = aliceLogin.body?.data?.accessToken ?? '';
    check('alice（普通角色）登录成功', aliceLogin.body?.code === 0);

    const aliceList = await api('GET', '/users?page=1&pageSize=5', { token: aliceToken });
    check('alice 有 user:read → 可查列表', aliceList.body?.code === 0, `code=${aliceList.body?.code}`);

    const aliceCreate = await api('POST', '/users', { token: aliceToken, body: { username: 'x', password: 'Xx@123456' } });
    check('alice 无 user:create → 3002', aliceCreate.body?.code === 3002, `code=${aliceCreate.body?.code} msg=${aliceCreate.body?.message}`);

    const aliceAudit = await api('GET', '/audit-logs', { token: aliceToken });
    check('alice 无 audit:read → 3002', aliceAudit.body?.code === 3002, `code=${aliceAudit.body?.code}`);

    // ---------- 无感刷新 ----------
    phase('无感刷新（轮换 + 旧 token 失效 + 泄漏判定）');
    const refreshed = await api('POST', '/auth/refresh', { body: { refreshToken: adminRefresh } });
    const newAccess = refreshed.body?.data?.accessToken ?? '';
    const newRefresh = refreshed.body?.data?.refreshToken ?? '';
    check('刷新签发新双 token', refreshed.body?.code === 0 && Boolean(newAccess && newRefresh));
    check('新 token 与旧 token 不同', newAccess !== adminToken && newRefresh !== adminRefresh);

    const meWithNew = await api('GET', '/auth/me', { token: newAccess });
    check('新 access token 可访问 me', meWithNew.body?.code === 0 && meWithNew.body?.data?.username === 'admin');

    const reuseOld = await api('POST', '/auth/refresh', { body: { refreshToken: adminRefresh } });
    check('复用旧 refresh token → 3001（轮换失效）', reuseOld.body?.code === 3001, `code=${reuseOld.body?.code} msg=${reuseOld.body?.message}`);

    const sessions = await api('GET', '/auth/sessions', { token: newAccess });
    check('登录设备列表可查', sessions.body?.code === 0 && Array.isArray(sessions.body?.data), `${sessions.body?.data?.length ?? 0} 个会话`);

    // ---------- 其他域 ----------
    phase('角色 / 菜单树 / 审计 / 订单');
    const roles = await api('GET', '/roles', { token: newAccess });
    const roleList = roles.body?.data ?? [];
    check('角色列表含权限计数', roleList.every((r) => typeof r.permissionCount === 'number'), `${roleList.length} 个角色`);

    const menuTree = await api('GET', '/menus/tree', { token: newAccess });
    const flatMenus = menuTree.body?.data ?? [];
    check('菜单管理树为扁平数组（前端组装）', Array.isArray(flatMenus) && flatMenus.every((m) => typeof m.parentId === 'string'), `${flatMenus.length} 条`);

    const audit = await api('GET', '/audit-logs?module=user&page=1&pageSize=10', { token: newAccess });
    const auditList = audit.body?.data ?? [];
    check('审计日志可按模块查询', audit.body?.code === 0 && Array.isArray(auditList?.items), `${auditList?.total ?? 0} 条 user 模块`);
    check('审计记录含变更前后值', auditList.items?.some((a) => a.beforeValue !== null || a.afterValue !== null));

    const orders = await api('GET', '/orders?page=1&pageSize=5', { token: newAccess });
    check('订单演示域可查', orders.body?.code === 0 && Array.isArray(orders.body?.data?.items), `total=${orders.body?.data?.total}`);

    const logout = await api('POST', '/auth/logout', { token: newAccess });
    check('登出成功', logout.body?.code === 0);

    // ---------- bundle 门禁 ----------
    checkBundle();
  } finally {
    stopVite(child);
    if (process.env.SMOKE_KEEP_LOG === 'true') console.log('--- vite 日志 ---\n' + log.join(''));
  }

  // ---------- 汇总 ----------
  const failed = results.filter((r) => !r.ok);
  console.log(`\n════════════════════════════════════`);
  console.log(`冒烟结果：${results.length - failed.length}/${results.length} 通过`);
  if (failed.length > 0) {
    console.log('失败项：');
    for (const item of failed) console.log(`  ✗ [${item.phase}] ${item.name}${item.detail ? ` —— ${item.detail}` : ''}`);
    process.exitCode = 1;
  } else {
    console.log('全部通过 ✅');
  }
}

main().catch((error) => {
  console.error(`冒烟执行异常：${error?.message ?? error}`);
  process.exitCode = 1;
});
