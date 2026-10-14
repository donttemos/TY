/*
 * @file admin-web mock 全链路冒烟脚本
 * @description 不等后端的独立验证（PRD-005 验收 / TC-WEB）：启动 vite dev server（自动挂载 C-06 mock），
 *   以真实 HTTP 走完 认证（登录/me/错误码/禁用账号）→ 菜单 → 字典 → 用户 CRUD → 越权（3002）→
 *   无感刷新（轮换 + 旧 token 失效）→ 角色/菜单树/审计/订单 → 队列管理（M7：状态/指标/cron 触发/死信
 *   重放/暂停恢复/清空/越权）→ 登出 全链路，并校验 C-06 契约关键字段；
 *   末尾若存在 dist 产物则执行 bundle 体积门禁（gzip 总量）。任一断言失败即非零退出。
 *   运行：pnpm smoke（cwd 需为 apps/admin-web）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 修 bundle 门禁统计缺陷：vendor-element-plus 由「取最后一个匹配文件」改为累加，
 *   否则 rolldown（vite 8）产物顺序变化后只量到 CSS 文件，门禁形同失效
 * @modified 2026-10-13 donttemo M7：新增队列管理冒烟段（/queue/* 全端点 + system:queue:* 越权拦截）
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
