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
 * @modified 2026-10-15 donttemo N-01/N-02：新增租户数据源（tenants，镜像 seed 的 legacy/acme/off/dedicated
 *   四行同构）、异步任务表（jobs，内存任务中心，进度按时间线推进）与对应权限点 / 菜单 / 字典
 * @modified 2026-10-15 donttemo E-07：新增 audit_module 字典（分类 + auth/user/role/tenant 四项，
 *   与 example-api seed 同形——审计页模块筛选项的数据源）
 * @modified 2026-10-16 donttemo M10 E-09：新增附件元数据（uploadFiles 内存表，镜像后端 upload_files
 *   表与 @fw/storage 语义：元数据行 + 内存字节，下载逐字节回放）与 file:create 权限点（授予 user 角色）
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
  /** PRD-012 OBS-06：统一审计事件契约（后端信封已全量返回；即时构造行可缺省） */
  category?: 'auth' | 'security' | 'admin' | 'data' | 'config' | 'tenant' | 'system' | null;
  event?: string | null;
  result?: 'success' | 'denied' | 'failed' | null;
  familyId?: string | null;
  jti?: string | null;
  requestId?: string | null;
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

/** 租户（N-01，镜像 example-api seed 的 tenants 基线；dbUrl 明文仅 mock 内留存，视图只回布尔位） */
export interface MockTenant {
  id: string;
  code: string;
  name: string;
  isolation: 'shared' | 'dedicated';
  plan: string | null;
  status: 0 | 1;
  expireAt: string | null;
  /** 独立库连接串明文（mock 专用；真实后端只存密文） */
  dbUrl: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * 异步任务（N-02，镜像 example-api JobCenterService 的登记项）
 *
 * progress 按「虚拟时间线」推进：elapsed / durationMs 决定百分比，使轮询退避、终态提示
 * 都能在 mock 下真实演练。artifact 为 CSV 文本（导出任务的产物）。
 */
export interface MockJob {
  id: string;
  type: string;
  title: string;
  ownerId: string;
  status: 'pending' | 'running' | 'succeeded' | 'failed';
  /** 进度百分比 0–100（按虚拟时间线推进） */
  progress: number;
  /** 虚拟执行时长（毫秒） */
  durationMs: number;
  startedAt: number;
  message: string | null;
  error: string | null;
  traceId: string;
  fileName: string | null;
  artifact: string | null;
  createdAt: string;
  updatedAt: string;
  /** 模拟失败（mock-only 调试开关：让导出 / 迁移任务按失败路径走完，演练重试） */
  simulateFail?: boolean;
  /** 完成时应用的控制面变更（迁移任务：镜像后端 runner 的 setTenantIsolation） */
  mutate?: { tenantId: string; isolation: 'shared' | 'dedicated'; dbUrl: string | null };
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
/** M10 E-13 站内信（镜像后端 notifications 表；时间统一 ISO 字符串） */
export interface MockNotification {
  id: string;
  userId: string;
  kind: 'job.finished' | 'job.failed' | 'queue.dead-letter' | 'queue.backlog' | 'system';
  level: 'info' | 'success' | 'warning' | 'error';
  title: string;
  content: string | null;
  refType: string | null;
  refId: string | null;
  traceId: string | null;
  readAt: string | null;
  createdAt: string;
}

/** M10 E-09 附件元数据（镜像后端 upload_files 表；字节存内存，下载逐字节回放） */
export interface MockUploadFile {
  id: string;
  ownerId: string | null;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  deletedAt: string | null;
  createdAt: string;
  /** mock 专用：文件字节（真实后端内容在存储端口，不在元数据表） */
  content: Buffer;
}

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
  tenants: MockTenant[];
  jobs: MockJob[];
  /** M10 E-13：站内信（消息中心铃铛数据源；mock 无事件面，故由 seed 预置演示消息） */
  notifications: MockNotification[];
  /** M10 E-09：附件元数据（/files 端点数据源；上传即新增，下载逐字节回放） */
  uploadFiles: MockUploadFile[];
  /** M9 配置中心：运行时覆盖（点路径 → 覆盖值），镜像真实后端 overlay */
  configOverrides: Record<string, unknown>;
  /** M9 配置中心：各键最近生效时间（ISO 串；env 来源且未被覆盖为 null） */
  configUpdatedAt: Record<string, string | null>;
  /** M9 配置中心：快照版本号（每次成功应用 +1，初始 1） */
  configVersion: number;
  /** M9 配置中心：最近一次错误摘要（诊断展示） */
  configLastError: string | null;
  /** refresh token 明文 → 会话 id（mock 专用；真实后端只存哈希） */
  refreshTokens: Record<string, string>;
  /** 已使用过的 refresh token 明文（检测复用泄漏） */
  usedRefreshTokens: Set<string>;
  /** M13 SaaS 运营（PRD-013）：套餐/订阅/配额/生命周期 mock 数据源 */
  saas: MockSaasState;
}

/** M13 SaaS 运营 mock 数据（与 @fw/saas 领域视图同构；BigInt 值以 string 承载） */
export interface MockSaasState {
  plans: Array<{ id: string; code: string; name: string; description: string | null }>;
  planVersions: Array<{ id: string; planId: string; version: number; status: string; remark: string | null; publishedAt: string | null }>;
  planQuotas: Array<{ planVersionId: string; quotaKey: string; limitValue: string; execution: string | null }>;
  quotaDefinitions: Array<{ key: string; name: string; unit: string; windowType: string; execution: string }>;
  subscriptions: Array<{ id: string; tenantId: string; planId: string; planVersionId: string; status: string; effectiveAt: string; expireAt: string | null; closedAt: string | null; reason: string | null }>;
  tenantQuotas: Array<{ tenantId: string; quotaKey: string; overrideValue: string; execution: string | null; source: string }>;
  usageWindows: Record<string, { used: string; limitValue: string; execution: string }>;
  lifecycleLogs: Array<{ tenantId: string; fromStatus: string | null; toStatus: string; action: string; actorType: string; actorId: string | null; reason: string | null; createdAt: string }>;
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
  { id: 'p-audit-export', code: 'audit:export', name: '审计日志异步导出', type: 'api', module: 'audit' },
  { id: 'p-order-read', code: 'order:read', name: '订单查询', type: 'menu', module: 'order' },
  { id: 'p-order-refund', code: 'order:refund', name: '订单退款', type: 'button', module: 'order' },
  // M7（PRD-007 FR-09）：队列管理页权限点，与 C-08 契约 QUEUE_PERMISSIONS 同源
  { id: 'p-queue-list', code: 'system:queue:list', name: '队列状态查看', type: 'api', module: 'queue' },
  { id: 'p-queue-manage', code: 'system:queue:manage', name: '队列运维操作', type: 'api', module: 'queue' },
  // N-01（api-spec §3.9）：租户管理五端点权限 + 跨租户维护豁免（@IgnoreTenant 的守卫要求）
  { id: 'p-tenant-read', code: 'tenant:read', name: '租户查询', type: 'api', module: 'tenant' },
  { id: 'p-tenant-create', code: 'tenant:create', name: '开租户', type: 'api', module: 'tenant' },
  { id: 'p-tenant-update', code: 'tenant:update', name: '租户修改', type: 'api', module: 'tenant' },
  { id: 'p-tenant-delete', code: 'tenant:delete', name: '租户停用', type: 'api', module: 'tenant' },
  { id: 'p-tenant-manage', code: 'tenant:manage', name: '租户隔离级别迁移', type: 'api', module: 'tenant' },
  { id: 'p-tenant-ignore', code: 'system:tenant:ignore', name: '跨租户维护', type: 'api', module: 'tenant' },
  // M9（PRD-009 FR-06）：配置中心读写分离权限点（api-spec §3.10）
  { id: 'p-config-read', code: 'system:config:read', name: '参数配置查询', type: 'api', module: 'config' },
  { id: 'p-config-write', code: 'system:config:write', name: '参数配置修改', type: 'api', module: 'config' },
  // M10 E-13：站内信消息中心（api-spec §3.14 六端点守卫；无菜单——铃铛是顶栏全局元素）
  { id: 'p-notification-read', code: 'notification:read', name: '消息中心', type: 'api', module: 'notification' },
  // M10 E-09：附件上传（api-spec §3.19 POST /files 守卫；无菜单——上传是表单内嵌能力）
  { id: 'p-file-create', code: 'file:create', name: '附件上传', type: 'api', module: 'file' },
  // M13 SaaS 运营面（api-spec §3.21）：读写分离；admin 全量授权自动持有
  { id: 'p-ops-saas-read', code: 'ops:saas:read', name: 'SaaS 运营查询', type: 'api', module: 'saas' },
  { id: 'p-ops-saas-write', code: 'ops:saas:write', name: 'SaaS 运营操作', type: 'api', module: 'saas' },
];

/** 普通用户角色默认权限（刻意不含 role:read / audit:read / user:assign-role，用于验证越权拦截） */
const USER_ROLE_PERMS = ['p-auth-logout', 'p-auth-me', 'p-auth-change-password', 'p-user-read', 'p-notification-read', 'p-file-create'];

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
  // M13 SaaS 运营目录（顶层 /saas，与子页同前缀——嵌套路由前缀约定，见 seed.ts 同注）
  { id: 'm-saas', parentId: '0', name: 'SaaS 运营', path: '/saas', component: 'layout/blank', icon: 'box', permissionCode: null, visible: true, sort: 4 },
  { id: 'm-saas-plans', parentId: 'm-saas', name: '套餐管理', path: '/saas/plans', component: 'saas/plans', icon: 'box', permissionCode: 'ops:saas:read', visible: true, sort: 1 },
  { id: 'm-saas-subscriptions', parentId: 'm-saas', name: '订阅管理', path: '/saas/subscriptions', component: 'saas/subscriptions', icon: 'ticket', permissionCode: 'ops:saas:read', visible: true, sort: 2 },
  { id: 'm-saas-lifecycle', parentId: 'm-saas', name: '租户生命周期', path: '/saas/lifecycle', component: 'saas/lifecycle', icon: 'switch-button', permissionCode: 'ops:saas:read', visible: true, sort: 3 },
  { id: 'm-saas-usage', parentId: 'm-saas', name: '用量看板', path: '/saas/usage', component: 'saas/usage', icon: 'data-line', permissionCode: 'ops:saas:read', visible: true, sort: 4 },
  { id: 'm-system-tenants', parentId: 'm-system', name: '租户管理', path: '/system/tenants', component: 'system/tenants', icon: 'office-building', permissionCode: 'tenant:read', visible: true, sort: 7 },
  // M9 参数配置页（views/system/configs）：与后端 seed 同形（PRD-009 FR-07）
  { id: 'm-system-configs', parentId: 'm-system', name: '参数配置', path: '/system/configs', component: 'system/configs', icon: 'tool', permissionCode: 'system:config:read', visible: true, sort: 8 },
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
  { id: 'dc-audit-module', code: 'audit_module', name: '审计模块', remark: 'E-07：与 example-api seed 的 audit_module 同形' },
  { id: 'dc-data-scope', code: 'data_scope', name: '数据范围', remark: '与 roles.data_scope 同源' },
  { id: 'dc-order-channel', code: 'order_channel', name: '订单渠道', remark: null },
  { id: 'dc-tenant-isolation', code: 'tenant_isolation', name: '租户隔离级别', remark: 'N-01 租户管理页：shared=共享库+tenant_id / dedicated=独立库' },
  { id: 'dc-tenant-status', code: 'tenant_status', name: '租户状态', remark: 'N-01 租户管理页：停用租户在租户解析上 fail-closed（4001）' },
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
  { id: 'di-am-auth', categoryId: 'dc-audit-module', label: '认证', value: 'auth', color: 'primary', sort: 1 },
  { id: 'di-am-user', categoryId: 'dc-audit-module', label: '用户', value: 'user', color: 'success', sort: 2 },
  { id: 'di-am-role', categoryId: 'dc-audit-module', label: '角色', value: 'role', color: 'warning', sort: 3 },
  { id: 'di-am-tenant', categoryId: 'dc-audit-module', label: '租户', value: 'tenant', color: 'info', sort: 4 },
  { id: 'di-am-queue', categoryId: 'dc-audit-module', label: '队列', value: 'queue', color: 'info', sort: 5 },
  { id: 'di-am-config', categoryId: 'dc-audit-module', label: '配置', value: 'config', color: 'danger', sort: 6 },
  { id: 'di-ds-all', categoryId: 'dc-data-scope', label: '全部数据', value: 'all', color: 'primary', sort: 1 },
  { id: 'di-ds-org-below', categoryId: 'dc-data-scope', label: '本组织及下级', value: 'org_below', color: 'success', sort: 2 },
  { id: 'di-ds-org', categoryId: 'dc-data-scope', label: '本组织', value: 'org', color: 'warning', sort: 3 },
  { id: 'di-ds-self', categoryId: 'dc-data-scope', label: '仅本人', value: 'self', color: 'info', sort: 4 },
  { id: 'di-oc-web', categoryId: 'dc-order-channel', label: '网页端', value: 'web', color: 'primary', sort: 1 },
  { id: 'di-oc-app', categoryId: 'dc-order-channel', label: '移动端', value: 'app', color: 'success', sort: 2 },
  { id: 'di-oc-mini', categoryId: 'dc-order-channel', label: '小程序', value: 'mini', color: 'warning', sort: 3 },
  { id: 'di-ti-shared', categoryId: 'dc-tenant-isolation', label: '共享库', value: 'shared', color: 'primary', sort: 1 },
  { id: 'di-ti-dedicated', categoryId: 'dc-tenant-isolation', label: '独立库', value: 'dedicated', color: 'warning', sort: 2 },
  { id: 'di-ts-1', categoryId: 'dc-tenant-status', label: '启用', value: '1', color: 'success', sort: 1 },
  { id: 'di-ts-0', categoryId: 'dc-tenant-status', label: '停用', value: '0', color: 'danger', sort: 2 },
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
    const moduleName = i % 3 === 0 ? 'user' : i % 3 === 1 ? 'role' : 'auth';
    logs.push({
      id: `a-${String(i).padStart(4, '0')}`,
      userId,
      module: moduleName,
      action,
      targetType: action === 'login' || action === 'logout' ? null : action === 'grant' ? 'role' : 'user',
      targetId: action === 'login' || action === 'logout' ? null : i % 3 === 0 ? 'u-bob' : 'r-user',
      beforeValue: action === 'update' ? { status: 1, nickname: '旧昵称' } : action === 'delete' ? { username: 'temp' } : null,
      afterValue: action === 'update' ? { status: 0, nickname: '新昵称' } : action === 'grant' ? { permissionIds: ['p-user-read', 'p-auth-me'] } : null,
      category: 'admin',
      event: `${moduleName}.${action}`,
      result: 'success',
      familyId: null,
      jti: null,
      requestId: null,
      ip: '127.0.0.1',
      userAgent: 'Mozilla/5.0 (mock)',
      traceId: `trace-${String(i).padStart(6, '0')}`,
      createdAt: new Date(Date.UTC(2026, 9, 13, 1, i)).toISOString(),
    });
  }
  return logs;
}

/**
 * 租户基线（N-01，与 example-api seed 的 seedTenants() 同构）：
 * legacy（id '0'）：存量单租户数据归属租户，停用 / 迁移一律被服务端拒绝；
 * acme（id '1'）：第二个租户；off（id '2'）：停用租户（fail-closed 演示）；
 * dedicated（id '3'）：独立库租户（sqlite 部署下连接串指向 prisma/tenant-dedicated.db）。
 */
function seedTenants(): MockTenant[] {
  const base = Date.UTC(2026, 9, 13, 0, 0, 0);
  return [
    { id: '0', code: 'legacy', name: '存量单租户', isolation: 'shared', plan: 'legacy', status: 1, expireAt: null, dbUrl: null, createdAt: new Date(base).toISOString(), updatedAt: new Date(base).toISOString() },
    { id: '1', code: 'acme', name: 'ACME 公司', isolation: 'shared', plan: 'pro', status: 1, expireAt: '2027-01-01T00:00:00.000Z', dbUrl: null, createdAt: new Date(base + 3_600_000).toISOString(), updatedAt: new Date(base + 3_600_000).toISOString() },
    { id: '2', code: 'off', name: '已停用租户', isolation: 'shared', plan: 'basic', status: 0, expireAt: null, dbUrl: null, createdAt: new Date(base + 7_200_000).toISOString(), updatedAt: new Date(base + 7_200_000).toISOString() },
    { id: '3', code: 'dedicated', name: '独立库租户', isolation: 'dedicated', plan: 'enterprise', status: 1, expireAt: null, dbUrl: 'file:./tenant-dedicated.db', createdAt: new Date(base + 10_800_000).toISOString(), updatedAt: new Date(base + 10_800_000).toISOString() },
  ];
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

/**
 * M10 E-13 演示站内信：mock 没有事件面（不产事件），若消息面恒为空则铃铛与未读数永远无从验证；
 * 故预置两条（一未读一已读）覆盖角标、列表与「全部已读」三条路径。
 */
function seedNotifications(): MockNotification[] {
  const base = Date.parse('2026-10-15T02:00:00.000Z');
  return [
    {
      id: 'ntf-demo-0001',
      userId: 'u-admin',
      kind: 'job.finished',
      level: 'success',
      title: '任务完成：审计日志导出',
      content: '产物 audit-logs-2026-10-15.csv 已可下载',
      refType: 'job',
      refId: 'job-demo-0001',
      traceId: 'trace-mock-ntf-1',
      readAt: null,
      createdAt: new Date(base + 60_000).toISOString(),
    },
    {
      id: 'ntf-demo-0002',
      userId: 'u-admin',
      kind: 'queue.backlog',
      level: 'warning',
      title: '队列积压告警',
      content: '等待任务 150 已超过阈值 100',
      refType: 'queue',
      refId: 'exports',
      traceId: null,
      readAt: new Date(base + 90_000).toISOString(),
      createdAt: new Date(base).toISOString(),
    },
  ];
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
    tenants: seedTenants(),
    jobs: [],
    // M10 E-13：演示消息（mock 无 SSE 事件面，铃铛与未读数需要既有数据可看）
    notifications: seedNotifications(),
    // M10 E-09：附件（空表起步，上传即新增）
    uploadFiles: [],
    sessions: [],
    configOverrides: {},
    configUpdatedAt: {},
    configVersion: 1,
    configLastError: null,
    saas: {
      plans: [
        { id: 'plan-default', code: 'default', name: '基础版', description: '默认套餐（M13 mock 预置）' },
        { id: 'plan-pro', code: 'pro', name: '专业版', description: '更大配额与优先支持' },
      ],
      planVersions: [
        { id: 'pv-default-1', planId: 'plan-default', version: 1, status: 'published', remark: null, publishedAt: '2026-10-19T00:00:00.000Z' },
        { id: 'pv-pro-1', planId: 'plan-pro', version: 1, status: 'published', remark: null, publishedAt: '2026-10-19T00:00:00.000Z' },
      ],
      planQuotas: [
        { planVersionId: 'pv-default-1', quotaKey: 'api_calls', limitValue: '10000', execution: 'hard' },
        { planVersionId: 'pv-pro-1', quotaKey: 'api_calls', limitValue: '100000', execution: 'hard' },
      ],
      quotaDefinitions: [{ key: 'api_calls', name: 'API 调用数', unit: 'count', windowType: 'day', execution: 'hard' }],
      subscriptions: [
        { id: 'sub-mock-1', tenantId: '1', planId: 'plan-default', planVersionId: 'pv-default-1', status: 'active', effectiveAt: '2026-10-19T00:00:00.000Z', expireAt: null, closedAt: null, reason: null },
      ],
      tenantQuotas: [
        { tenantId: '1', quotaKey: 'api_calls', overrideValue: '10000', execution: 'hard', source: 'plan_snapshot' },
      ],
      usageWindows: {},
      lifecycleLogs: [
        { tenantId: '1', fromStatus: 'pending', toStatus: 'active', action: 'activate', actorType: 'system', actorId: null, reason: 'mock 预置', createdAt: '2026-10-19T00:00:00.000Z' },
      ],
    },
    refreshTokens: {},
    usedRefreshTokens: new Set<string>(),
  };
}

/** 模块级单例：dev server 生命周期内保持（HMR 时随模块重载重置，符合预期） */
export const db: MockDb = createDb();
