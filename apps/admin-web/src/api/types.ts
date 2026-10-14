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

/** 死信列表结果 */
export interface DeadLetterListResult {
  total: number;
  items: DeadLetterRecord[];
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
