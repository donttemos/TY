/*
 * @file 管理后台端点冒烟验证脚本（C-06 契约 §3.2~§3.6 收口）
 * @description 覆盖 C-06 契约声明、前端 admin-web 已调用、而后端 M3 未落地的端点：
 *   登录设备（/auth/sessions）、审计详情（/audit-logs/:id）、菜单维护（/menus/*）、
 *   字典（/dict/*）、用户维护（/users 详情/增改删/重置密码）、角色维护（/roles 增改删/复制）。
 *   这些端点此前只在 mock 中存在，接真实 API 后集体 404（线上点页面才暴露），
 *   现由本脚本逐个验证，并由 scripts/check-api-parity.mjs 做静态对撞兜底。
 *   断言遵循「形状 + 下界 + 关键权限码」，不与种子总数耦合。
 *   所有写操作只用临时创建的实体，结束即清理，不污染种子数据。
 *   前置：已执行 fw db:migrate + fw db:seed，且服务监听 127.0.0.1:3000。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api
 */

const BASE = 'http://127.0.0.1:3000';

/** 种子账号 */
const ADMIN = { account: 'admin', password: 'Admin@123456' };
const ALICE = { account: 'alice', password: 'Alice@123456' };

/** @Post 默认返回 201 Created，统一按 2xx 成功判定 */
function isOk(status) {
  return status >= 200 && status < 300;
}

/** 断言计数 */
let pass = 0;
let total = 0;

function check(name, ok, detail = '') {
  total++;
  if (ok) pass++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  —— ${detail}` : ''}`);
}

/** 请求工具：返回 { status, body } */
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
  return { status: res.status, body };
}

async function login(user, label) {
  const res = await call('/api/v1/auth/login', { method: 'POST', body: user });
  // 登录接口限流 60 秒 10 次（AUTH_LOGIN_RATE_LIMIT）：连续跑本脚本会打满。
  // 此时后续断言必然全是 401，继续跑只会输出一堆无意义的假失败，直接退出并说明原因。
  if (res.status === 429) {
    check(`${label} 登录被限流`, false, '登录限流 60 秒 10 次已打满，请间隔 60 秒再跑（CI 中为独立 step，不会累积）');
    console.error('\n[smoke-admin] 登录限流：提前退出，避免输出无意义的 401 断言');
    process.exit(1);
  }
  check(`${label} 登录返回双 token`, isOk(res.status) && res.body.code === 0 && !!res.body.data?.accessToken,
    `http=${res.status} code=${res.body.code}`);
  return res.body.data ?? {};
}

async function main() {
  const admin = await login(ADMIN, 'admin');
  const token = admin.accessToken;

  // ======================= 字典（/api/v1/dict） =======================
  console.log('\n---- 字典（PRD-005 FR-07：页面不硬编码枚举） ----');

  const categories = await call('/api/v1/dict/categories', { token });
  const codes = (categories.body.data ?? []).map((item) => item.code);
  check('GET /dict/categories 返回分类列表',
    isOk(categories.status) && Array.isArray(categories.body.data) && codes.includes('user_status') && codes.includes('data_scope'),
    `http=${categories.status} 分类=${codes.join(',')}`);

  // 前端真实消费点：users 页 user_status、roles 页 data_scope、审计页 audit_action、订单页 order_channel
  for (const [code, probe] of [
    ['user_status', (items) => items.some((i) => i.value === '1' && i.label === '启用')],
    ['data_scope', (items) => ['all', 'org_below', 'org', 'self'].every((v) => items.some((i) => i.value === v))],
    ['audit_action', (items) => items.some((i) => i.value === 'login')],
    ['order_channel', (items) => items.length >= 1],
  ]) {
    const res = await call(`/api/v1/dict/${code}`, { token });
    const items = res.body.data ?? [];
    check(`GET /dict/${code} 返回可用字典项（useDict 消费入口）`,
      isOk(res.status) && Array.isArray(items) && items.length > 0 && probe(items) && items.every((i) => typeof i.label === 'string' && typeof i.value === 'string'),
      `http=${res.status} 项数=${items.length}`);
  }

  const unknownDict = await call('/api/v1/dict/no-such-code', { token });
  check('GET /dict/:code 编码不存在返回空数组而非报错（避免页面首次渲染即失败）',
    isOk(unknownDict.status) && Array.isArray(unknownDict.body.data) && unknownDict.body.data.length === 0,
    `http=${unknownDict.status}`);

  // 临时分类 + 项：验证写链路后清理
  const tmpCategory = await call('/api/v1/dict/categories', {
    method: 'POST', token, body: { code: 'smoke_probe', name: '冒烟探针分类' },
  });
  const categoryId = tmpCategory.body.data?.id;
  check('POST /dict/categories 新建分类', isOk(tmpCategory.status) && !!categoryId, `http=${tmpCategory.status}`);

  const dupCategory = await call('/api/v1/dict/categories', {
    method: 'POST', token, body: { code: 'smoke_probe', name: '重复编码' },
  });
  check('POST /dict/categories 编码重复 → 409/1003', dupCategory.status === 409 && dupCategory.body.code === 1003,
    `http=${dupCategory.status} code=${dupCategory.body.code}`);

  const renamed = await call(`/api/v1/dict/categories/${categoryId}`, {
    method: 'PUT', token, body: { name: '冒烟探针分类（改名）' },
  });
  check('PUT /dict/categories/:id 更新分类名称', isOk(renamed.status) && renamed.body.data?.name === '冒烟探针分类（改名）',
    `http=${renamed.status}`);

  const tmpItem = await call('/api/v1/dict/items', {
    method: 'POST', token, body: { categoryId, label: '探针甲', value: 'a', color: 'primary', sort: 1 },
  });
  const itemId = tmpItem.body.data?.id;
  check('POST /dict/items 新建字典项', isOk(tmpItem.status) && !!itemId, `http=${tmpItem.status}`);

  const badColor = await call('/api/v1/dict/items', {
    method: 'POST', token, body: { categoryId, label: '非法颜色', value: 'bad', color: 'not-a-color' },
  });
  check('POST /dict/items 非法 color → 400/1001', badColor.status === 400 && badColor.body.code === 1001,
    `http=${badColor.status} code=${badColor.body.code}`);

  const items = await call(`/api/v1/dict/items?category_id=${categoryId}`, { token });
  check('GET /dict/items?category_id= 返回该分类字典项',
    isOk(items.status) && (items.body.data ?? []).some((i) => i.id === itemId),
    `http=${items.status}`);

  const itemUpdated = await call(`/api/v1/dict/items/${itemId}`, {
    method: 'PUT', token, body: { label: '探针甲（改）' },
  });
  check('PUT /dict/items/:id 更新字典项', isOk(itemUpdated.status) && itemUpdated.body.data?.label === '探针甲（改）',
    `http=${itemUpdated.status}`);

  const itemDeleted = await call(`/api/v1/dict/items/${itemId}`, { method: 'DELETE', token });
  check('DELETE /dict/items/:id 删除字典项', isOk(itemDeleted.status), `http=${itemDeleted.status}`);

  const categoryDeleted = await call(`/api/v1/dict/categories/${categoryId}`, { method: 'DELETE', token });
  check('DELETE /dict/categories/:id 删除分类', isOk(categoryDeleted.status), `http=${categoryDeleted.status}`);

  const afterDelete = await call('/api/v1/dict/categories', { token });
  check('删除后分类列表不再含探针分类', !(afterDelete.body.data ?? []).some((i) => i.id === categoryId));

  const recreated = await call('/api/v1/dict/categories', {
    method: 'POST', token, body: { code: 'smoke_probe', name: '冒烟探针分类（重建）' },
  });
  check('软删分类后同编码可重建（唯一键已释放，否则同编码永远 409）',
    isOk(recreated.status) && !!recreated.body.data?.id, `http=${recreated.status} code=${recreated.body.code}`);
  if (recreated.body.data?.id) {
    await call(`/api/v1/dict/categories/${recreated.body.data.id}`, { method: 'DELETE', token });
  }

  // ======================= 菜单维护（/api/v1/menus） =======================
  console.log('\n---- 菜单维护（/api/v1/menus） ----');

  const menuTree = await call('/api/v1/menus/tree', { token });
  const firstMenu = (menuTree.body.data ?? [])[0];
  check('GET /menus/tree 返回扁平菜单列表（管理页自行渲染树）',
    isOk(menuTree.status) && Array.isArray(menuTree.body.data) && menuTree.body.data.length > 0
    && firstMenu && typeof firstMenu.parentId === 'string' && typeof firstMenu.visible === 'boolean' && typeof firstMenu.sort === 'number',
    `http=${menuTree.status} 菜单数=${(menuTree.body.data ?? []).length}`);

  const tmpMenu = await call('/api/v1/menus', {
    method: 'POST', token, body: { name: '冒烟探针菜单', path: '/smoke-probe', component: 'dashboard/index', sort: 99 },
  });
  const menuId = tmpMenu.body.data?.id;
  check('POST /menus 新建菜单（parentId 缺省为顶级）',
    isOk(tmpMenu.status) && !!menuId && tmpMenu.body.data?.parentId === '0',
    `http=${tmpMenu.status}`);

  const childMenu = await call('/api/v1/menus', {
    method: 'POST', token, body: { parentId: menuId, name: '冒烟探针子菜单', sort: 1 },
  });
  const childId = childMenu.body.data?.id;
  check('POST /menus 新建子菜单', isOk(childMenu.status) && !!childId, `http=${childMenu.status}`);

  const blockedDelete = await call(`/api/v1/menus/${menuId}`, { method: 'DELETE', token });
  check('DELETE /menus/:id 有子菜单时拒绝（避免层级悬空）',
    blockedDelete.status === 400 && blockedDelete.body.code === 1004,
    `http=${blockedDelete.status} code=${blockedDelete.body.code}`);

  const childDeleted = await call(`/api/v1/menus/${childId}`, { method: 'DELETE', token });
  check('DELETE /menus/:id 删除子菜单', isOk(childDeleted.status), `http=${childDeleted.status}`);

  const menuRenamed = await call(`/api/v1/menus/${menuId}`, {
    method: 'PUT', token, body: { name: '冒烟探针菜单（改名）' },
  });
  check('PUT /menus/:id 更新菜单', isOk(menuRenamed.status) && menuRenamed.body.data?.name === '冒烟探针菜单（改名）',
    `http=${menuRenamed.status}`);

  const menuDeleted = await call(`/api/v1/menus/${menuId}`, { method: 'DELETE', token });
  check('DELETE /menus/:id 子级清空后删除父菜单', isOk(menuDeleted.status), `http=${menuDeleted.status}`);

  // ======================= 用户维护（/api/v1/users） =======================
  console.log('\n---- 用户维护（/api/v1/users） ----');

  const me = await call('/api/v1/auth/me', { token });
  const myId = me.body.data?.id;

  const userList = await call('/api/v1/users?page=1&pageSize=20', { token });
  const listItem = (userList.body.data?.items ?? [])[0];
  check('GET /users 列表项含 roleIds 与 createdAt（C-06 契约 §3.3，供分配角色预选）',
    isOk(userList.status) && listItem && Array.isArray(listItem.roleIds) && !!listItem.createdAt,
    `http=${userList.status} 首页首项 roleIds=${JSON.stringify(listItem?.roleIds ?? [])}`);
  check('GET /users 列表中至少一个用户带角色（roleIds 非空，证明投影生效）',
    (userList.body.data?.items ?? []).some((item) => Array.isArray(item.roleIds) && item.roleIds.length > 0),
    `总数=${userList.body.data?.total}`);

  const detail = await call(`/api/v1/users/${myId}`, { token });
  check('GET /users/:id 用户详情', isOk(detail.status) && detail.body.data?.id === myId, `http=${detail.status}`);

  const missingUser = await call('/api/v1/users/00000000-0000-0000-0000-000000000000', { token });
  check('GET /users/:id 不存在 → 404/1002', missingUser.status === 404 && missingUser.body.code === 1002,
    `http=${missingUser.status} code=${missingUser.body.code}`);

  const weak = await call('/api/v1/users', {
    method: 'POST', token, body: { username: 'smoke_weak', password: '123' },
  });
  check('POST /users 弱密码被后端拒绝（强度校验不信任前端）',
    weak.status === 400 && weak.body.code === 1001, `http=${weak.status} code=${weak.body.code}`);

  const created = await call('/api/v1/users', {
    method: 'POST',
    token,
    body: {
      username: 'smoke_probe_user',
      password: 'Probe@123456',
      nickname: '冒烟探针用户',
      email: 'smoke-probe@example.com',
      roleIds: [],
    },
  });
  const probeUserId = created.body.data?.id;
  check('POST /users 新建用户', isOk(created.status) && !!probeUserId, `http=${created.status}`);

  const dupUser = await call('/api/v1/users', {
    method: 'POST', token, body: { username: 'smoke_probe_user', password: 'Probe@123456' },
  });
  check('POST /users 账号重复 → 409/1003', dupUser.status === 409 && dupUser.body.code === 1003,
    `http=${dupUser.status} code=${dupUser.body.code}`);

  const renameAttempt = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { username: 'smoke_renamed' },
  });
  check('PUT /users/:id 不允许改账号（账号是登录与审计锚点）',
    renameAttempt.status === 400 && renameAttempt.body.code === 1004,
    `http=${renameAttempt.status} code=${renameAttempt.body.code}`);

  const updated = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { nickname: '冒烟探针用户（改名）' },
  });
  check('PUT /users/:id 更新资料', isOk(updated.status) && updated.body.data?.nickname === '冒烟探针用户（改名）',
    `http=${updated.status}`);

  const reset = await call(`/api/v1/users/${probeUserId}/reset-password`, { method: 'POST', token });
  const oneTime = reset.body.data?.oneTimePassword;
  check('POST /users/:id/reset-password 返回一次性密码',
    isOk(reset.status) && typeof oneTime === 'string' && oneTime.length >= 8, `http=${reset.status}`);

  const oldPasswordLogin = await call('/api/v1/auth/login', {
    method: 'POST', body: { account: 'smoke_probe_user', password: 'Probe@123456' },
  });
  check('重置后旧密码立即失效（重置即强制下线）',
    oldPasswordLogin.status === 401 || oldPasswordLogin.body.code !== 0,
    `http=${oldPasswordLogin.status} code=${oldPasswordLogin.body.code}`);

  const oneTimeLogin = await call('/api/v1/auth/login', {
    method: 'POST', body: { account: 'smoke_probe_user', password: oneTime },
  });
  check('一次性密码可登录', isOk(oneTimeLogin.status) && oneTimeLogin.body.code === 0,
    `http=${oneTimeLogin.status} code=${oneTimeLogin.body.code}`);

  const selfDelete = await call(`/api/v1/users/${myId}`, { method: 'DELETE', token });
  check('DELETE /users/:id 不能删除当前登录账号',
    selfDelete.status === 400 && selfDelete.body.code === 1004, `http=${selfDelete.status} code=${selfDelete.body.code}`);

  // 探针用户暂不删除：角色段要用它验证「仍有用户持有时拒绝删角色」，见下方收尾段

  // ======================= 角色维护（/api/v1/roles） =======================
  console.log('\n---- 角色维护（/api/v1/roles） ----');

  const roles = await call('/api/v1/roles', { token });
  const adminRole = (roles.body.data ?? []).find((role) => role.code === 'admin');
  check('GET /roles 列表项含 permissionCount / remark / dataScope / isSystem（C-06 契约 §3.4）',
    isOk(roles.status) && adminRole && typeof adminRole.permissionCount === 'number' && adminRole.permissionCount > 0
    && typeof adminRole.remark === 'string' && typeof adminRole.isSystem === 'boolean',
    `http=${roles.status} admin 权限点=${adminRole?.permissionCount}`);

  const tmpRole = await call('/api/v1/roles', {
    method: 'POST', token, body: { code: 'smoke_probe_role', name: '冒烟探针角色', dataScope: 'self', sort: 99 },
  });
  const roleId = tmpRole.body.data?.id;
  check('POST /roles 新建角色', isOk(tmpRole.status) && !!roleId, `http=${tmpRole.status}`);

  const roleRenamed = await call(`/api/v1/roles/${roleId}`, {
    method: 'PUT', token, body: { name: '冒烟探针角色（改名）' },
  });
  check('PUT /roles/:id 更新角色', isOk(roleRenamed.status) && roleRenamed.body.data?.name === '冒烟探针角色（改名）',
    `http=${roleRenamed.status}`);

  const roleCodeChange = await call(`/api/v1/roles/${roleId}`, {
    method: 'PUT', token, body: { code: 'smoke_probe_role_renamed' },
  });
  check('PUT /roles/:id 不允许改角色编码（编码是权限判定锚点）',
    roleCodeChange.status === 400 && roleCodeChange.body.code === 1004,
    `http=${roleCodeChange.status} code=${roleCodeChange.body.code}`);

  // 回归（真机事故）：roleIds:[""] 曾被无校验写库，用户角色集被替换成无效关联、权限归零。
  // 写库前校验必须把它变成明确的 1001，且既有角色原样保留。
  const badRoleIds = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { roleIds: [''] },
  });
  check('PUT /users/:id 拒绝空串角色 ID（roleIds:[""] 曾静默摧毁 admin 角色）',
    badRoleIds.status === 400 && badRoleIds.body.code === 1001,
    `http=${badRoleIds.status} code=${badRoleIds.body.code}`);
  const badRoleIdsUnknown = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { roleIds: ['00000000-0000-0000-0000-000000000000'] },
  });
  check('PUT /users/:id 拒绝不存在的角色 ID',
    badRoleIdsUnknown.status === 400 && badRoleIdsUnknown.body.code === 1001,
    `http=${badRoleIdsUnknown.status} code=${badRoleIdsUnknown.body.code}`);

  // 回归（部分更新）：角色校验原先发生在 updateUser 之后 —— 非法角色返回 400 时，
  // 同一请求里的资料字段已落库，客户端收到失败却已生效。校验前置后，任一入参非法即整体不写。
  const beforePartial = await call(`/api/v1/users/${probeUserId}`, { token });
  const partialUpdate = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { nickname: '冒烟不应生效', roleIds: [''] },
  });
  const afterPartial = await call(`/api/v1/users/${probeUserId}`, { token });
  const partialNick = beforePartial.body.data?.nickname;
  check('PUT /users/:id 角色非法时资料字段不被部分写入（整体不写）',
    partialUpdate.status === 400 && partialUpdate.body.code === 1001 &&
      afterPartial.body.data?.nickname === partialNick,
    `http=${partialUpdate.status} code=${partialUpdate.body.code} before=${partialNick} after=${afterPartial.body.data?.nickname}`);

  const adminScopeChange = await call(`/api/v1/roles/${adminRole.id}`, {
    method: 'PUT', token, body: { dataScope: 'self' },
  });
  check('PUT /roles/:id 内置角色不可调窄数据范围（保证系统可管理性）',
    adminScopeChange.status === 400 && adminScopeChange.body.code === 1004,
    `http=${adminScopeChange.status} code=${adminScopeChange.body.code}`);

  // 先授权再复制，验证权限是否随角色一起复制
  const permissions = await call('/api/v1/permissions', { token });
  const probePermId = (permissions.body.data ?? [])
    .flatMap((group) => group.items ?? [])
    .find((perm) => perm.code === 'user:read')?.id;
  const granted = await call(`/api/v1/roles/${roleId}/permissions`, {
    method: 'PUT', token, body: { permissionIds: probePermId ? [probePermId] : [] },
  });
  check('PUT /roles/:id/permissions 授权（复制前的准备）', isOk(granted.status), `http=${granted.status}`);

  // 与 roleIds 同源的写库前校验：空串/失效权限点 ID 会被静默写进 role_permission
  const badPermIds = await call(`/api/v1/roles/${roleId}/permissions`, {
    method: 'PUT', token, body: { permissionIds: [''] },
  });
  check('PUT /roles/:id/permissions 拒绝空串权限点 ID',
    badPermIds.status === 400 && badPermIds.body.code === 1001,
    `http=${badPermIds.status} code=${badPermIds.body.code}`);

  const copied = await call(`/api/v1/roles/${roleId}/copy`, { method: 'POST', token });
  const copiedId = copied.body.data?.id;
  check('POST /roles/:id/copy 复制角色且权限随行',
    isOk(copied.status) && !!copiedId && copied.body.data?.code.startsWith('smoke_probe_role-copy')
    && copied.body.data?.permissionCount === 1,
    `http=${copied.status} code=${copied.body.data?.code} 权限点=${copied.body.data?.permissionCount}`);

  const adminRoleDelete = await call(`/api/v1/roles/${adminRole.id}`, { method: 'DELETE', token });
  check('DELETE /roles/:id 内置角色不可删除',
    adminRoleDelete.status === 400 && adminRoleDelete.body.code === 1004,
    `http=${adminRoleDelete.status} code=${adminRoleDelete.body.code}`);

  // 复制出的角色无人持有，可直接删；被 admin 持有的探针角色需先验证「有用户即拒删」
  // 把探针角色分配给探针用户，才能验证「仍有用户持有时拒绝删角色」
  const assigned = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { roleIds: [roleId] },
  });
  check('PUT /users/:id 分配角色（roleIds 覆盖式，为删角色校验做准备）',
    isOk(assigned.status) && (assigned.body.data?.roleIds ?? []).includes(roleId),
    `http=${assigned.status} roleIds=${JSON.stringify(assigned.body.data?.roleIds ?? [])}`);

  const heldRoleDelete = await call(`/api/v1/roles/${roleId}`, { method: 'DELETE', token });
  check('DELETE /roles/:id 仍有用户持有时拒绝（先解绑）',
    heldRoleDelete.status === 400 && heldRoleDelete.body.code === 1004,
    `http=${heldRoleDelete.status} code=${heldRoleDelete.body.code}`);

  const unassigned = await call(`/api/v1/users/${probeUserId}`, {
    method: 'PUT', token, body: { roleIds: [] },
  });
  check('PUT /users/:id 解绑角色', isOk(unassigned.status) && (unassigned.body.data?.roleIds ?? []).length === 0,
    `http=${unassigned.status}`);

  const copiedDeleted = await call(`/api/v1/roles/${copiedId}`, { method: 'DELETE', token });
  check('DELETE /roles/:id 删除无人持有的角色', isOk(copiedDeleted.status), `http=${copiedDeleted.status}`);

  const probeRoleDeleted = await call(`/api/v1/roles/${roleId}`, { method: 'DELETE', token });
  check('DELETE /roles/:id 解绑后删除角色', isOk(probeRoleDeleted.status), `http=${probeRoleDeleted.status}`);

  const rolesAfter = await call('/api/v1/roles', { token });
  check('清理后探针角色已不在列表', !(rolesAfter.body.data ?? []).some((role) => role.id === roleId || role.id === copiedId));

  // ---- 收尾：删除探针用户（角色关联已清空） ----
  const deleted = await call(`/api/v1/users/${probeUserId}`, { method: 'DELETE', token });
  check('DELETE /users/:id 软删除用户', isOk(deleted.status), `http=${deleted.status}`);

  const afterUserDelete = await call(`/api/v1/users/${probeUserId}`, { token });
  check('软删后详情 → 404/1002', afterUserDelete.status === 404 && afterUserDelete.body.code === 1002,
    `http=${afterUserDelete.status} code=${afterUserDelete.body.code}`);

  const recreatedUser = await call('/api/v1/users', {
    method: 'POST', token, body: { username: 'smoke_probe_user', password: 'Probe@123456' },
  });
  check('软删用户后同名账号可重建（username 唯一键已释放）',
    isOk(recreatedUser.status) && !!recreatedUser.body.data?.id,
    `http=${recreatedUser.status} code=${recreatedUser.body.code}`);
  if (recreatedUser.body.data?.id) {
    await call(`/api/v1/users/${recreatedUser.body.data.id}`, { method: 'DELETE', token });
  }

  // ======================= 登录设备（/api/v1/auth/sessions） =======================
  console.log('\n---- 登录设备（/api/v1/auth/sessions） ----');

  // 第二个「设备」：不同 User-Agent 再登一次，形成第二个轮换族
  const secondLogin = await fetch(BASE + '/api/v1/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': 'smoke-probe-device/1.0' },
    body: JSON.stringify(ADMIN),
  });
  const secondBody = await secondLogin.json();
  check('第二个设备登录成功（用于验证多设备列表）', isOk(secondLogin.status) && secondBody.code === 0,
    `http=${secondLogin.status} code=${secondBody.code}`);
  const secondRefresh = secondBody.data?.refreshToken;

  const sessions = await call('/api/v1/auth/sessions', { token });
  const sessionList = sessions.body.data ?? [];
  check('GET /auth/sessions 返回登录设备列表且形状符合契约',
    isOk(sessions.status) && Array.isArray(sessionList) && sessionList.length >= 2
    && sessionList.every((s) => typeof s.familyId === 'string' && typeof s.ip === 'string' && typeof s.current === 'boolean' && typeof s.device === 'string'),
    `http=${sessions.status} 设备数=${sessionList.length}`);

  const currentCount = sessionList.filter((s) => s.current).length;
  check('GET /auth/sessions 恰好标记一个当前设备', currentCount === 1, `current=${currentCount}`);

  const foreignRevoke = await call('/api/v1/auth/sessions/00000000-0000-0000-0000-000000000000', { method: 'DELETE', token });
  check('DELETE /auth/sessions/:id 伪造会话 → 404/1002（不泄露存在性）',
    foreignRevoke.status === 404 && foreignRevoke.body.code === 1002,
    `http=${foreignRevoke.status} code=${foreignRevoke.body.code}`);

  const otherSession = sessionList.find((s) => !s.current);
  if (otherSession) {
    const revoked = await call(`/api/v1/auth/sessions/${otherSession.id}`, { method: 'DELETE', token });
    check('DELETE /auth/sessions/:id 下线指定设备', isOk(revoked.status), `http=${revoked.status}`);

    const refreshAfterRevoke = await call('/api/v1/auth/refresh', {
      method: 'POST', body: { refreshToken: secondRefresh },
    });
    check('被下线设备的 refresh 令牌立即失效',
      refreshAfterRevoke.status === 401 || refreshAfterRevoke.body.code !== 0,
      `http=${refreshAfterRevoke.status} code=${refreshAfterRevoke.body.code}`);

    const sessionsAfter = await call('/api/v1/auth/sessions', { token });
    check('下线后设备列表不再含该会话',
      !(sessionsAfter.body.data ?? []).some((s) => s.id === otherSession.id),
      `剩余=${(sessionsAfter.body.data ?? []).length}`);
  } else {
    check('DELETE /auth/sessions/:id 下线指定设备', false, '未找到可下线的其它设备');
  }

  // ======================= 审计详情（/api/v1/audit-logs/:id） =======================
  console.log('\n---- 审计详情（/api/v1/audit-logs/:id） ----');

  const auditList = await call('/api/v1/audit-logs?page=1&pageSize=5', { token });
  const firstAudit = (auditList.body.data?.items ?? [])[0];
  check('GET /audit-logs 分页列表（取详情用的样本）',
    isOk(auditList.status) && !!firstAudit?.id, `http=${auditList.status}`);

  if (firstAudit) {
    const auditDetail = await call(`/api/v1/audit-logs/${firstAudit.id}`, { token });
    check('GET /audit-logs/:id 审计详情（含变更前后值字段）',
      isOk(auditDetail.status) && auditDetail.body.data?.id === firstAudit.id
      && 'beforeValue' in auditDetail.body.data && 'afterValue' in auditDetail.body.data,
      `http=${auditDetail.status}`);

    const auditMissing = await call('/api/v1/audit-logs/00000000-0000-0000-0000-000000000000', { token });
    check('GET /audit-logs/:id 不存在 → 404/1002',
      auditMissing.status === 404 && auditMissing.body.code === 1002,
      `http=${auditMissing.status} code=${auditMissing.body.code}`);
  }

  // ======================= 越权面（alice 仅 user:read） =======================
  console.log('\n---- 越权面（最小权限角色） ----');

  const alice = await login(ALICE, 'alice');
  const aliceToken = alice.accessToken;

  for (const [name, path, method, body] of [
    ['新建字典分类', '/api/v1/dict/categories', 'POST', { code: 'alice_probe', name: '越权探针' }],
    ['新建菜单', '/api/v1/menus', 'POST', { name: '越权探针菜单' }],
    ['新建用户', '/api/v1/users', 'POST', { username: 'alice_probe', password: 'Probe@123456' }],
    ['新建角色', '/api/v1/roles', 'POST', { code: 'alice_probe_role', name: '越权探针角色' }],
    ['下线登录设备', '/api/v1/auth/sessions/00000000-0000-0000-0000-000000000000', 'DELETE', undefined],
  ]) {
    const res = await call(path, { method, token: aliceToken, body });
    check(`alice ${name} → 403/3002（无对应权限码）`, res.status === 403 && res.body.code === 3002,
      `http=${res.status} code=${res.body.code}`);
  }

  // dict:read 是刻意授予普通角色的例外（seed.ts USER_ROLE_CODES）：全站状态列 / 下拉走 useDict，
  // 缺它普通用户只能看到原始值（0/1）而非「启用/禁用」。此处正向守住该设计决策——
  // 谁把 dict:read 从 user 角色挪走，这条断言就红。写操作（dict:write）仍一律 3002，见上方循环。
  const aliceDict = await call('/api/v1/dict/user_status', { token: aliceToken });
  check('alice 读字典 → 200（dict:read 按 PRD-005 FR-07 授予普通角色，状态列依赖）',
    aliceDict.status === 200 && aliceDict.body.code === 0 && Array.isArray(aliceDict.body.data),
    `http=${aliceDict.status} code=${aliceDict.body.code} 项数=${(aliceDict.body.data ?? []).length}`);

  console.log(`\n结果：${pass}/${total} 通过`);
  if (pass !== total) process.exitCode = 1;
}

main().catch((error) => {
  console.error('冒烟脚本执行异常：', error);
  process.exitCode = 1;
});
