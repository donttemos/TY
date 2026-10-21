/*
 * @file admin-web mock 全链路冒烟脚本
 * @description 不等后端的独立验证（PRD-005 验收 / TC-WEB）：启动 vite dev server（自动挂载 C-06 mock），
 *   以真实 HTTP 走完 认证（登录/me/错误码/禁用账号）→ 菜单 → 字典 → 用户 CRUD → 越权（3002）→
 *   无感刷新（轮换 + 旧 token 失效）→ 角色/菜单树/审计/订单 → 队列管理（M7：状态/指标/cron 触发/死信
 *   重放/暂停恢复/清空/越权）→ 租户管理与异步任务（N-01/N-02：五端点 + 任务面轮询/重跑/下载 +
 *   越权与归属人隔离）→ 登出 全链路，并校验 C-06 契约关键字段；
 *   末尾若存在 dist 产物则执行 bundle 体积门禁（gzip 总量）。任一断言失败即非零退出。
 *   运行：pnpm smoke（cwd 需为 apps/admin-web）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 修 bundle 门禁统计缺陷：vendor-element-plus 由「取最后一个匹配文件」改为累加，
 *   否则 rolldown（vite 8）产物顺序变化后只量到 CSS 文件，门禁形同失效
 * @modified 2026-10-13 donttemo M7：新增队列管理冒烟段（/queue/* 全端点 + system:queue:* 越权拦截）
 * @modified 2026-10-15 donttemo N-01/N-02：① 死信列表分页断言（page/pageSize 回传 + total 全集口径）；
 *   ② 新增租户管理与异步任务段——菜单 / 字典 / 列表过滤与排序白名单 / 开租户校验（dedicated 必填
 *   dbUrl、shared 拒收、编码唯一 1003）/ 停用（legacy 1004）/ 迁移长任务（派发 → 轮询 → 控制面切换
 *   落库 → retry 成功 1004）/ 审计导出（派发 → 轮询 → CSV 下载验 BOM+表头）/ simulate=fail 失败路径
 * @modified 2026-10-15 donttemo BUG-15 增量 + E-07：roles/dict 排序白名单断言（合法排序 + 未知字段
 *   400/1001）与 GET /dict/audit_module 四项断言
 * @modified 2026-10-15 donttemo M9/PRD-009：① audit_module 断言更新为六项（seed 与 mock 同批补 queue/config）；
 * @modified 2026-10-20 donttemo M15：audit_module 再补 saas（七项）——字典与真实写入值同源，范围断言三处同改；
 *   ② 新增参数配置段——GET /configs 白名单 12 键、PUT 合法值生效（source 翻转 + 版本号递增 + 审计落盘）、
 *   boot 键 400/5001、未知键 404/5003、非法值 400/5002（旧值保持 + 失败审计 + 原因回显）、同值写不产生审计、
 *   alice 无 system:config:read/write → 3002 双断言
 *   与原地重跑 / 越权（3002）与任务归属人隔离（404）
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

    // BUG-15：列表排序参数（api-spec §1.5）—— mock 必须与真实后端同语义，否则 dev 全绿、真机 400
    const sortedList = await api('GET', '/users?page=1&pageSize=20&sort=username:asc', { token: adminToken });
    const sortedNames = (sortedList.body?.data?.items ?? []).map((u) => u.username);
    const sortedAscending = sortedNames.every((name, index) => index === 0 || sortedNames[index - 1] <= name);
    check('用户列表 sort=username:asc 生效（升序，长度 ≥ 2）',
      sortedList.body?.code === 0 && sortedNames.length >= 2 && sortedAscending,
      `names=${JSON.stringify(sortedNames)}`);

    const badSortField = await api('GET', '/users?sort=password:desc', { token: adminToken });
    check('未知排序字段 → 1001（与后端白名单同语义，不静默忽略）',
      badSortField.body?.code === 1001, `code=${badSortField.body?.code}`);

    const badSortDir = await api('GET', '/users?sort=username:up', { token: adminToken });
    check('非法排序方向 → 1001（与后端同语义）',
      badSortDir.body?.code === 1001, `code=${badSortDir.body?.code}`);

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

    // ---------- 个人资料自服务（GET / PUT /auth/profile） ----------
    phase('个人资料自服务（/auth/profile，auth:me）');
    const profile = await api('GET', '/auth/profile', { token: newAccess });
    check('GET /auth/profile 返回手机与邮箱', profile.body?.code === 0 && 'phone' in (profile.body?.data ?? {}) && 'email' in (profile.body?.data ?? {}));

    const savedProfile = await api('PUT', '/auth/profile', { token: newAccess, body: { nickname: '管理员改名', phone: '13800000001' } });
    check('本人资料可自助保存', savedProfile.body?.code === 0 && savedProfile.body?.data?.nickname === '管理员改名', `code=${savedProfile.body?.code}`);

    const duplicatePhone = await api('PUT', '/auth/profile', { token: newAccess, body: { phone: '13800000002' } });
    check('手机号占用他人 → 409', duplicatePhone.body?.code === 1003, `code=${duplicatePhone.body?.code}`);

    const emptyPatch = await api('PUT', '/auth/profile', { token: newAccess, body: {} });
    check('空补丁 → 1001', emptyPatch.body?.code === 1001, `code=${emptyPatch.body?.code}`);

    // 越权字段必须被忽略：传 status/roleIds 只应落空，账号状态与角色不受影响
    const escalated = await api('PUT', '/auth/profile', { token: newAccess, body: { status: 0, roleIds: ['r-admin'] } });
    const meAfterEscalate = await api('GET', '/auth/me', { token: newAccess });
    check('自助接口不接收 status / roleIds（无提权面）', escalated.body?.code === 1001 && meAfterEscalate.body?.code === 0, `code=${escalated.body?.code}`);

    const aliceProfile = await api('GET', '/auth/profile', { token: aliceToken });
    check('alice（仅 auth:me + user:read）可读本人资料', aliceProfile.body?.code === 0, `code=${aliceProfile.body?.code}`);
    const aliceSaved = await api('PUT', '/auth/profile', { token: aliceToken, body: { nickname: 'Alice 改' } });
    check('alice 可自助保存本人资料（回归：原走 /users/:id 必 3002）', aliceSaved.body?.code === 0, `code=${aliceSaved.body?.code}`);

    // 第二台设备登录（新会话族），用于验证「下线设备」的权限墙
    await api('POST', '/auth/login', { body: { account: 'alice', password: 'Alice@123456' } });
    const aliceSessions = await api('GET', '/auth/sessions', { token: aliceToken });
    const aliceOtherSession = (aliceSessions.body?.data ?? []).find((s) => !s.current);
    const aliceRevoke = aliceOtherSession
      ? await api('DELETE', `/auth/sessions/${aliceOtherSession.id}`, { token: aliceToken })
      : { body: null };
    check(
      'alice 无 auth:revoke-session → 3002（mock 与真机同源）',
      aliceRevoke.body?.code === 3002,
      `code=${aliceRevoke.body?.code ?? 'n/a'}`,
    );

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

    // M15：事件注册表下发（前端运营视图的唯一语义来源）
    const auditEvents = await api('GET', '/audit-logs/events', { token: newAccess });
    const eventItems = auditEvents.body?.data?.items ?? [];
    check('GET /audit-logs/events 返回注册表 + version',
      auditEvents.body?.code === 0 && typeof auditEvents.body?.data?.version === 'string' && eventItems.length >= 12,
      `code=${auditEvents.body?.code} items=${eventItems.length}`);

    // M15：结果筛选（seed 每 7 条一条 denied）
    const auditDenied = await api('GET', '/audit-logs?result=denied&page=1&pageSize=50', { token: newAccess });
    const deniedItems = auditDenied.body?.data?.items ?? [];
    check('审计按 result=denied 过滤且结果一致',
      auditDenied.body?.code === 0 && deniedItems.length > 0 && deniedItems.every((a) => a.result === 'denied'),
      `items=${deniedItems.length}`);

    // M15：事件多值过滤（风险筛选的前端展开形态）
    const auditMulti = await api('GET', '/audit-logs?event=user.status_change,saas.lifecycle.freeze&page=1&pageSize=50', { token: newAccess });
    const multiItems = auditMulti.body?.data?.items ?? [];
    check('审计按 event 多值过滤（逗号分隔）',
      auditMulti.body?.code === 0 && multiItems.length > 0
        && multiItems.every((a) => ['user.status_change', 'saas.lifecycle.freeze'].includes(a.event)),
      `items=${multiItems.length}`);
    // 排序（BUG-15）：mock 必须与后端同语义，白名单外字段 / 非法方向一律 400/1001
    const auditSorted = await api('GET', '/audit-logs?page=1&pageSize=10&sort=created_at:asc', { token: newAccess });
    const auditTimes = (auditSorted.body?.data?.items ?? []).map((a) => a.createdAt);
    const auditAscending = auditTimes.every((t, index) => index === 0 || auditTimes[index - 1] <= t);
    check('审计日志 sort=created_at:asc 生效（升序，长度 ≥ 2）',
      auditSorted.body?.code === 0 && auditTimes.length >= 2 && auditAscending,
      `times=${JSON.stringify(auditTimes)}`);
    const auditBadField = await api('GET', '/audit-logs?sort=password:desc', { token: newAccess });
    check('审计日志 sort 未知字段 → 400/1001', auditBadField.status === 400 && auditBadField.body?.code === 1001,
      `status=${auditBadField.status} code=${auditBadField.body?.code}`);
    const auditBadDir = await api('GET', '/audit-logs?sort=module:up', { token: newAccess });
    check('审计日志 sort 非法方向 → 400/1001', auditBadDir.status === 400 && auditBadDir.body?.code === 1001,
      `status=${auditBadDir.status} code=${auditBadDir.body?.code}`);

    const orders = await api('GET', '/orders?page=1&pageSize=5', { token: newAccess });
    check('订单演示域可查', orders.body?.code === 0 && Array.isArray(orders.body?.data?.items), `total=${orders.body?.data?.total}`);

    // ---------- M7 队列管理 ----------
    phase('队列管理（M7 / system:queue:*）');
    const menusAgain = await api('GET', '/auth/menus', { token: newAccess });
    const systemNode2 = (menusAgain.body?.data ?? []).find((m) => m.path === '/system');
    const queueMenu = systemNode2?.children?.find((m) => m.path === '/system/queue');
    check('系统管理含「队列管理」子菜单', Boolean(queueMenu), queueMenu ? `component=${queueMenu.component}` : '未找到');
    check('队列菜单权限码 system:queue:list', queueMenu?.permissionCode === 'system:queue:list');

    const queueStats = await api('GET', '/admin/queue/stats', { token: newAccess });
    const stats = queueStats.body?.data;
    check('队列状态可查（driver / 明细 / 合计）', queueStats.body?.code === 0 && stats?.driver === 'memory' && Array.isArray(stats?.queues) && typeof stats?.totals?.backlog === 'number', `queues=${stats?.queues?.length} backlog=${stats?.totals?.backlog}`);

    const queueMetrics = await api('GET', '/admin/queue/metrics', { token: newAccess });
    const qm = queueMetrics.body?.data;
    check('指标快照含成功率与计数', queueMetrics.body?.code === 0 && typeof qm?.successRate === 'number' && typeof qm?.deadLettered === 'number' && typeof qm?.cronTicked === 'number', `successRate=${qm?.successRate} deadLettered=${qm?.deadLettered}`);

    const queueHandlers = await api('GET', '/admin/queue/handlers', { token: newAccess });
    check('已注册任务名非空', Array.isArray(queueHandlers.body?.data?.names) && queueHandlers.body.data.names.length > 0, `${queueHandlers.body?.data?.names?.length} 个`);

    const cronsBefore = await api('GET', '/admin/queue/crons', { token: newAccess });
    const cronItems = cronsBefore.body?.data?.items ?? [];
    check('定时任务快照（表达式 / 加锁 / 执行计数）', Array.isArray(cronItems) && cronItems.length >= 3 && cronItems.every((c) => typeof c.expression === 'string' && typeof c.lock === 'boolean' && typeof c.runs === 'number'), `${cronItems.length} 条`);
    const tickRunsBefore = cronItems.find((c) => c.name === 'demo.tick')?.runs ?? 0;

    const ticked = await api('POST', '/admin/queue/crons/demo.tick/tick', { token: newAccess });
    check('手动触发定时任务（acquired=true）', ticked.body?.code === 0 && ticked.body?.data?.results?.[0]?.acquired === true, `acquired=${ticked.body?.data?.results?.[0]?.acquired}`);

    const cronsAfter = await api('GET', '/admin/queue/crons', { token: newAccess });
    const tickRunsAfter = (cronsAfter.body?.data?.items ?? []).find((c) => c.name === 'demo.tick')?.runs ?? 0;
    check('触发后执行计数增加', tickRunsAfter === tickRunsBefore + 1, `runs=${tickRunsBefore}→${tickRunsAfter}`);

    const deadList = await api('GET', '/admin/queue/dead-letters', { token: newAccess });
    const dead = deadList.body?.data;
    check('死信列表（total 与明细字段）', deadList.body?.code === 0 && typeof dead?.total === 'number' && Array.isArray(dead?.items) && dead.items.every((d) => typeof d.attemptsMade === 'number' && typeof d.reason === 'string'), `total=${dead?.total}`);

    // 死信分页（N-01 之后的分页改造）：page/pageSize 回传，total 为全集条数
    const deadPaged = await api('GET', '/admin/queue/dead-letters?page=1&pageSize=2', { token: newAccess });
    const paged = deadPaged.body?.data;
    check('死信列表分页（page/pageSize 回传，total 为全集）', deadPaged.body?.code === 0 && paged?.page === 1 && paged?.pageSize === 2 && paged?.items?.length === 2 && paged?.total === dead?.total, `page=${paged?.page} pageSize=${paged?.pageSize} total=${paged?.total}`);

    const requeued = await api('POST', '/admin/queue/dead-letters/job-dl-0001/requeue', { token: newAccess });
    check('死信重放成功', requeued.body?.code === 0 && requeued.body?.data?.requeued === true);
    const requeuedMissing = await api('POST', '/admin/queue/dead-letters/job-dl-9999/requeue', { token: newAccess });
    check('重放不存在的死信返回 requeued=false（非报错）', requeuedMissing.body?.code === 0 && requeuedMissing.body?.data?.requeued === false);

    const pausedRes = await api('POST', '/admin/queue/pause', { token: newAccess });
    const statsPaused = await api('GET', '/admin/queue/stats', { token: newAccess });
    check('暂停消费后 stats.paused=true', pausedRes.body?.code === 0 && statsPaused.body?.data?.paused === true);

    const resumedRes = await api('POST', '/admin/queue/resume', { token: newAccess });
    const statsResumed = await api('GET', '/admin/queue/stats', { token: newAccess });
    check('恢复消费后 stats.paused=false', resumedRes.body?.code === 0 && statsResumed.body?.data?.paused === false);

    const drained = await api('DELETE', '/admin/queue/drain', { token: newAccess });
    check('清空等待队列返回移除数', drained.body?.code === 0 && typeof drained.body?.data?.removed === 'number', `removed=${drained.body?.data?.removed}`);

    const purged = await api('DELETE', '/admin/queue/dead-letters', { token: newAccess });
    const deadAfterPurge = await api('GET', '/admin/queue/dead-letters', { token: newAccess });
    check('清理死信后列表为空', purged.body?.code === 0 && typeof purged.body?.data?.removed === 'number' && deadAfterPurge.body?.data?.total === 0, `removed=${purged.body?.data?.removed}`);

    const aliceQueueStats = await api('GET', '/admin/queue/stats', { token: aliceToken });
    check('alice 无 system:queue:list → 3002', aliceQueueStats.body?.code === 3002, `code=${aliceQueueStats.body?.code}`);
    const alicePause = await api('POST', '/admin/queue/pause', { token: aliceToken });
    check('alice 无 system:queue:manage → 3002', alicePause.body?.code === 3002, `code=${alicePause.body?.code}`);

    phase('租户管理与异步任务（N-01 / N-02）');

    // 租户菜单：与 seed 同批建出（/system/tenants，需 tenant:read）
    const menusN = await api('GET', '/auth/menus', { token: newAccess });
    const tenantMenu = (menusN.body?.data ?? []).find((m) => m.path === '/system')?.children?.find((m) => m.path === '/system/tenants');
    check('系统管理含「租户管理」子菜单', Boolean(tenantMenu) && tenantMenu?.component === 'system/tenants' && tenantMenu?.permissionCode === 'tenant:read', tenantMenu ? `component=${tenantMenu.component}` : '未找到');

    // 租户字典（页面标签与下拉数据源）
    for (const code of ['tenant_isolation', 'tenant_status']) {
      const dict = await api('GET', `/dict/${code}`, { token: newAccess });
      check(`字典 ${code} 可用（租户页 StatusTag / 下拉）`, dict.body?.code === 0 && Array.isArray(dict.body?.data) && dict.body.data.length >= 2, `项数=${dict.body?.data?.length ?? 0}`);
    }

    const tenantList = await api('GET', '/tenants', { token: newAccess });
    const tenants = tenantList.body?.data?.items ?? [];
    check('GET /tenants 分页列表（四行基线 + 视图绝不外泄连接串）',
      tenantList.body?.code === 0 && tenants.length >= 4
      && ['legacy', 'acme', 'off', 'dedicated'].every((code) => tenants.some((t) => t.code === code))
      && tenants.every((t) => typeof t.dedicatedDbConfigured === 'boolean')
      && !JSON.stringify(tenants).includes('dbUrl'),
      `行数=${tenants.length}`);

    const tenantFiltered = await api('GET', '/tenants?isolation=dedicated', { token: newAccess });
    check('GET /tenants isolation=dedicated 过滤生效',
      tenantFiltered.body?.code === 0 && (tenantFiltered.body?.data?.items ?? []).every((t) => t.isolation === 'dedicated') && (tenantFiltered.body?.data?.items ?? []).length >= 1,
      `行数=${tenantFiltered.body?.data?.items?.length ?? 0}`);

    const tenantBadEnum = await api('GET', '/tenants?isolation=nope', { token: newAccess });
    check('GET /tenants 非法 isolation → 400/1001', tenantBadEnum.status === 400 && tenantBadEnum.body?.code === 1001, `code=${tenantBadEnum.body?.code}`);
    const tenantBadSort = await api('GET', '/tenants?sort=secret:asc', { token: newAccess });
    check('GET /tenants sort 未知字段 → 400/1001', tenantBadSort.status === 400 && tenantBadSort.body?.code === 1001, `code=${tenantBadSort.body?.code}`);

    // 开租户（编码带时间戳保证脚本可重入）
    const probeCode = `mock-probe-${Date.now().toString(36)}`;
    const createdTenant = await api('POST', '/tenants', { token: newAccess, body: { code: probeCode, name: '冒烟探针租户', isolation: 'shared', plan: 'probe' } });
    const probeId = createdTenant.body?.data?.id;
    check('POST /tenants 开租户（shared 不带连接串）', createdTenant.body?.code === 0 && !!probeId, `id=${probeId}`);

    const dedNoUrl = await api('POST', '/tenants', { token: newAccess, body: { code: 'mock-probe-ded', name: '探针独立库', isolation: 'dedicated' } });
    check('POST /tenants dedicated 不带 dbUrl → 400/1001', dedNoUrl.status === 400 && dedNoUrl.body?.code === 1001, `code=${dedNoUrl.body?.code}`);
    const sharedWithUrl = await api('POST', '/tenants', { token: newAccess, body: { code: 'mock-probe-shared-url', name: '共享库带连接串', isolation: 'shared', dbUrl: 'postgresql://x' } });
    check('POST /tenants shared 带 dbUrl → 400/1001（连接串会在迁移时清除）', sharedWithUrl.status === 400 && sharedWithUrl.body?.code === 1001, `code=${sharedWithUrl.body?.code}`);
    const dupTenant = await api('POST', '/tenants', { token: newAccess, body: { code: 'acme', name: '重复编码', isolation: 'shared' } });
    check('POST /tenants 编码重复 → 409/1003', dupTenant.status === 409 && dupTenant.body?.code === 1003, `code=${dupTenant.body?.code}`);

    const updatedTenant = await api('PUT', `/tenants/${probeId}`, { token: newAccess, body: { name: '冒烟探针租户（改名）', plan: 'probe-plus' } });
    check('PUT /tenants/:id 更新名称与套餐', updatedTenant.body?.code === 0 && updatedTenant.body?.data?.name === '冒烟探针租户（改名）' && updatedTenant.body?.data?.plan === 'probe-plus');

    const legacyDisable = await api('DELETE', '/tenants/0', { token: newAccess });
    check('DELETE /tenants/0（legacy）→ 400/1004', legacyDisable.status === 400 && legacyDisable.body?.code === 1004, `code=${legacyDisable.body?.code}`);

    const disabledTenant = await api('DELETE', `/tenants/${probeId}`, { token: newAccess });
    // 停用 = freeze：落规范码 3（ADR-0031 §2.3，不再直写存量码 0）；行保留（不物理删）
    check('DELETE /tenants/:id 停用（=freeze 落 status=3，行保留）', disabledTenant.body?.code === 0 && disabledTenant.body?.data?.status === 3);

    // 迁移长任务 → 任务面轮询 → 控制面切换
    const migrateJob = await api('POST', `/tenants/${probeId}/migrate`, { token: newAccess, body: { isolation: 'dedicated', dbUrl: 'postgresql://probe:pw@127.0.0.1:5432/probe' } });
    const migrateJobId = migrateJob.body?.data?.id;
    check('POST /tenants/:id/migrate 派发任务返回 JobView（pending + jobId）', migrateJob.body?.code === 0 && !!migrateJobId && migrateJob.body?.data?.status === 'pending' && migrateJob.body?.data?.type === 'tenant.migrate', `jobId=${migrateJobId}`);

    const migrateSame = await api('POST', '/tenants/1/migrate', { token: newAccess, body: { isolation: 'shared' } });
    check('POST /tenants/:id/migrate 同级别 → 400/1004', migrateSame.status === 400 && migrateSame.body?.code === 1004, `code=${migrateSame.body?.code}`);
    const migrateNoUrl = await api('POST', `/tenants/${probeId}/migrate`, { token: newAccess, body: { isolation: 'dedicated' } });
    check('POST /tenants/:id/migrate dedicated 不带 dbUrl → 400/1001', migrateNoUrl.status === 400 && migrateNoUrl.body?.code === 1001, `code=${migrateNoUrl.body?.code}`);

    let migrateJobView = null;
    for (let i = 0; i < 60 && (!migrateJobView || (migrateJobView.status !== 'succeeded' && migrateJobView.status !== 'failed')); i += 1) {
      const progress = await api('GET', `/jobs/${migrateJobId}/progress`, { token: newAccess });
      migrateJobView = progress.body?.data ?? null;
      if (migrateJobView && (migrateJobView.status === 'succeeded' || migrateJobView.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('GET /jobs/:id/progress 轮询到 succeeded（进度 100）', migrateJobView?.status === 'succeeded' && migrateJobView?.progress === 100, `status=${migrateJobView?.status} progress=${migrateJobView?.progress}`);

    const migratedProbe = await api('GET', `/tenants?keyword=${probeCode}`, { token: newAccess });
    check('迁移后 isolation=dedicated 生效（mock 同步应用控制面变更）', (migratedProbe.body?.data?.items ?? []).some((t) => t.id === probeId && t.isolation === 'dedicated' && t.dedicatedDbConfigured === true));

    const retryMigrate = await api('POST', `/jobs/${migrateJobId}/retry`, { token: newAccess });
    check('POST /jobs/:id/retry 成功任务 → 400/1004', retryMigrate.status === 400 && retryMigrate.body?.code === 1004, `code=${retryMigrate.body?.code}`);
    const jobMissing = await api('GET', '/jobs/job-nope/progress', { token: newAccess });
    check('GET /jobs/:id/progress 不存在 → 404/1002', jobMissing.status === 404 && jobMissing.body?.code === 1002, `code=${jobMissing.body?.code}`);

    // 审计异步导出（派发 → 轮询 → 下载 CSV）
    const exportDispatch = await api('GET', '/audit-logs/export', { token: newAccess });
    const exportDispatchId = exportDispatch.body?.data?.id;
    check('GET /audit-logs/export 派发导出任务', exportDispatch.body?.code === 0 && !!exportDispatchId && exportDispatch.body?.data?.type === 'audit.export', `jobId=${exportDispatchId}`);

    let exportProgress = null;
    for (let i = 0; i < 60 && (!exportProgress || (exportProgress.status !== 'succeeded' && exportProgress.status !== 'failed')); i += 1) {
      const progress = await api('GET', `/jobs/${exportDispatchId}/progress`, { token: newAccess });
      exportProgress = progress.body?.data ?? null;
      if (exportProgress && (exportProgress.status === 'succeeded' || exportProgress.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('导出任务轮询到 succeeded', exportProgress?.status === 'succeeded' && exportProgress?.progress === 100 && !!exportProgress?.fileName, `status=${exportProgress?.status} fileName=${exportProgress?.fileName}`);

    const csvDownload = await fetch(`${BASE}/jobs/${exportDispatchId}/download`, { headers: { Authorization: `Bearer ${newAccess}` } });
    const csvDownloadBytes = Buffer.from(await csvDownload.arrayBuffer());
    const csvDownloadText = csvDownloadBytes.toString('utf8');
    const csvHasBom = csvDownloadBytes[0] === 0xef && csvDownloadBytes[1] === 0xbb && csvDownloadBytes[2] === 0xbf;
    // M12 W2 OBS-14：CSV 列扩展（与 example-api buildAuditCsv / mock 产物逐字节同构）
    // M15 B4：15 列位置不变 + 8 个业务列追加在末尾（与后端 buildAuditCsv 逐字节同构）
    const csvHasHeader = csvDownloadText.includes(
      'id,createdAt,userId,module,action,targetType,targetId,ip,traceId,requestId,familyId,category,event,before,after,eventName,summary,targetLabel,actorLabel,reason,result,auditSource,risk',
    );
    const csvLines = csvDownloadText.split('\r\n').length;
    check('GET /jobs/:id/download 取回 CSV（BOM + 表头 + 行数据，非统一信封）',
      csvDownload.status === 200 && csvHasBom && csvHasHeader && csvLines >= 2,
      `status=${csvDownload.status} bytes=${csvDownloadBytes.length} bom=${csvHasBom} header=${csvHasHeader} lines=${csvLines} head=${JSON.stringify(csvDownloadText.slice(0, 72))}`);

    // ---- P2 平台审计（/audit-logs/platform*，跨租户维护入口）----
    // 与普通端点的差异必须能在 mock 下复现：普通行集 / 产物不含他租户演示行，platform 才有。
    const platformList = await api('GET', '/audit-logs/platform?page=1&pageSize=50', { token: newAccess });
    const platformItems = platformList.body?.data?.items ?? [];
    const platformTotal = platformList.body?.data?.total ?? 0;
    const normalNow = await api('GET', '/audit-logs?page=1&pageSize=1', { token: newAccess });
    const normalTotal = normalNow.body?.data?.total ?? 0;
    check('GET /audit-logs/platform 行集 = 普通行集 + 跨租户演示行（含他租户与 tenant 0）',
      platformList.body?.code === 0 && platformTotal === normalTotal + 3
      && platformItems.some((a) => a.tenantId === '3') && platformItems.some((a) => a.tenantId === '0'),
      `platform=${platformTotal} normal=${normalTotal}`);
    const platformNarrow = await api('GET', '/audit-logs/platform?tenant_id=3', { token: newAccess });
    const narrowItems = platformNarrow.body?.data?.items ?? [];
    check('platform 可按 tenant_id 收窄（普通端点会 4001 的维度，维护入口合法）',
      platformNarrow.body?.code === 0 && narrowItems.length === 1 && narrowItems.every((a) => a.tenantId === '3'),
      `total=${platformNarrow.body?.data?.total}`);
    const platformDetail = await api('GET', '/audit-logs/platform/a-platform-0001', { token: newAccess });
    check('GET /audit-logs/platform/:id 可读跨租户记录', platformDetail.body?.code === 0 && platformDetail.body?.data?.tenantId === '3', `code=${platformDetail.body?.code}`);
    const normalCrossDetail = await api('GET', '/audit-logs/a-platform-0001', { token: newAccess });
    check('同一记录走普通 /audit-logs/:id → 404（普通端点不因入口换名而跨租户）',
      normalCrossDetail.status === 404 && normalCrossDetail.body?.code === 1002, `http=${normalCrossDetail.status}`);

    // 平台导出：派发 → 轮询 → 产物含跨租户行；普通导出产物不含（两条链路产物同格式、不同范围）
    const platformExportDispatch = await api('GET', '/audit-logs/platform/export', { token: newAccess });
    const platformExportId = platformExportDispatch.body?.data?.id;
    let platformProgress = null;
    for (let i = 0; i < 60 && (!platformProgress || (platformProgress.status !== 'succeeded' && platformProgress.status !== 'failed')); i += 1) {
      const progress = await api('GET', `/jobs/${platformExportId}/progress`, { token: newAccess });
      platformProgress = progress.body?.data ?? null;
      if (platformProgress && (platformProgress.status === 'succeeded' || platformProgress.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const platformCsvResponse = await fetch(`${BASE}/jobs/${platformExportId}/download`, { headers: { Authorization: `Bearer ${newAccess}` } });
    const platformCsvText = Buffer.from(await platformCsvResponse.arrayBuffer()).toString('utf8');
    check('platform 导出任务 succeeded 且产物含跨租户行（普通产物不含）',
      platformExportDispatch.body?.code === 0 && platformProgress?.status === 'succeeded'
      && platformCsvText.includes('a-platform-0001') && platformCsvText.includes(',risk\r\n')
      && !csvDownloadText.includes('a-platform-0001'),
      `status=${platformProgress?.status} platformHas=${platformCsvText.includes('a-platform-0001')} normalHas=${csvDownloadText.includes('a-platform-0001')}`);

    // 双权限与入口可见性：alice 无 audit:read / system:tenant:ignore → 3002；菜单不下发
    const alicePlatformList = await api('GET', '/audit-logs/platform', { token: aliceToken });
    check('alice 无 audit:read → 平台审计 3002', alicePlatformList.body?.code === 3002, `code=${alicePlatformList.body?.code}`);
    const alicePlatformExport = await api('GET', '/audit-logs/platform/export', { token: aliceToken });
    check('alice 无 audit:export → 平台审计导出 3002', alicePlatformExport.body?.code === 3002, `code=${alicePlatformExport.body?.code}`);
    const adminMenus = await api('GET', '/auth/menus', { token: newAccess });
    const platformMenu = (adminMenus.body?.data ?? []).find((m) => m.path === '/system')?.children?.find((m) => m.path === '/system/audit-logs/platform');
    check('平台审计菜单：component / 权限码 system:tenant:ignore 与后端 seed 同形',
      platformMenu?.component === 'system/audit-logs/platform' && platformMenu?.permissionCode === 'system:tenant:ignore',
      platformMenu ? `component=${platformMenu.component}` : '未找到');
    const aliceMenus = await api('GET', '/auth/menus', { token: aliceToken });
    const alicePlatformMenu = (aliceMenus.body?.data ?? []).find((m) => m.path === '/system')?.children?.find((m) => m.path === '/system/audit-logs/platform');
    check('平台审计菜单不对无 system:tenant:ignore 的账号下发（入口不可见）', alicePlatformMenu === undefined);

    // ---- P2 归档审计（在线 / 归档切换的数据源）----
    const archiveList = await api('GET', '/audit-archives?page=1&pageSize=50', { token: newAccess });
    const archiveItems = archiveList.body?.data?.items ?? [];
    check('GET /audit-archives 返回归档冷数据（与在线表不同的数据集）',
      archiveList.body?.code === 0 && archiveItems.length > 0 && archiveItems.every((a) => a.id.startsWith('ar-')),
      `total=${archiveList.body?.data?.total}`);
    const archivePlatform = await api('GET', '/audit-archives/platform?page=1&pageSize=50', { token: newAccess });
    const archivePlatformItems = archivePlatform.body?.data?.items ?? [];
    check('GET /audit-archives/platform 含跨租户归档行（普通归档不含）',
      archivePlatform.body?.code === 0
      && archivePlatformItems.some((a) => a.id === 'ar-platform-0001' && a.tenantId === '3')
      && !archiveItems.some((a) => a.id.startsWith('ar-platform-')),
      `platform=${archivePlatform.body?.data?.total} normal=${archiveList.body?.data?.total}`);
    const archiveNarrow = await api('GET', '/audit-archives/platform?tenant_id=3', { token: newAccess });
    const archiveNarrowItems = archiveNarrow.body?.data?.items ?? [];
    check('平台归档可按 tenant_id 收窄（与平台在线同语义）',
      archiveNarrow.body?.code === 0 && archiveNarrowItems.length === 1 && archiveNarrowItems.every((a) => a.tenantId === '3'),
      `total=${archiveNarrow.body?.data?.total}`);
    const aliceArchive = await api('GET', '/audit-archives', { token: aliceToken });
    check('alice 无 audit:read → 归档 3002', aliceArchive.body?.code === 3002, `code=${aliceArchive.body?.code}`);
    const aliceArchivePlatform = await api('GET', '/audit-archives/platform', { token: aliceToken });
    check('普通账号访问平台归档 → 3002（与平台在线同权限）', aliceArchivePlatform.body?.code === 3002, `code=${aliceArchivePlatform.body?.code}`);

    /** 轮询任务至终态并下载 CSV 文本（归档导出复用） */
    const waitAndDownload = async (jobId) => {
      let progress = null;
      for (let i = 0; i < 60; i += 1) {
        const res = await api('GET', `/jobs/${jobId}/progress`, { token: newAccess });
        progress = res.body?.data ?? null;
        if (progress && (progress.status === 'succeeded' || progress.status === 'failed')) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
      const response = await fetch(`${BASE}/jobs/${jobId}/download`, { headers: { Authorization: `Bearer ${newAccess}` } });
      return { progress, text: Buffer.from(await response.arrayBuffer()).toString('utf8') };
    };

    const archiveExportDispatch = await api('GET', '/audit-archives/export', { token: newAccess });
    const archiveExportId = archiveExportDispatch.body?.data?.id;
    const archiveExportResult = await waitAndDownload(archiveExportId);
    check('归档导出任务 succeeded 且产物只含归档行（表头与在线产物一致）',
      archiveExportDispatch.body?.code === 0 && archiveExportDispatch.body?.data?.type === 'audit.archive.export'
      && archiveExportResult.progress?.status === 'succeeded'
      && archiveExportResult.text.includes('ar-0001') && !archiveExportResult.text.includes('ar-platform-0001')
      && archiveExportResult.text.split('\r\n')[0] === csvDownloadText.split('\r\n')[0],
      `status=${archiveExportResult.progress?.status} has=${archiveExportResult.text.includes('ar-0001')}`);

    const platformArchiveExportDispatch = await api('GET', '/audit-archives/platform/export', { token: newAccess });
    const platformArchiveExportResult = await waitAndDownload(platformArchiveExportDispatch.body?.data?.id);
    check('平台归档导出产物含跨租户归档行',
      platformArchiveExportDispatch.body?.code === 0 && platformArchiveExportResult.progress?.status === 'succeeded'
      && platformArchiveExportResult.text.includes('ar-platform-0001'),
      `status=${platformArchiveExportResult.progress?.status}`);

    // ---- P2 平台审计租户选项（受控查询：租户筛选不再依赖 tenant:read / 第一页 100 条）----
    const tenantOptions = await api('GET', '/audit-logs/platform/tenant-options?page=1&pageSize=100', { token: newAccess });
    const tenantOptionItems = tenantOptions.body?.data?.items ?? [];
    check('GET /audit-logs/platform/tenant-options 返回最小投影（id/code/name/status）',
      tenantOptions.body?.code === 0 && tenantOptionItems.length >= 2
      && tenantOptionItems.every((item) => ['code', 'id', 'name', 'status'].every((key) => key in item)),
      `total=${tenantOptions.body?.data?.total}`);
    const tenantKeywordOptions = await api('GET', '/audit-logs/platform/tenant-options?keyword=acme', { token: newAccess });
    const keywordItems = tenantKeywordOptions.body?.data?.items ?? [];
    check('租户选项支持 keyword 远程搜索（命中 acme）',
      tenantKeywordOptions.body?.code === 0 && keywordItems.length === 1 && keywordItems[0].code === 'acme',
      `n=${keywordItems.length}`);
    const tenantIdsOptions = await api('GET', '/audit-logs/platform/tenant-options?ids=3,0&page=1&pageSize=100', { token: newAccess });
    check('租户选项支持 ids 批量解析（列表行 → 名称，含 legacy 0）',
      tenantIdsOptions.body?.code === 0
      && JSON.stringify((tenantIdsOptions.body?.data?.items ?? []).map((item) => item.id).sort()) === JSON.stringify(['0', '3']),
      `ids=${(tenantIdsOptions.body?.data?.items ?? []).map((item) => item.id).join(',')}`);
    const tenantPagedOptions = await api('GET', '/audit-logs/platform/tenant-options?page=2&pageSize=1', { token: newAccess });
    check('租户选项可分页（page/pageSize/hasMore 元信息齐备）',
      tenantPagedOptions.body?.code === 0 && tenantPagedOptions.body?.data?.page === 2
      && tenantPagedOptions.body?.data?.items?.length === 1 && typeof tenantPagedOptions.body?.data?.hasMore === 'boolean',
      `page=${tenantPagedOptions.body?.data?.page}`);
    const aliceTenantOptions = await api('GET', '/audit-logs/platform/tenant-options', { token: aliceToken });
    check('普通账号访问平台租户选项 → 3002', aliceTenantOptions.body?.code === 3002, `code=${aliceTenantOptions.body?.code}`);

    // ---- M10 E-13 站内信 / 通知中心（mock 与 example-api §3.14 同构）----
    const notifList = await api('GET', '/notifications', { token: newAccess });
    const notifItems = notifList.body?.data?.items ?? [];
    check('GET /notifications 返回列表与未读数（分页字段齐备）',
      notifList.status === 200 && Array.isArray(notifItems) && notifItems.length >= 2
      && typeof notifList.body?.data?.unread === 'number' && notifList.body?.data?.page === 1
      && notifList.body?.data?.pageSize === 20,
      `total=${notifList.body?.data?.total} unread=${notifList.body?.data?.unread}`);
    check('列表项不含内部字段（userId / dedupeKey）',
      notifItems[0] !== undefined && notifItems[0].userId === undefined && notifItems[0].dedupeKey === undefined,
      `keys=${Object.keys(notifItems[0] ?? {}).join(',')}`);

    const unreadOnly = await api('GET', '/notifications?unreadOnly=true', { token: newAccess });
    check('unreadOnly=true 只回未读且 total 与 unread 一致',
      unreadOnly.body?.data?.total === unreadOnly.body?.data?.unread
      && (unreadOnly.body?.data?.items ?? []).every((item) => item.read === false),
      `total=${unreadOnly.body?.data?.total} unread=${unreadOnly.body?.data?.unread}`);

    const firstUnread = (unreadOnly.body?.data?.items ?? [])[0];
    const notifRead = await api('POST', `/notifications/${firstUnread?.id}/read`, { token: newAccess });
    check('POST /notifications/:id/read → read=true 且未读减一',
      (notifRead.status === 200 || notifRead.status === 201) && notifRead.body?.data?.read === true
      && notifRead.body?.data?.readAt != null,
      `http=${notifRead.status} read=${notifRead.body?.data?.read}`);

    // 归属人隔离反向验证：他人（bob，持 notification:read）读 admin 的消息 → 404 不泄露存在性
    const bobLogin = await api('POST', '/auth/login', { body: { account: 'bob', password: 'Bob@123456' } });
    const bobToken = bobLogin.body?.data?.accessToken ?? '';
    const bobRead = await api('POST', `/notifications/${firstUnread?.id}/read`, { token: bobToken });
    check('他人读你的消息 → 404（归属人即边界）', bobRead.status === 404, `http=${bobRead.status}`);
    const bobList = await api('GET', '/notifications', { token: bobToken });
    check('两人的消息面互相隔离（bob 看不到 admin 的消息）',
      (bobList.body?.data?.items ?? []).every((item) => item.id !== firstUnread?.id),
      `bob total=${bobList.body?.data?.total}`);

    const readAll = await api('POST', '/notifications/read-all', { token: newAccess });
    const afterReadAll = await api('GET', '/notifications/unread-count', { token: newAccess });
    check('POST /notifications/read-all 后未读数归零',
      (readAll.status === 200 || readAll.status === 201) && afterReadAll.body?.data?.unread === 0,
      `updated=${readAll.body?.data?.updated} unread=${afterReadAll.body?.data?.unread}`);

    const notifRemoved = await api('DELETE', `/notifications/${firstUnread?.id}`, { token: newAccess });
    const notifAfterRemove = await api('GET', '/notifications', { token: newAccess });
    check('DELETE /notifications/:id 后总数回落',
      notifRemoved.status === 200 && notifAfterRemove.body?.data?.total === (notifList.body?.data?.total ?? 0) - 1,
      `total=${notifAfterRemove.body?.data?.total}`);

    // 失败路径（mock 调试开关 simulate=fail）→ 重跑恢复
    const failDispatch = await api('GET', '/audit-logs/export?simulate=fail', { token: newAccess });
    const failDispatchId = failDispatch.body?.data?.id;
    let failProgress = null;
    for (let i = 0; i < 60 && (!failProgress || (failProgress.status !== 'succeeded' && failProgress.status !== 'failed')); i += 1) {
      const progress = await api('GET', `/jobs/${failDispatchId}/progress`, { token: newAccess });
      failProgress = progress.body?.data ?? null;
      if (failProgress && (failProgress.status === 'succeeded' || failProgress.status === 'failed')) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    check('simulate=fail 任务轮询到 failed（错误可读）', failProgress?.status === 'failed' && typeof failProgress?.error === 'string' && failProgress.error.length > 0, `dispatchStatus=${failDispatch.status} dispatchCode=${failDispatch.body?.code} msg=${failDispatch.body?.message?.slice(0, 80)} id=${failDispatchId} last=${JSON.stringify(failProgress)?.slice(0, 120)}`);

    const retriedFailed = await api('POST', `/jobs/${failDispatchId}/retry`, { token: newAccess });
    check('POST /jobs/:id/retry 失败任务原地重跑（pending）', retriedFailed.body?.code === 0 && retriedFailed.body?.data?.status === 'pending', `code=${retriedFailed.body?.code} status=${retriedFailed.body?.data?.status} msg=${retriedFailed.body?.message?.slice(0, 60)}`);

    // 越权：alice 无 tenant:* / audit:export；任务按归属人隔离
    const aliceTenants = await api('GET', '/tenants', { token: aliceToken });
    check('alice 无 tenant:read → 3002', aliceTenants.body?.code === 3002, `code=${aliceTenants.body?.code}`);
    const aliceExport = await api('GET', '/audit-logs/export', { token: aliceToken });
    check('alice 无 audit:export → 3002', aliceExport.body?.code === 3002, `code=${aliceExport.body?.code}`);
    const aliceJob = await api('GET', `/jobs/${migrateJobId}/progress`, { token: aliceToken });
    check('alice 读他人任务 → 404/1002（归属人隔离）', aliceJob.status === 404 && aliceJob.body?.code === 1002, `code=${aliceJob.body?.code}`);

    // ---------- roles / dict 排序白名单（BUG-15 增量）+ audit_module 字典（E-07） ----------
    phase('roles / dict 排序白名单 + audit_module 字典（E-07）');

    const rolesDesc = await api('GET', '/roles?sort=name:desc', { token: newAccess });
    const rolesDescNames = (rolesDesc.body?.data ?? []).map((r) => r.name);
    check('GET /roles?sort=name:desc 按名称倒序',
      rolesDesc.body?.code === 0 && rolesDescNames.length >= 3
      && rolesDescNames.every((n, i) => i === 0 || rolesDescNames[i - 1] >= n),
      `n=${rolesDescNames.length}`);

    const rolesBadSort = await api('GET', '/roles?sort=permission_count:asc', { token: newAccess });
    check('GET /roles?sort=permission_count → 400/1001（不静默忽略）',
      rolesBadSort.status === 400 && rolesBadSort.body?.code === 1001,
      `http=${rolesBadSort.status} code=${rolesBadSort.body?.code}`);

    const catsSorted = await api('GET', '/dict/categories?sort=code:asc', { token: newAccess });
    const catCodes = (catsSorted.body?.data ?? []).map((c) => c.code);
    check('GET /dict/categories?sort=code:asc 按编码升序',
      catsSorted.body?.code === 0 && catCodes.length >= 3
      && catCodes.every((c, i) => i === 0 || catCodes[i - 1] <= c),
      `n=${catCodes.length}`);

    const userStatusCat = (catsSorted.body?.data ?? []).find((c) => c.code === 'user_status');
    const itemsDesc = userStatusCat
      ? await api('GET', `/dict/items?category_id=${userStatusCat.id}&sort=label:desc`, { token: newAccess })
      : null;
    const itemLabels = (itemsDesc?.body?.data ?? []).map((i) => i.label);
    check('GET /dict/items?sort=label:desc 按标签倒序（user_status）',
      itemsDesc?.body?.code === 0 && itemLabels.length >= 2
      && itemLabels.every((l, i) => i === 0 || itemLabels[i - 1] >= l),
      `n=${itemLabels.length}`);

    const itemsBadSort = userStatusCat
      ? await api('GET', `/dict/items?category_id=${userStatusCat.id}&sort=color:asc`, { token: newAccess })
      : null;
    check('GET /dict/items?sort=color → 400/1001（不静默忽略）',
      itemsBadSort?.status === 400 && itemsBadSort.body?.code === 1001,
      `http=${itemsBadSort?.status} code=${itemsBadSort?.body?.code}`);

    const amDict = await api('GET', '/dict/audit_module', { token: newAccess });
    const amValues = (amDict.body?.data ?? []).map((i) => i.value).sort();
    check('GET /dict/audit_module 返回 auth/config/queue/role/saas/tenant/user 七项（E-07 + M9 + M15 补 saas）',
      amDict.body?.code === 0 && JSON.stringify(amValues) === JSON.stringify(['auth', 'config', 'queue', 'role', 'saas', 'tenant', 'user']),
      `values=${amValues.join(',')}`);

    // ---------- M9 参数配置（PRD-009 FR-08：同白名单 / 同错误码 / 同审计可见性） ----------
    phase('参数配置（M9 配置中心）');

    const cfgList = await api('GET', '/configs', { token: newAccess });
    const cfgData = cfgList.body?.data?.configs ?? [];
    check('GET /configs 返回白名单 12 键（boot 键不进列表）',
      cfgList.body?.code === 0 && cfgData.length === 12
      && cfgData.every((c) => c.hot === true && typeof c.key === 'string' && c.envKey)
      && !cfgData.some((c) => c.key === 'db.driver'),
      `count=${cfgData.length}`);
    check('GET /configs 元信息带驱动与快照版本',
      cfgList.body?.data?.meta?.driver === 'file' && typeof cfgList.body?.data?.meta?.snapshotVersion === 'number');

    const cfgPut = await api('PUT', '/configs/cache.ttl', { token: newAccess, body: { value: 900 } });
    check('PUT /configs/cache.ttl=900 生效（旧值 300 → 900）',
      cfgPut.body?.code === 0 && cfgPut.body?.data?.oldValue === 300 && cfgPut.body?.data?.newValue === 900,
      `code=${cfgPut.body?.code}`);

    const cfgList2 = await api('GET', '/configs', { token: newAccess });
    const ttlEntry = (cfgList2.body?.data?.configs ?? []).find((c) => c.key === 'cache.ttl');
    check('修改后列表 source 翻转为 runtime 且带更新时间',
      ttlEntry?.source === 'runtime' && !!ttlEntry?.updatedAt && ttlEntry?.value === 900,
      `source=${ttlEntry?.source} updatedAt=${ttlEntry?.updatedAt}`);

    const cfgBoot = await api('PUT', '/configs/db.driver', { token: newAccess, body: { value: 'mysql' } });
    check('boot 键 → 400/5001', cfgBoot.status === 400 && cfgBoot.body?.code === 5001, `http=${cfgBoot.status} code=${cfgBoot.body?.code}`);
    const cfgUnknown = await api('PUT', '/configs/nope.nope', { token: newAccess, body: { value: 1 } });
    check('未知键 → 404/5003', cfgUnknown.status === 404 && cfgUnknown.body?.code === 5003, `http=${cfgUnknown.status} code=${cfgUnknown.body?.code}`);
    const cfgInvalid = await api('PUT', '/configs/log.level', { token: newAccess, body: { value: 'verbose' } });
    check('非法值 → 400/5002（信封顶层 details 带原因，与 GlobalExceptionFilter 同构）',
      cfgInvalid.status === 400 && cfgInvalid.body?.code === 5002
      && (cfgInvalid.body?.details?.[0]?.message ?? '').length > 0,
      `http=${cfgInvalid.status} code=${cfgInvalid.body?.code}`);
    const cfgAfterInvalid = await api('GET', '/configs', { token: newAccess });
    check('非法值被拒后旧值保持（log.level 仍 info）',
      (cfgAfterInvalid.body?.data?.configs ?? []).find((c) => c.key === 'log.level')?.value === 'info');

    const cfgSame = await api('PUT', '/configs/cache.ttl', { token: newAccess, body: { value: 900 } });
    check('同值写入 = 无变更（版本号不递增）',
      cfgSame.body?.code === 0 && cfgSame.body?.data?.snapshotVersion === cfgPut.body?.data?.snapshotVersion,
      `v=${cfgSame.body?.data?.snapshotVersion}`);

    const cfgAudit = await api('GET', '/audit-logs?module=config&page=1&pageSize=50', { token: newAccess });
    const cfgAuditItems = cfgAudit.body?.data?.items ?? [];
    const cfgAuditOk = cfgAuditItems.find((a) => a.targetId === 'cache.ttl' && a.afterValue?.ok === true);
    const cfgAuditFail = cfgAuditItems.find((a) => a.targetId === 'log.level' && a.afterValue?.ok === false);
    check('变更审计可查：成功（old/new/source/operator）与失败（含拒绝原因）各一条',
      !!cfgAuditOk && cfgAuditOk.beforeValue?.value === 300 && cfgAuditOk.afterValue?.value === 900
      && cfgAuditOk.afterValue?.source === 'api' && cfgAuditOk.afterValue?.operator === 'admin'
      && !!cfgAuditFail && (cfgAuditFail.afterValue?.reason ?? '').length > 0,
      `ok=${!!cfgAuditOk} fail=${!!cfgAuditFail}`);

    const cfgAliceList = await api('GET', '/configs', { token: aliceToken });
    check('alice 无 system:config:read → 3002', cfgAliceList.body?.code === 3002, `code=${cfgAliceList.body?.code}`);
    const cfgAlicePut = await api('PUT', '/configs/cache.ttl', { token: aliceToken, body: { value: 1 } });
    check('alice 无 system:config:write → 3002', cfgAlicePut.body?.code === 3002, `code=${cfgAlicePut.body?.code}`);

    // ---------- 前端错误遥测（M10 E-17，公开端点 + fire-and-forget 契约） ----------
    phase('前端错误遥测（/telemetry/client-errors，E-17）');
    const rumReport = {
      source: 'error',
      message: 'Cannot read properties of undefined',
      stack: 'TypeError: Cannot read properties of undefined\n    at render (AppMain.vue:42:11)',
      resource: null,
      page: '/dashboard',
      url: 'http://mock.local/dashboard',
      traceId: 'b3f1c9d2e4f5a6b7',
      repeat: 1,
      at: '2026-10-15T12:00:00.000Z',
    };
    const rumOk = await api('POST', '/telemetry/client-errors', { body: { app: 'admin-web', reports: [rumReport] } });
    check('合法上报 → { received, total }（公开端点，无需 token）',
      rumOk.body?.code === 0 && rumOk.body?.data?.received === 1 && typeof rumOk.body?.data?.total === 'number',
      `code=${rumOk.body?.code} data=${JSON.stringify(rumOk.body?.data)}`);
    const rumBatch = await api('POST', '/telemetry/client-errors', {
      body: { app: 'admin-web', reports: Array.from({ length: 10 }, () => rumReport) },
    });
    check('单批 10 条（RUM_MAX_BATCH 同口径）放行', rumBatch.body?.code === 0 && rumBatch.body?.data?.received === 10);
    const rumOver = await api('POST', '/telemetry/client-errors', {
      body: { app: 'admin-web', reports: Array.from({ length: 11 }, () => rumReport) },
    });
    check('单批 11 条 → 400/1001', rumOver.status === 400 && rumOver.body?.code === 1001, `http=${rumOver.status} code=${rumOver.body?.code}`);
    const rumEmpty = await api('POST', '/telemetry/client-errors', { body: { app: 'admin-web', reports: [] } });
    check('空 reports → 400/1001', rumEmpty.status === 400 && rumEmpty.body?.code === 1001, `http=${rumEmpty.status} code=${rumEmpty.body?.code}`);
    const rumBadSource = await api('POST', '/telemetry/client-errors', {
      body: { app: 'admin-web', reports: [{ ...rumReport, source: 'weird' }] },
    });
    check('非法 source → 400/1001 且 details 定位 reports[0].source',
      rumBadSource.status === 400 && rumBadSource.body?.code === 1001
      && rumBadSource.body?.details?.[0]?.field === 'reports[0].source',
      `http=${rumBadSource.status} code=${rumBadSource.body?.code} field=${rumBadSource.body?.details?.[0]?.field}`);
    const rumNoApp = await api('POST', '/telemetry/client-errors', { body: { reports: [rumReport] } });
    check('缺 app → 400/1001', rumNoApp.status === 400 && rumNoApp.body?.code === 1001, `http=${rumNoApp.status} code=${rumNoApp.body?.code}`);

    // ---------- M10 E-09 附件（/files 三端点；PRD-010） ----------
    phase('M10 E-09 附件（/files）');
    const fileBytes = Buffer.from(`E-09 mock upload ${Date.now()}\n二进制保真 \x00\x01\xfe\xff`);
    const boundary = `----fw-smoke-${Date.now()}`;
    const multipart = Buffer.concat([
      Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="冒烟附件.txt"\r\nContent-Type: text/plain\r\n\r\n`),
      fileBytes,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);
    const upload = await fetch(`${BASE}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: multipart,
    });
    const uploadJson = await upload.json().catch(() => null);
    check('上传成功（信封含 id/url/size）',
      upload.status === 200 && uploadJson?.code === 0 && typeof uploadJson?.data?.id === 'string' && uploadJson.data.url === `/api/v1/files/${uploadJson.data.id}/download`,
      `http=${upload.status} code=${uploadJson?.code}`);
    const fileId = uploadJson?.data?.id ?? '';
    check('响应 size 与字节一致', uploadJson?.data?.size === fileBytes.length, `size=${uploadJson?.data?.size} expect=${fileBytes.length}`);

    const fileMeta = await api('GET', `/files/${fileId}`, { token: adminToken });
    check('元数据可查（含原始文件名）', fileMeta.body?.code === 0 && fileMeta.body?.data?.originalName === '冒烟附件.txt', `code=${fileMeta.body?.code}`);

    const download = await fetch(`${BASE}/files/${fileId}/download`, { headers: { Authorization: `Bearer ${adminToken}` } });
    const downloadBytes = Buffer.from(await download.arrayBuffer());
    check('下载逐字节一致（N-02 同构纪律）', download.status === 200 && downloadBytes.equals(fileBytes), `http=${download.status} bytes=${downloadBytes.length}`);

    const badUpload = await fetch(`${BASE}/files`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${adminToken}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="evil.exe"\r\nContent-Type: application/octet-stream\r\n\r\nxx\r\n--${boundary}--\r\n`),
      ]),
    });
    const badUploadJson = await badUpload.json().catch(() => null);
    check('白名单外类型 → 400（与 @fw/storage 文案逐字一致）',
      badUpload.status === 400 && badUploadJson?.code === 1001 && badUploadJson?.message === '不支持的文件类型：.exe',
      `http=${badUpload.status} msg=${badUploadJson?.message}`);

    const fileNoToken = await fetch(`${BASE}/files/${fileId}/download`);
    check('未登录下载 → 401', fileNoToken.status === 401, `http=${fileNoToken.status}`);
    const fileMissing = await api('GET', '/files/none-exists', { token: adminToken });
    check('不存在文件 → 404 不泄露存在性', fileMissing.status === 404, `http=${fileMissing.status}`);

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
