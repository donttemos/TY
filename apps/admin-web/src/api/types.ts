/*
 * @file 前端 API 类型（C-06 契约镜像）
 * @description 与 docs/contracts/api-web.ts 逐字段对应；契约变更时两边同步改（契约只读，本文件为消费侧副本）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 新增 ProfileResult（GET / PUT /auth/profile，个人中心自助资料）
 * @module admin-web/api
 */

/** 主键 */
export type ID = string;

/** 数据权限范围 */
export type DataScope = 'all' | 'org_below' | 'org' | 'self';

/** 权限点类型 */
export type PermissionType = 'menu' | 'button' | 'api';

/** 权限码 */
export type PermissionCode = `${string}:${string}`;

/** 审计动作 */
export type AuditAction = 'create' | 'update' | 'delete' | 'login' | 'logout' | 'export' | 'grant';

/** 分页结果 */
export interface PageResult<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

/** 双 token */
export interface TokenPair {
  tokenType: 'Bearer';
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
}

/** 登录结果 */
export interface LoginResult extends TokenPair {
  user: LoginUser;
}

/** 登录用户视图 */
export interface LoginUser {
  id: ID;
  username: string;
  roles: string[];
  permissions: PermissionCode[];
  dataScope: DataScope;
  via: 'jwt' | 'session' | 'oauth2' | 'apikey';
}

/** GET /auth/me */
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
 * 本人资料视图（GET / PUT /auth/profile）
 * 与 MeResult 同构，另含手机 / 邮箱——个人中心回显与自助维护不需要 user:read 权限。
 */
export interface ProfileResult extends MeResult {
  phone: string | null;
  email: string | null;
}

/** 菜单节点（动态路由数据源） */
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

/** 用户列表项（roleIds 供「分配角色」弹窗预选，避免逐行拉详情；C-06 契约要求列表返回） */
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

/** 用户查询参数 */
export interface UserQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  status?: 0 | 1;
  role_id?: ID;
}

/** 新建 / 更新用户 */
export interface UserUpsertInput {
  username?: string;
  password?: string;
  nickname?: string;
  phone?: string;
  email?: string;
  status?: 0 | 1;
  roleIds?: ID[];
}

/** 角色列表项 */
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

/** 角色入参 */
export interface RoleUpsertInput {
  code?: string;
  name?: string;
  remark?: string;
  dataScope?: DataScope;
  permissionIds?: ID[];
}

/** 权限点 */
export interface PermissionItem {
  id: ID;
  code: PermissionCode;
  name: string;
  type: PermissionType;
  module: string;
}

/** 权限点分组 */
export interface PermissionGroup {
  module: string;
  items: PermissionItem[];
}

/** 权限树节点（M10 E-04：业务域 → 权限点 → 子资源预留；codes 含子孙权限码，扁平化取码无需递归） */
export interface PermissionTreeNode {
  /** 节点键（module 名或权限码，同级唯一） */
  key: string;
  /** 展示名（module 用原名；权限点用 name） */
  label: string;
  type: 'module' | PermissionType;
  /** 权限点 ID（module 层无；授权页勾选提交 permissionIds 直接可用） */
  id?: string;
  /** 该节点下的权限码集合（含子孙） */
  codes: string[];
  children: PermissionTreeNode[];
}

/** 角色已授权权限 */
export interface RolePermissionsResult {
  roleId: ID;
  permissions: PermissionItem[];
}

/** 菜单维护记录 */
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

/** 菜单入参 */
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

/** 字典项 */
export interface DictItem {
  id: ID;
  categoryId: ID;
  label: string;
  value: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'info' | null;
  sort: number;
}

/** 审计日志 */
export interface AuditLogRecord {
  id: ID;
  userId: ID | null;
  module: string;
  action: AuditAction;
  /** 审计大类（PRD-012 OBS-06：auth/security/admin/data/config/tenant/system） */
  category: string | null;
  /** 点分事件名（如 auth.login / refresh.replay_detected） */
  event: string | null;
  /** 事件结果（success / denied / failed） */
  result: string | null;
  /** 令牌家族 ID（安全事件关联键） */
  familyId: string | null;
  /** 令牌标识 jti（非令牌本体） */
  jti: string | null;
  /** 单次请求 ID（PRD-012 OBS-09） */
  requestId: string | null;
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
  from?: string;
  to?: string;
  /** 排序（api-spec §1.5：`<snake_case 字段>:asc|desc`） */
  sort?: string;
  /** 链路 ID 精确过滤（M12 W2 OBS-14） */
  trace_id?: string;
  /** 单请求 ID 精确过滤（M12 W2 OBS-14） */
  request_id?: string;
  /** 令牌家族 ID 精确过滤（M12 W2 OBS-14） */
  family_id?: string;
  /** 低基数大类过滤（M12 W2 OBS-14） */
  category?: string;
  /** 点分事件名精确过滤（M12 W2 OBS-14） */
  event?: string;
}

/** 登录设备 / 会话 */
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

/** 重置密码结果 */
export interface ResetPasswordResult {
  id: ID;
  oneTimePassword: string;
}

/** 启用 / 禁用结果 */
export interface SetUserStatusResult {
  id: ID;
  status: 0 | 1;
  forcedLogout: boolean;
}

/** 用户状态枚举（演示订单等复用） */
export const USER_STATUS = { DISABLED: 0, ENABLED: 1 } as const;

// ---------- M7 队列管理（C-06 契约 §3.8 / C-08 Job 契约） ----------

/** 队列驱动名 */
export type QueueDriverName = 'memory' | 'bullmq';

/** 单队列统计明细 */
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

/** 队列统计（driver / paused / consuming / 各队列明细 / 合计） */
export interface QueueStats {
  driver: QueueDriverName;
  paused: boolean;
  consuming: boolean;
  queues: QueueStatsItem[];
  totals: { waiting: number; active: number; completed: number; deadLetter: number; backlog: number };
}

/** 队列指标快照 */
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

/** 死信记录 */
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

/** 死信列表结果（分页；`page`/`pageSize` 为死信分页改造后追加的字段） */
export interface DeadLetterListResult {
  total: number;
  items: DeadLetterRecord[];
  page: number;
  pageSize: number;
}

/** 定时任务快照 */
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

/** 定时任务列表结果 */
export interface CronListResult {
  enabled: boolean;
  items: CronSnapshot[];
}

/** 已注册任务名 */
export interface QueueHandlersResult {
  names: string[];
}

/** 定时任务手动触发结果 */
export interface CronTickResult {
  results: Array<{ name: string; acquired: boolean }>;
}

/** 死信重放结果 */
export interface DeadLetterRequeueResult {
  id: ID;
  requeued: boolean;
}

// ---------- N-01 租户管理（C-06 契约 §3.9） ----------

/** 租户隔离级别 */
export type TenantIsolation = 'shared' | 'dedicated';

/** 租户视图（不包含任何连接串信息；独立库只用布尔位表达「是否已配置」） */
export interface TenantView {
  id: ID;
  code: string;
  name: string;
  isolation: TenantIsolation;
  plan: string | null;
  status: 0 | 1;
  expireAt: string | null;
  dedicatedDbConfigured: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 租户查询参数 */
export interface TenantQuery {
  page?: number;
  pageSize?: number;
  keyword?: string;
  isolation?: TenantIsolation;
  status?: 0 | 1;
  sort?: string;
}

/** 开租户 / 更新租户入参 */
export interface TenantUpsertInput {
  code?: string;
  name?: string;
  isolation?: TenantIsolation;
  plan?: string | null;
  expireAt?: string | null;
  status?: 0 | 1;
  /** 迁移到 dedicated 时必填：独立库连接串（明文，服务端加密落库） */
  dbUrl?: string;
}

/** 隔离级别迁移入参 */
export interface TenantMigrateInput {
  isolation: TenantIsolation;
  dbUrl?: string;
}

// ---------- N-02 异步任务中心（通用任务面 /jobs） ----------

/** 任务状态 */
export type JobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/** 任务视图（轮询进度 / 任务条渲染的数据源） */
export interface JobView {
  id: string;
  type: string;
  title: string;
  status: JobStatus;
  progress: number;
  message: string | null;
  error: string | null;
  traceId: string;
  fileName: string | null;
  createdAt: string;
  updatedAt: string;
}

// ---------- M9 配置中心（PRD-009 FR-06/FR-07，api-spec §3.10） ----------

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

/** PUT /configs/:key 响应 */
export interface ConfigWriteResult {
  key: string;
  oldValue: unknown;
  newValue: unknown;
  snapshotVersion: number;
}

// ---------- M10 E-12 SSE 实时推送 ----------

/** 任务事件类型：created（派发/重跑）/ progress（运行中与进度推进）/ finished（终态） */
export type JobEventKind = 'created' | 'progress' | 'finished';

/** `job` 事件载荷（`GET /events/stream` 的 event: job） */
export interface JobEventPayload {
  kind: JobEventKind;
  /** 任务视图（与 `GET /jobs/:id/progress` 同形，前端零转换消费） */
  job: JobView;
  /** 任务归属人（服务端已按此过滤，仅推送本人任务） */
  ownerId: string;
}

/** 队列告警类型 */
export type QueueAlertKind = 'dead-letter' | 'backlog';

/** `queue` 事件载荷（`GET /events/stream` 的 event: queue；仅持 `system:queue:list` 者可见） */
export interface QueueAlertPayload {
  kind: QueueAlertKind;
  at: string;
  queue?: string;
  jobId?: string;
  jobName?: string;
  attemptsMade?: number;
  reason?: string;
  waiting?: number;
  threshold?: number;
}

/** `POST /events/ticket` 响应：一次性 SSE 票据 */
export interface SseTicket {
  ticket: string;
  /** 有效期（秒） */
  expiresIn: number;
  /** 该用户可订阅的主题 */
  topics: Array<'job' | 'queue'>;
}

// ---------- M10 E-13 站内信 / 通知中心 ----------

/** 通知级别（前端按级别着色） */
export type NotificationLevel = 'info' | 'success' | 'warning' | 'error';

/** 通知业务类型 */
export type NotificationKind = 'job.finished' | 'job.failed' | 'queue.dead-letter' | 'queue.backlog' | 'system';

/** 站内信列表项（`GET /notifications` 的 items） */
export interface NotificationView {
  id: string;
  kind: NotificationKind;
  level: NotificationLevel;
  title: string;
  content: string | null;
  /** 关联资源类型（job / queue / null） */
  refType: string | null;
  /** 关联资源 ID（如 jobId，可用于跳转任务条） */
  refId: string | null;
  traceId: string | null;
  read: boolean;
  readAt: string | null;
  createdAt: string;
}

/** `GET /notifications` 响应 */
export interface NotificationListResult {
  total: number;
  /** 未读总数（与 unread-count 同源） */
  unread: number;
  items: NotificationView[];
  page: number;
  pageSize: number;
}

/** `notification` SSE 事件载荷 */
export interface NotificationCreatedPayload {
  ownerId: string;
  notification: NotificationView;
}

// ===== M13 SaaS 运营（api-spec §3.21；与 @fw/saas 领域视图同构，BigInt 值后端转 string） =====

/** 套餐定义（GET /saas/plans） */
export interface PlanView {
  id: string;
  code: string;
  name: string;
  description: string | null;
}

/** 套餐版本（发布后不可变） */
export interface PlanVersionView {
  id: string;
  planId: string;
  version: number;
  status: 'draft' | 'published' | 'deprecated';
  remark: string | null;
  publishedAt: string | null;
}

/** 租户订阅（一租户至多一个 active） */
export interface SubscriptionView {
  id: string;
  tenantId: string;
  planId: string;
  planVersionId: string;
  status: 'active' | 'expired' | 'cancelled';
  effectiveAt: string;
  expireAt: string | null;
  closedAt: string | null;
  reason: string | null;
}

/** 生命周期迁移日志（只增不改不删） */
export interface LifecycleLog {
  tenantId: string;
  fromStatus: string | null;
  toStatus: string;
  action: string;
  actorType: 'system' | 'user';
  actorId: string | null;
  reason: string | null;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  requestId: string | null;
  createdAt: string;
}
