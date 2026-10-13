/*
 * @file 鉴权存储端口（AuthStore）
 * @description @fw/auth 不感知具体表结构：所有持久化经本端口，由业务项目的 PrismaAuthStore 或
 *   内存实现（MemoryAuthStore）提供。这样框架包与项目 schema 解耦，与 M2「框架不感知 schema」一致。
 *   端口方法只表达意图（按账号找用户、置换角色），不暴露查询构造器，便于不同驱动实现。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 新增 hasActiveRefreshTokenInFamily（宽限通道前置校验族存活）
 * @module @fw/auth
 */

import type { PageResult } from '@fw/db';
import type {
  AuditLogRecord,
  AuditQuery,
  AuthMenu,
  AuthPermission,
  AuthRole,
  AuthUser,
  CreateUserInput,
  ID,
  RefreshTokenRecord,
  UserListItem,
  UserQuery,
} from './types.js';

/** 新增刷新令牌入参（id 由存储层生成） */
export type NewRefreshToken = Omit<RefreshTokenRecord, 'id'>;

/** 新增审计日志入参（id 由存储层生成） */
export type NewAuditLog = Omit<AuditLogRecord, 'id'>;

/**
 * 鉴权存储端口
 */
export interface AuthStore {
  // ---------- 用户 ----------

  /** 按账号（用户名 / 手机号 / 邮箱）查用户，未找到返回 null */
  findUserByAccount(account: string): Promise<AuthUser | null>;
  /** 按主键查用户 */
  findUserById(id: ID): Promise<AuthUser | null>;
  /** 创建用户（passwordHash 必填，调用方已哈希） */
  createUser(input: CreateUserInput): Promise<AuthUser>;
  /** 局部更新用户 */
  updateUser(id: ID, patch: Partial<AuthUser>): Promise<AuthUser>;
  /** 用户分页（返回结果不含口令哈希） */
  pageUsers(query: UserQuery): Promise<PageResult<UserListItem>>;
  /** 更新最近登录时间与 IP（登录成功时调用） */
  touchUserLogin(id: ID, at: Date, ip: string | null): Promise<void>;

  // ---------- 角色与权限 ----------

  /** 全部角色 */
  listRoles(): Promise<AuthRole[]>;
  /** 某用户持有的角色 */
  listRolesByUserId(userId: ID): Promise<AuthRole[]>;
  /** 全部权限点 */
  listPermissions(): Promise<AuthPermission[]>;
  /** 某用户经由角色聚合出的权限点（已去重） */
  listPermissionsByUserId(userId: ID): Promise<AuthPermission[]>;
  /** 全部菜单（可见性由调用方按权限码过滤） */
  listMenus(): Promise<AuthMenu[]>;
  /** 全量覆盖用户角色 */
  replaceUserRoles(userId: ID, roleIds: ID[]): Promise<void>;
  /** 全量覆盖角色权限 */
  replaceRolePermissions(roleId: ID, permissionIds: ID[]): Promise<void>;
  /** 某角色已授权的权限点 ID 列表 */
  listPermissionIdsByRoleId(roleId: ID): Promise<ID[]>;
  /** 持有指定角色的用户 ID（角色权限变更后按标签失效其权限缓存） */
  listUserIdsByRoleId(roleId: ID): Promise<ID[]>;

  // ---------- 刷新令牌 ----------

  /** 落库一条刷新令牌记录（只存哈希） */
  createRefreshToken(record: NewRefreshToken): Promise<RefreshTokenRecord>;
  /** 按令牌哈希查记录 */
  findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null>;
  /** 撤销单条记录 */
  revokeRefreshToken(id: ID, at: Date): Promise<void>;
  /** 撤销整个轮换族，返回受影响条数 */
  revokeRefreshFamily(familyId: string, at: Date): Promise<number>;
  /**
   * 轮换族内是否仍存在有效（未撤销且未过期）令牌。
   * 用途：refresh 的并发宽限通道必须确认「族仍存活」——族被整族撤销（泄漏处置 / 登出 / 强制下线）后，
   * 族内任何旧令牌都不得再借宽限窗口换发新令牌，否则泄漏处置会被绕过。
   */
  hasActiveRefreshTokenInFamily(familyId: string, now: Date): Promise<boolean>;
  /** 撤销某用户全部刷新令牌（改密 / 踢下线），返回受影响条数 */
  revokeUserRefreshTokens(userId: ID, at: Date): Promise<number>;
  /** 清理过期记录（保留期由定时任务决定），返回清理条数 */
  purgeExpiredRefreshTokens(before: Date): Promise<number>;

  // ---------- 审计 ----------

  /** 写入审计日志（异步落盘，失败不得阻塞主流程） */
  writeAuditLog(record: NewAuditLog): Promise<void>;
  /** 审计日志分页查询 */
  pageAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>>;
}
