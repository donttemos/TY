/*
 * @file C-06 前端 API 契约（类型即契约）
 * @description 并行工作线契约（docs/85-parallel-workstreams.md 表 C-06）：管理后台前端（L4）与后端（L2）共同遵守。
 *   本文件声明登录 / 刷新 / 登出 / me / 菜单 / 用户 / 角色 / 权限 / 菜单维护 / 字典 / 审计 / 会话的请求响应结构，
 *   是 apps/admin-web/mock 与真实后端必须一致的结构基线；实现方照抄签名，mock 与真实响应结构零差异（集成日比对）。
 *   变更规则：破坏性变更（改签名 / 改字段语义）须写 ADR 或追加变更记录 → L0 裁决 → 当天内全线同步。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo M7：新增 §3.8 队列管理端点与类型（与 C-08 Job 契约同源，PRD-007 FR-09）
 * @modified 2026-10-14 donttemo 新增 §3.2 的 GET / PUT /auth/profile 类型（ProfileResult / ProfileUpsertInput）：
 *   非破坏性新增（追加响应字段与端点），后端 example-api 与前端 mock 已同时实现，避免「mock 全绿、真机 404」
 * @modified 2026-10-15 donttemo M9/PRD-009：新增 §3.10 参数配置类型（ConfigEntry / ConfigCenterMetaInfo /
 *   ConfigListResult / ConfigUpsertInput / ConfigWriteResult）——GET / PUT /configs 两端点的结构基线
 * @module docs/contracts
 */

/** 主键：框架统一字符串主键（UUID） */
export type ID = string;

/** 数据权限范围四档（与数据字典 roles.data_scope 同源） */
export type DataScope = 'all' | 'org_below' | 'org' | 'self';

/** 权限点类型（C-05） */
export type PermissionType = 'menu' | 'button' | 'api';

/** 权限码格式：`资源:操作` */
export type PermissionCode = `${string}:${string}`;

/** 审计动作（与 @fw/auth AuditAction 同源） */
export type AuditAction = 'create' | 'update' | 'delete' | 'login' | 'logout' | 'export' | 'grant';

/** 统一响应信封（与 @fw/core ResponseInterceptor 一致） */
export interface ApiEnvelope<T> {
  code: number;
  message: string;
  data: T;
  traceId: string;
}

/** 分页结果（与 @fw/db PageResult 一致） */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 双 token（C-05 TokenPair） */
export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  /** access 剩余有效秒数 */
  expiresIn: number;
}

/** 登录 / 刷新结果（C-05 LoginResult） */
export interface LoginResult extends TokenPair {
  user: LoginUser;
}

/** 登录返回的用户视图（脱敏；与 C-05 RequestUser 的对外子集一致） */
export interface LoginUser {
  id: ID;
  username: string;
  roles: string[];
  permissions: PermissionCode[];
  dataScope: DataScope;
  via: 'jwt' | 'session' | 'oauth2' | 'apikey';
}

/** GET /auth/me 响应（C-05 MeResult） */
export interface MeResult {
  id: ID;
  username: string;
  nickname: string | null;
  avatar: string | null;
  roles: string[];
  permissions: PermissionCode[];
  dataScope: DataScope;
}

/**
 * 本人资料响应（GET / PUT /auth/profile）
 * 与 MeResult 同构，另含手机 / 邮箱；两者只需 `auth:me`，**不依赖 `user:read`**
 * （个人中心自服务：原先借 PUT /users/:id 保存，普通角色必 3002）。
 */
export interface ProfileResult extends MeResult {
  phone: string | null;
  email: string | null;
}

/** PUT /auth/profile 入参：服务端白名单，传其它字段一律 1001 */
export interface ProfileUpsertInput {
  nickname?: string;
  phone?: string;
  email?: string;
}

/** 菜单节点（C-05 MenuNode；permissionCode 为 null 表示登录即可见） */
export interface MenuNode {
  id: ID;
  name: string;
  path: string | null;
  component: string | null;
  icon: string | null;
  permissionCode: PermissionCode | null;
  visible: boolean;
  sort: number;
  children: MenuNode[];
}

/** 用户列表项（C-05 UserListItem；roleIds 为 Web 契约新增要求：分配角色弹窗预选，避免逐行拉详情） */
export interface UserListItem {
  id: ID;
  username: string;
  nickname: string | null;
  phone: string | null;
  email: string | null;
  avatar: string | null;
  status: 0 | 1;
  roleIds: ID[];
  lastLoginAt: string | null;
  lastLoginIp: string | null;
  createdAt: string;
}

/** 用户查询参数（API 规格 §3.3 + §1.5 通用分页） */
export interface UserQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: 0 | 1;
  role_id?: ID;
}

/** 新建 / 更新用户入参 */
export interface UserUpsertInput {
  username?: string;
  password?: string;
  nickname?: string;
  phone?: string;
  email?: string;
  status?: 0 | 1;
  roleIds?: ID[];
}

/** 分配角色入参（全量覆盖） */
export interface AssignRolesInput {
  roleIds: ID[];
}

/** 角色列表项（对外不含 permissionIds，授权情况查 /roles/:id/permissions） */
export interface RoleListItem {
  id: ID;
  code: string;
  name: string;
  remark: string | null;
  isSystem: boolean;
  dataScope: DataScope;
  sort: number;
  permissionCount: number;
}

/** 新建 / 更新角色入参 */
export interface RoleUpsertInput {
  code?: string;
  name?: string;
  remark?: string;
  dataScope?: DataScope;
  permissionIds?: ID[];
}

/** 权限点（授权页勾选用） */
export interface PermissionItem {
  id: ID;
  code: PermissionCode;
  name: string;
  type: PermissionType;
  module: string;
}

/** 权限点按 module 分组（GET /permissions 响应） */
export interface PermissionGroup {
  module: string;
  items: PermissionItem[];
}

/** 某角色已授权权限（GET /roles/:id/permissions 响应） */
export interface RolePermissionsResult {
  roleId: ID;
  permissions: PermissionItem[];
}

/** 菜单维护记录（GET /menus/tree 响应为扁平数组，管理页自行渲染树） */
export interface MenuManageItem {
  id: ID;
  parentId: ID;
  name: string;
  path: string | null;
  component: string | null;
  icon: string | null;
  permissionCode: PermissionCode | null;
  visible: boolean;
  sort: number;
}

/** 新建 / 更新菜单入参 */
export interface MenuUpsertInput {
  parentId?: ID;
  name?: string;
  path?: string;
  component?: string;
  icon?: string;
  permissionCode?: PermissionCode;
  visible?: boolean;
  sort?: number;
}

/** 字典分类 */
export interface DictCategory {
  id: ID;
  code: string;
  name: string;
  remark: string | null;
}

/** 字典项（useDict 消费；color 取 Element Plus tag 类型） */
export interface DictItem {
  id: ID;
  categoryId: ID;
  label: string;
  value: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'info' | null;
  sort: number;
}

/** 审计日志记录（与 @fw/auth AuditLogRecord 同源；时间字段序列化为 ISO 字符串） */
export interface AuditLogRecord {
  id: ID;
  userId: ID | null;
  module: string;
  action: AuditAction;
  targetType: string | null;
  targetId: ID | null;
  beforeValue: unknown;
  afterValue: unknown;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: string;
}

/** 审计查询参数 */
export interface AuditQuery {
  page?: number;
  pageSize?: number;
  user_id?: ID;
  module?: string;
  action?: AuditAction;
  target_type?: string;
  target_id?: ID;
  /** ISO 8601，含起始 */
  from?: string;
  /** ISO 8601，含结束 */
  to?: string;
}

/**
 * 登录设备 / 会话（M5 新增建议接口，待 L2 确认后纳入 API 规格 §3.2）
 * GET /auth/sessions —— 当前用户 refresh 族列表（个人中心「登录设备」）
 * DELETE /auth/sessions/:id —— 下线指定设备（撤销该族 refresh token）
 */
export interface LoginSession {
  id: ID;
  userId: ID;
  familyId: string;
  device: string;
  ip: string;
  lastSeenAt: string;
  createdAt: string;
  current: boolean;
}

/** 重置密码结果（一次性密码，仅展示一次） */
export interface ResetPasswordResult {
  id: ID;
  oneTimePassword: string;
}

/** 启用 / 禁用结果（禁用同时强制下线该用户会话） */
export interface SetUserStatusResult {
  id: ID;
  status: 0 | 1;
  forcedLogout: boolean;
}

/**
 * 业务错误码（docs/40-api-spec.md §2，与 C-01 同源）
 * 3001/3003 → 前端静默刷新并重试一次；3002 → 隐藏入口并提示；9001 → 提示 traceId；9003 → 按 Retry-After 退避
 */
export const BIZ_CODE = {
  OK: 0,
  BAD_REQUEST: 1001,
  NOT_FOUND: 1002,
  CONFLICT: 1003,
  STATE_NOT_ALLOWED: 1004,
  BUSINESS: 2001,
  UNAUTHORIZED: 3001,
  FORBIDDEN: 3002,
  TOKEN_EXPIRED: 3003,
  ACCOUNT_LOCKED: 3004,
  TENANT_INVALID: 4001,
  INTERNAL: 9001,
  DEPENDENCY_UNAVAILABLE: 9002,
  RATE_LIMITED: 9003,
} as const;

/**
 * 与后端 seed 的已知差异（集成日 I2 核对项，非契约破坏）：
 * 1. 菜单树：后端 seed 暂未注册「菜单管理 / 字典管理」两项菜单，mock 已按 PRD-005 页面清单补齐；
 * 2. 字典权限点（dict:read/create/update/delete）后端 seed 暂缺，mock 已按 API 规格 §3.6 补齐；
 * 3. /auth/sessions 为 M5 新增建议接口，待 L2 实现（未实现前个人中心「登录设备」在真实后端下为空列表）。
 */

// ==================== M7 队列管理（PRD-007 FR-09 / C-08 Job 契约，§3.8） ====================

/**
 * 队列管理端点（真实后端：/api/v1/admin/queue/*，由 @fw/queue QueueAdminController 提供；
 * 查看类需 system:queue:list，变更类需 system:queue:manage，与 C-08 QUEUE_PERMISSIONS 同源）：
 * GET  /queue/stats                       —— 队列状态与积压
 * GET  /queue/metrics                     —— 指标快照（成功率、平均耗时、幂等跳过、cron 抢锁失败）
 * GET  /queue/handlers                    —— 已注册任务名
 * GET  /queue/crons                       —— 定时任务快照
 * POST /queue/crons/:name/tick            —— 手动触发定时任务（仍走分布式锁）
 * GET  /queue/dead-letters                —— 死信列表（可按 queue 过滤）
 * POST /queue/dead-letters/:id/requeue    —— 重放单条死信
 * DELETE /queue/dead-letters              —— 清理死信（可按 queue 过滤）
 * POST /queue/pause ｜ /queue/resume      —— 暂停 / 恢复消费
 * DELETE /queue/drain                     —— 清空等待中的任务（可按 queue 过滤）
 */

/** 队列驱动名（MQ_DRIVER；kafka 仅预留，M8 落地） */
export type QueueDriverName = 'memory' | 'bullmq';

/** 单队列统计明细（与 C-08 QueueStatsItem 同源） */
export interface QueueStatsItem {
  name: string;
  waiting: number;
  active: number;
  completed: number;
  deadLetter: number;
  backlog: number;
  concurrency: number;
  rateLimit: number;
}

/** GET /queue/stats 响应 */
export interface QueueStats {
  driver: QueueDriverName;
  paused: boolean;
  consuming: boolean;
  queues: QueueStatsItem[];
  totals: { waiting: number; active: number; completed: number; deadLetter: number; backlog: number };
}

/** GET /queue/metrics 响应（successRate / avgDurationMs 为派生值） */
export interface QueueMetrics {
  driver: QueueDriverName;
  dispatched: number;
  succeeded: number;
  failed: number;
  deadLettered: number;
  idempotentSkipped: number;
  timedOut: number;
  cronTicked: number;
  cronLockedOut: number;
  successRate: number;
  avgDurationMs: number;
}

/** 死信记录（与 C-08 DeadLetterRecord 同源） */
export interface DeadLetterRecord {
  id: ID;
  name: string;
  queue: string;
  payload: unknown;
  attemptsMade: number;
  reason: string;
  failedAt: string;
  enqueuedAt: string;
}

/** GET /queue/dead-letters 响应 */
export interface DeadLetterListResult {
  total: number;
  items: DeadLetterRecord[];
}

/** 定时任务快照（与 C-08 CronSnapshot 同源） */
export interface CronSnapshot {
  name: string;
  expression: string;
  lock: boolean;
  nextRunAt: string | null;
  runs: number;
  lockedOut: number;
  lastResult: 'ok' | 'error' | null;
  lastRunAt: string | null;
}

/** GET /queue/crons 响应 */
export interface CronListResult {
  enabled: boolean;
  items: CronSnapshot[];
}

/** GET /queue/handlers 响应 */
export interface QueueHandlersResult {
  names: string[];
}

/** POST /queue/crons/:name/tick 响应 */
export interface CronTickResult {
  results: Array<{ name: string; acquired: boolean }>;
}

/** POST /queue/dead-letters/:id/requeue 响应 */
export interface DeadLetterRequeueResult {
  id: ID;
  requeued: boolean;
}

// ---------- §3.10 参数配置（M9 / PRD-009 FR-06） ----------

/** 配置键视图（GET /configs 列表项；boot 键 env 独占不进列表） */
export interface ConfigEntry {
  /** 点路径（如 log.level） */
  key: string;
  /** 当前生效值（运行时覆盖优先于 env 快照） */
  value: unknown;
  /** 生效来源：runtime = 被运行时覆盖；env = 仍取 env 快照 */
  source: 'runtime' | 'env';
  /** 是否可热更新（本列表只含白名单键，恒为 true） */
  hot: true;
  /** 对应 Env 键名（LOG_LEVEL 等，诊断用） */
  envKey: string;
  /** 最近一次生效时间（env 来源且从未被覆盖为 null） */
  updatedAt: string | null;
}

/** 配置中心运行元信息（诊断展示；不阻塞就绪判定） */
export interface ConfigCenterMetaInfo {
  driver: string;
  snapshotVersion: number;
  pollSeconds: number | null;
  lastAppliedAt: string | null;
  lastError: string | null;
}

/** GET /configs 响应 */
export interface ConfigListResult {
  configs: ConfigEntry[];
  meta: ConfigCenterMetaInfo;
}

/** PUT /configs/:key 请求体 */
export interface ConfigUpsertInput {
  /** 新值（JSON 语义：数字 / 字符串；服务端复用 env 同一份校验器） */
  value: unknown;
}

/** PUT /configs/:key 响应 */
export interface ConfigWriteResult {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  snapshotVersion: number;
}
