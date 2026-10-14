/*
 * @file mock 数据源（C-06 前端 API 契约的内存实现）
 * @description 管理后台前端（PRD-005 / L4 线）自建 mock：不依赖后端实现即可开发与验收（TC-WEB-001~006）。
 *   数据镜像 apps/example-api/prisma/seed.ts 的 M3 基线（权限点 / 角色 / 菜单 / 账号），并按 PRD-005 页面清单
 *   补齐菜单管理与字典管理两项（后端 seed 尚未注册，差异登记在 docs/contracts/api-web.ts 变更记录）。
 *   令牌为 mock JWT（base64 三段式，非签名校验），仅用于前端链路验证；refresh 轮换语义与后端一致（复用即失效）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo M7：新增队列管理页数据源（system:queue:* 权限点、/system/queue 菜单、
 *   队列统计 / 死信 / 定时任务快照的内存状态，与 @fw/queue 的 QueueStats / DeadLetterRecord / CronSnapshot 同形）
 * @modified 2026-10-14 donttemo 标注「订单中心」为 mock-only 演示菜单（生产 seed 已移除该分支，后端无
 *   /api/v1/orders 端点），避免后续误判为 mock 与生产菜单应该一致
 * @module admin-web/mock
 */

/** 权限点类型（与 C-05 契约同源） */
export type MockPermissionType = 'menu' | 'button' | 'api';

/** 权限点 */
export interface MockPermission {
  id: string;
  code: string;
  name: string;
  type: MockPermissionType;
  module: string;
}

/** 角色 */
export interface MockRole {
  id: string;
  code: string;
  name: string;
  remark: string | null;
  isSystem: boolean;
  dataScope: 'all' | 'org_below' | 'org' | 'self';
  sort: number;
  permissionIds: string[];
}

/** 菜单节点 */
export interface MockMenu {
  id: string;
  parentId: string;
  name: string;
  path: string | null;
  component: string | null;
  icon: string | null;
  permissionCode: string | null;
  visible: boolean;
  sort: number;
}

/** 菜单树节点（children 仅存在于 menuTree 组装结果，扁平表中无此字段） */
export interface MockMenuTree extends MockMenu {
  children: MockMenuTree[];
}

/** 用户（不含口令哈希字段，mock 口令单独存放） */
export interface MockUser {
  id: string;
  username: string;
  nickname: string | null;
  phone: string | null;
  email: string | null;
  avatar: string | null;
  status: 0 | 1;
  roleIds: string[];
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
}

/** 字典分类 */
export interface MockDictCategory {
  id: string;
  code: string;
  name: string;
  remark: string | null;
}

/** 字典项 */
export interface MockDictItem {
  id: string;
  categoryId: string;
  label: string;
  value: string;
  color: string | null;
  sort: number;
}

/** 审计日志 */
export interface MockAuditLog {
  id: string;
  userId: string | null;
  module: string;
  action: 'create' | 'update' | 'delete' | 'login' | 'logout' | 'export' | 'grant';
  targetType: string | null;
  targetId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  ip: string | null;
  userAgent: string | null;
  traceId: string;
  createdAt: string;
}

/** 演示订单（生成器产出页面的 mock 数据源，验证「新列表页 ≤ 80 行」） */
export interface MockOrder {
  id: string;
  orderNo: string;
  customer: string;
  amount: string;
  status: number;
  channel: string;
  createdAt: string;
}

/** 登录会话（refresh token 族，供个人中心「登录设备」查看与下线） */
export interface MockSession {
  id: string;
  userId: string;
  familyId: string;
  device: string;
  ip: string;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

/** 队列统计明细（与 @fw/queue 的 QueueStatsItem 同形） */
export interface MockQueueStatsItem {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  deadLetter: number;
  backlog: number;
  concurrency: number;
  rateLimit: number;
}

/** 死信记录（与 @fw/queue 的 DeadLetterRecord 同形） */
export interface MockQueueDeadLetter {
  id: string;
  name: string;
  queue: string;
  payload: unknown;
  attemptsMade: number;
  reason: string;
  failedAt: string;
  enqueuedAt: string;
}

/** 定时任务快照（与 @fw/queue 的 CronSnapshot 同形） */
export interface MockQueueCron {
  name: string;
  expression: string;
  lock: boolean;
  nextRunAt: string | null;
  runs: number;
  lockedOut: number;
  lastResult: 'ok' | 'error' | null;
  lastRunAt: string | null;
}

/** 队列指标计数器 */
export interface MockQueueCounters {
  dispatched: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  idempotentSkipped: number;
  timedOut: number;
  cronTicked: number;
  cronLockedOut: number;
}

/** 队列运行时状态（mock 内存态；运维动作直接改写本对象） */
export interface MockQueueState {
  driver: 'memory';
  paused: boolean;
  consuming: boolean;
  counters: MockQueueCounters;
  queues: MockQueueStatsItem[];
  deadLetters: MockQueueDeadLetter[];
  crons: MockQueueCron[];
}

/** mock JWT 载荷 */
export interface MockTokenPayload {
  sub: string;
  username: string;
  type: 'access' | 'refresh';
  jti: string;
  fam: string;
  roles: string[];
  permissions: string[];
  exp: number;
  iat: number;
}

/** 内存数据库（dev server 进程级单例，请求间保持） */
export interface MockDb {
  permissions: MockPermission[];
  roles: MockRole[];
  menus: MockMenu[];
  users: MockUser[];
  passwords: Record<string, string>;
  dictCategories: MockDictCategory[];
  dictItems: MockDictItem[];
  auditLogs: MockAuditLog[];
  orders: MockOrder[];
  queue: MockQueueState;
  sessions: MockSession[];
  /** refresh token 明文 → 会话 id（mock 专用；真实后端只存哈希） */
  refreshTokens: Record<string, string>;
  /** 已使用过的 refresh token 明文（检测复用泄漏） */
  usedRefreshTokens: Set<string>;
}

/** 权限点清单：与 seed.ts 的 FRAMEWORK_PERMISSIONS + BUSINESS_PERMISSIONS 同源，另补字典 4 项（API 规格 §3.6） */
const PERMISSIONS: MockPermission[] = [
  { id: 'p-auth-logout', code: 'auth:logout', name: '登出', type: 'api', module: 'auth' },
  { id: 'p-auth-me', code: 'auth:me', name: '查看当前用户', type: 'api', module: 'auth' },
  { id: 'p-auth-change-password', code: 'auth:change-password', name: '修改本人密码', type: 'api', module: 'auth' },
  { id: 'p-user-read', code: 'user:read', name: '用户查询', type: 'api', module: 'user' },
  { id: 'p-user-create', code: 'user:create', name: '用户新增', type: 'api', module: 'user' },
  { id: 'p-user-update', code: 'user:update', name: '用户修改', type: 'api', module: 'user' },
  { id: 'p-user-delete', code: 'user:delete', name: '用户删除', type: 'api', module: 'user' },
  { id: 'p-user-assign-role', code: 'user:assign-role', name: '分配角色', type: 'api', module: 'user' },
  { id: 'p-user-reset-password', code: 'user:reset-password', name: '重置他人密码', type: 'api', module: 'user' },
  { id: 'p-role-read', code: 'role:read', name: '角色查询', type: 'api', module: 'role' },
  { id: 'p-role-create', code: 'role:create', name: '角色新增', type: 'api', module: 'role' },
  { id: 'p-role-update', code: 'role:update', name: '角色修改', type: 'api', module: 'role' },
  { id: 'p-role-delete', code: 'role:delete', name: '角色删除', type: 'api', module: 'role' },
  { id: 'p-role-grant', code: 'role:grant', name: '角色授权', type: 'api', module: 'role' },
  { id: 'p-permission-read', code: 'permission:read', name: '权限点查询', type: 'api', module: 'permission' },
  { id: 'p-menu-read', code: 'menu:read', name: '菜单查询', type: 'menu', module: 'menu' },
  { id: 'p-menu-create', code: 'menu:create', name: '菜单新增', type: 'menu', module: 'menu' },
  { id: 'p-menu-update', code: 'menu:update', name: '菜单修改', type: 'menu', module: 'menu' },
  { id: 'p-menu-delete', code: 'menu:delete', name: '菜单删除', type: 'menu', module: 'menu' },
  { id: 'p-dict-read', code: 'dict:read', name: '字典查询', type: 'api', module: 'dict' },
  { id: 'p-dict-create', code: 'dict:create', name: '字典新增', type: 'api', module: 'dict' },
  { id: 'p-dict-update', code: 'dict:update', name: '字典修改', type: 'api', module: 'dict' },
  { id: 'p-dict-delete', code: 'dict:delete', name: '字典删除', type: 'api', module: 'dict' },
  { id: 'p-audit-read', code: 'audit:read', name: '审计日志查询', type: 'api', module: 'audit' },
  { id: 'p-order-read', code: 'order:read', name: '订单查询', type: 'menu', module: 'order' },
  { id: 'p-order-refund', code: 'order:refund', name: '订单退款', type: 'button', module: 'order' },
  // M7（PRD-007 FR-09）：队列管理页权限点，与 C-08 契约 QUEUE_PERMISSIONS 同源
  { id: 'p-queue-list', code: 'system:queue:list', name: '队列状态查看', type: 'api', module: 'queue' },
  { id: 'p-queue-manage', code: 'system:queue:manage', name: '队列运维操作', type: 'api', module: 'queue' },
];

/** 普通用户角色默认权限（刻意不含 role:read / audit:read / user:assign-role，用于验证越权拦截） */
const USER_ROLE_PERMS = ['p-auth-logout', 'p-auth-me', 'p-auth-change-password', 'p-user-read'];

/** 菜单树：镜像 seed 的 MENU_TREE，并按 PRD-005 页面清单补 字典管理 / 菜单管理 */
const MENUS: MockMenu[] = [
  { id: 'm-dashboard', parentId: '0', name: '控制台', path: '/dashboard', component: 'dashboard/index', icon: 'home', permissionCode: null, visible: true, sort: 1 },
  { id: 'm-system', parentId: '0', name: '系统管理', path: '/system', component: 'layout/blank', icon: 'setting', permissionCode: null, visible: true, sort: 2 },
  { id: 'm-system-users', parentId: 'm-system', name: '用户管理', path: '/system/users', component: 'system/users', icon: 'user', permissionCode: 'user:read', visible: true, sort: 1 },
  { id: 'm-system-roles', parentId: 'm-system', name: '角色权限', path: '/system/roles', component: 'system/roles', icon: 'shield', permissionCode: 'role:read', visible: true, sort: 2 },
  { id: 'm-system-menus', parentId: 'm-system', name: '菜单管理', path: '/system/menus', component: 'system/menus', icon: 'menu', permissionCode: 'menu:read', visible: true, sort: 3 },
  { id: 'm-system-dict', parentId: 'm-system', name: '字典管理', path: '/system/dict', component: 'system/dict', icon: 'collection', permissionCode: 'dict:read', visible: true, sort: 4 },
  { id: 'm-system-audit', parentId: 'm-system', name: '审计日志', path: '/system/audit-logs', component: 'system/audit-logs', icon: 'file-text', permissionCode: 'audit:read', visible: true, sort: 5 },
  { id: 'm-system-queue', parentId: 'm-system', name: '队列管理', path: '/system/queue', component: 'system/queue', icon: 'clock', permissionCode: 'system:queue:list', visible: true, sort: 6 },
  // 刻意保留的 mock-only 演示菜单：仅存在于 dev（mock 有 /orders 端点与 demo/orders 视图可跑通），
  // 生产 seed 已整支移除该分支（后端无 /api/v1/orders，挂菜单必然死链）—— 属**有意**的 dev/prod 差异。
  { id: 'm-order', parentId: '0', name: '订单中心', path: '/order', component: 'layout/blank', icon: 'shopping', permissionCode: 'order:read', visible: true, sort: 3 },
  { id: 'm-order-list', parentId: 'm-order', name: '订单列表', path: '/order/list', component: 'demo/orders', icon: 'list', permissionCode: 'order:read', visible: true, sort: 1 },
];

/** 演示用户（口令仅在 mock 内使用，非真实凭证） */
const USERS: MockUser[] = [
  { id: 'u-admin', username: 'admin', nickname: '管理员', phone: '13800000001', email: 'admin@example.com', avatar: null, status: 1, roleIds: ['r-admin'], lastLoginAt: '2026-10-13T02:20:00.000Z', lastLoginIp: '127.0.0.1', createdAt: '2026-10-12T09:00:00.000Z' },
  { id: 'u-alice', username: 'alice', nickname: 'Alice', phone: '13800000002', email: 'alice@example.com', avatar: null, status: 1, roleIds: ['r-user'], lastLoginAt: '2026-10-13T03:10:00.000Z', lastLoginIp: '127.0.0.1', createdAt: '2026-10-12T09:05:00.000Z' },
  { id: 'u-bob', username: 'bob', nickname: 'Bob', phone: null, email: 'bob@example.com', avatar: null, status: 1, roleIds: ['r-user'], lastLoginAt: null, lastLoginIp: null, createdAt: '2026-10-12T10:00:00.000Z' },
  { id: 'u-carol', username: 'carol', nickname: 'Carol', phone: '13800000004', email: 'carol@example.com', avatar: null, status: 0, roleIds: ['r-user'], lastLoginAt: null, lastLoginIp: null, createdAt: '2026-10-12T11:00:00.000Z' },
  { id: 'u-dave', username: 'dave', nickname: 'Dave', phone: null, email: 'dave@example.com', avatar: null, status: 1, roleIds: ['r-user'], lastLoginAt: null, lastLoginIp: null, createdAt: '2026-10-12T12:00:00.000Z' },
];

/** 字典分类与项（演示 useDict 消费，避免枚举硬编码） */
const DICT_CATEGORIES: MockDictCategory[] = [
  { id: 'dc-user-status', code: 'user_status', name: '用户状态', remark: '账号启用 / 禁用' },
  { id: 'dc-yes-no', code: 'sys_yes_no', name: '是否', remark: null },
  { id: 'dc-audit-action', code: 'audit_action', name: '审计动作', remark: null },
  { id: 'dc-data-scope', code: 'data_scope', name: '数据范围', remark: '与 roles.data_scope 同源' },
  { id: 'dc-order-channel', code: 'order_channel', name: '订单渠道', remark: null },
];

const DICT_ITEMS: MockDictItem[] = [
  { id: 'di-us-1', categoryId: 'dc-user-status', label: '启用', value: '1', color: 'success', sort: 1 },
  { id: 'di-us-0', categoryId: 'dc-user-status', label: '禁用', value: '0', color: 'danger', sort: 2 },
  { id: 'di-yn-1', categoryId: 'dc-yes-no', label: '是', value: '1', color: 'primary', sort: 1 },
  { id: 'di-yn-0', categoryId: 'dc-yes-no', label: '否', value: '0', color: 'info', sort: 2 },
  { id: 'di-aa-create', categoryId: 'dc-audit-action', label: '创建', value: 'create', color: 'primary', sort: 1 },
  { id: 'di-aa-update', categoryId: 'dc-audit-action', label: '更新', value: 'update', color: 'warning', sort: 2 },
  { id: 'di-aa-delete', categoryId: 'dc-audit-action', label: '删除', value: 'delete', color: 'danger', sort: 3 },
  { id: 'di-aa-login', categoryId: 'dc-audit-action', label: '登录', value: 'login', color: 'success', sort: 4 },
  { id: 'di-aa-logout', categoryId: 'dc-audit-action', label: '登出', value: 'logout', color: 'info', sort: 5 },
  { id: 'di-aa-export', categoryId: 'dc-audit-action', label: '导出', value: 'export', color: 'info', sort: 6 },
  { id: 'di-aa-grant', categoryId: 'dc-audit-action', label: '授权', value: 'grant', color: 'warning', sort: 7 },
  { id: 'di-ds-all', categoryId: 'dc-data-scope', label: '全部数据', value: 'all', color: 'primary', sort: 1 },
  { id: 'di-ds-org-below', categoryId: 'dc-data-scope', label: '本组织及下级', value: 'org_below', color: 'success', sort: 2 },
  { id: 'di-ds-org', categoryId: 'dc-data-scope', label: '本组织', value: 'org', color: 'warning', sort: 3 },
  { id: 'di-ds-self', categoryId: 'dc-data-scope', label: '仅本人', value: 'self', color: 'info', sort: 4 },
  { id: 'di-oc-web', categoryId: 'dc-order-channel', label: '网页端', value: 'web', color: 'primary', sort: 1 },
  { id: 'di-oc-app', categoryId: 'dc-order-channel', label: '移动端', value: 'app', color: 'success', sort: 2 },
  { id: 'di-oc-mini', categoryId: 'dc-order-channel', label: '小程序', value: 'mini', color: 'warning', sort: 3 },
];

/** 演示订单（30 条，覆盖分页与筛选） */
function seedOrders(): MockOrder[] {
  const channels = ['web', 'app', 'mini'];
  const customers = ['张三', '李四', '王五', '赵六', '钱七', '孙八', '周九', '吴十'];
  const orders: MockOrder[] = [];
  for (let i = 1; i <= 30; i += 1) {
    orders.push({
      id: `o-${String(i).padStart(4, '0')}`,
      orderNo: `NO20261013${String(i).padStart(4, '0')}`,
      customer: customers[i % customers.length] as string,
      amount: `${(Math.random() * 5000 + 100).toFixed(2)}`,
      status: i % 4 === 0 ? 0 : 1,
      channel: channels[i % 3] as string,
      createdAt: new Date(Date.UTC(2026, 9, 13, 2, i)).toISOString(),
    });
  }
  return orders;
}

/** 审计日志（含一条用户状态变更的前后值，验证 TC-WEB-004 字段级 diff） */
function seedAuditLogs(): MockAuditLog[] {
  const logs: MockAuditLog[] = [];
  const actions: MockAuditLog['action'][] = ['login', 'create', 'update', 'delete', 'grant', 'logout', 'export'];
  for (let i = 1; i <= 26; i += 1) {
    const action = actions[i % actions.length] as MockAuditLog['action'];
    const userId = i % 5 === 0 ? 'u-alice' : 'u-admin';
    logs.push({
      id: `a-${String(i).padStart(4, '0')}`,
      userId,
      module: i % 3 === 0 ? 'user' : i % 3 === 1 ? 'role' : 'auth',
      action,
      targetType: action === 'login' || action === 'logout' ? null : action === 'grant' ? 'role' : 'user',
      targetId: action === 'login' || action === 'logout' ? null : i % 3 === 0 ? 'u-bob' : 'r-user',
      beforeValue: action === 'update' ? { status: 1, nickname: '旧昵称' } : action === 'delete' ? { username: 'temp' } : null,
      afterValue: action === 'update' ? { status: 0, nickname: '新昵称' } : action === 'grant' ? { permissionIds: ['p-user-read', 'p-auth-me'] } : null,
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0 (mock)',
      traceId: `trace-${String(i).padStart(6, '0')}`,
      createdAt: new Date(Date.UTC(2026, 9, 13, 1, i)).toISOString(),
    });
  }
  return logs;
}

/**
 * 队列运行时状态（演示用初始值；运维动作在 handlers 中直接改写）
 * @returns 队列状态
 */
function seedQueue(): MockQueueState {
  const base = Date.UTC(2026, 9, 13, 2, 0, 0);
  return {
    driver: 'memory',
    paused: false,
    consuming: true,
    counters: { dispatched: 128, succeeded: 119, failed: 9, deadLettered: 3, idempotentSkipped: 4, timedOut: 1, cronTicked: 12, cronLockedOut: 0 },
    queues: [
      { name: 'default', waiting: 2, active: 1, completed: 96, deadLetter: 2, backlog: 3, concurrency: 10, rateLimit: 0 },
      { name: 'exports', waiting: 0, active: 0, completed: 18, deadLetter: 1, backlog: 0, concurrency: 4, rateLimit: 5 },
    ],
    deadLetters: [
      {
        id: 'job-dl-0001',
        name: 'demo.permanent',
        queue: 'default',
        payload: { reason: '参数非法' },
        attemptsMade: 1,
        reason: '参数非法：订单号格式不合法',
        failedAt: new Date(base + 3_600_000).toISOString(),
        enqueuedAt: new Date(base + 3_590_000).toISOString(),
      },
      {
        id: 'job-dl-0002',
        name: 'order.timeout',
        queue: 'default',
        payload: { orderId: 'o-0007' },
        attemptsMade: 4,
        reason: '下游超时：调用风控服务 3 次均失败',
        failedAt: new Date(base + 7_200_000).toISOString(),
        enqueuedAt: new Date(base + 7_190_000).toISOString(),
      },
      {
        id: 'job-dl-0003',
        name: 'report.export',
        queue: 'exports',
        payload: { month: '2026-09' },
        attemptsMade: 4,
        reason: '对象存储写入失败：AccessDenied',
        failedAt: new Date(base + 10_800_000).toISOString(),
        enqueuedAt: new Date(base + 10_790_000).toISOString(),
      },
    ],
    crons: [
      { name: 'demo.tick', expression: '*/5 * * * * *', lock: true, nextRunAt: new Date(base + 11_000_000).toISOString(), runs: 9, lockedOut: 0, lastResult: 'ok', lastRunAt: new Date(base + 10_995_000).toISOString() },
      { name: 'demo.nightly', expression: '0 3 * * *', lock: true, nextRunAt: new Date(base + 14_400_000).toISOString(), runs: 1, lockedOut: 0, lastResult: 'ok', lastRunAt: new Date(base + 3_600_000).toISOString() },
      { name: 'order.settle', expression: '0 2 * * *', lock: true, nextRunAt: new Date(base + 13_200_000).toISOString(), runs: 2, lockedOut: 0, lastResult: 'error', lastRunAt: new Date(base + 10_000_000).toISOString() },
    ],
  };
}

/** 构建内存数据库（幂等重置，供 mock server 复用） */
export function createDb(): MockDb {
  return {
    permissions: PERMISSIONS.map((p) => ({ ...p })),
    roles: [
      { id: 'r-admin', code: 'admin', name: '超级管理员', remark: '内置角色，拥有全部权限', isSystem: true, dataScope: 'all', sort: 1, permissionIds: PERMISSIONS.map((p) => p.id) },
      { id: 'r-user', code: 'user', name: '普通用户', remark: '内置角色，仅自身相关', isSystem: true, dataScope: 'self', sort: 2, permissionIds: USER_ROLE_PERMS },
      { id: 'r-ops', code: 'ops', name: '运营专员', remark: '订单与字典维护（演示可删角色）', isSystem: false, dataScope: 'org', sort: 3, permissionIds: ['p-auth-logout', 'p-auth-me', 'p-order-read', 'p-dict-read'] },
    ],
    menus: MENUS.map((m) => ({ ...m })),
    users: USERS.map((u) => ({ ...u, roleIds: [...u.roleIds] })),
    passwords: { admin: 'Admin@123456', alice: 'Alice@123456', bob: 'Bob@123456', carol: 'Carol@123456', dave: 'Dave@123456' },
    dictCategories: DICT_CATEGORIES.map((c) => ({ ...c })),
    dictItems: DICT_ITEMS.map((d) => ({ ...d })),
    auditLogs: seedAuditLogs(),
    orders: seedOrders(),
    queue: seedQueue(),
    sessions: [],
    refreshTokens: {},
    usedRefreshTokens: new Set<string>(),
  };
}

/** 模块级单例：dev server 生命周期内保持（HMR 时随模块重载重置，符合预期） */
export const db: MockDb = createDb();
