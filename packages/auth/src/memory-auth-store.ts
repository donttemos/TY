/*
 * @file 鉴权存储内存实现
 * @description AuthStore 的内存实现：用于单元测试、无数据库演示与 M4 前的 stub（对齐 85 文档 §4 stub 策略）。
 *   行为与 Prisma 实现保持一致：分页 page 从 1 起、pageSize 上限 100；用户出参不含口令哈希；
 *   权限按 user_role → role_permission 聚合去重。仅用于进程内场景，多实例下不共享状态。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 实现 hasActiveRefreshTokenInFamily
 * @modified 2026-10-14 donttemo BUG-15：pageUsers 消费 query.sort（内存排序 + 主键 tie-breaker 回落，
 *   与 Prisma 实现的排序语义保持一致）
 * @module @fw/auth
 */

import type { PageResult } from '@fw/db';
import type { AuthStore, NewAuditLog, NewRefreshToken } from './auth-store.js';
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

/** 单页条数上限（与 @fw/db 的 PAGE_SIZE_MAX 对齐） */
const PAGE_SIZE_MAX = 100;

/**
 * 内存存储：测试与演示用
 */
export class MemoryAuthStore implements AuthStore {
  private readonly users = new Map<ID, AuthUser>();
  private readonly roles = new Map<ID, AuthRole>();
  private readonly permissions = new Map<ID, AuthPermission>();
  private readonly menus = new Map<ID, AuthMenu>();
  private readonly userRoles = new Map<ID, Set<ID>>();
  private readonly rolePermissions = new Map<ID, Set<ID>>();
  private readonly refreshTokens = new Map<ID, RefreshTokenRecord>();
  private readonly auditLogs: AuditLogRecord[] = [];
  private seq = 0;

  /** 生成自增主键（测试可预期） */
  private nextId(): string {
    this.seq += 1;
    return `mem-${this.seq}`;
  }

  // ---------- 装配辅助（仅内存实现提供） ----------

  /** 直接注入用户（测试预置数据） */
  seedUser(user: Omit<AuthUser, 'id'> & { id?: ID }): AuthUser {
    const id = user.id ?? this.nextId();
    const entity: AuthUser = { ...user, id };
    this.users.set(id, entity);
    return entity;
  }

  /** 注入角色 */
  seedRole(role: Omit<AuthRole, 'id'> & { id?: ID }): AuthRole {
    const id = role.id ?? this.nextId();
    const entity: AuthRole = { ...role, id };
    this.roles.set(id, entity);
    return entity;
  }

  /** 注入权限点 */
  seedPermission(permission: Omit<AuthPermission, 'id'> & { id?: ID }): AuthPermission {
    const id = permission.id ?? this.nextId();
    const entity: AuthPermission = { ...permission, id };
    this.permissions.set(id, entity);
    return entity;
  }

  /** 注入菜单 */
  seedMenu(menu: Omit<AuthMenu, 'id'> & { id?: ID }): AuthMenu {
    const id = menu.id ?? this.nextId();
    const entity: AuthMenu = { ...menu, id };
    this.menus.set(id, entity);
    return entity;
  }

  // ---------- 用户 ----------

  async findUserByAccount(account: string): Promise<AuthUser | null> {
    for (const user of this.users.values()) {
      if (user.username === account || user.phone === account || user.email === account) return user;
    }
    return null;
  }

  async findUserById(id: ID): Promise<AuthUser | null> {
    return this.users.get(id) ?? null;
  }

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const entity: AuthUser = {
      id: this.nextId(),
      username: input.username,
      phone: input.phone ?? null,
      email: input.email ?? null,
      passwordHash: input.passwordHash,
      nickname: input.nickname ?? null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    };
    this.users.set(entity.id, entity);
    return entity;
  }

  async updateUser(id: ID, patch: Partial<AuthUser>): Promise<AuthUser> {
    const current = this.users.get(id);
    if (!current) throw new Error(`用户不存在: ${id}`);
    const next = { ...current, ...patch, id };
    this.users.set(id, next);
    return next;
  }

  async pageUsers(query: UserQuery): Promise<PageResult<UserListItem>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    let rows = [...this.users.values()];
    if (query.status !== undefined) rows = rows.filter((u) => u.status === query.status);
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      rows = rows.filter((u) => u.username.toLowerCase().includes(kw) || (u.nickname ?? '').toLowerCase().includes(kw));
    }
    if (query.roleId) {
      rows = rows.filter((u) => this.userRoles.get(u.id)?.has(query.roleId as string) === true);
    }
    // 排序（BUG-15）：字段白名单已在 HTTP 层校验，这里只负责方向；未传时回落主键升序
    const sortEntries = Object.entries(query.sort ?? {}) as Array<[string, 'asc' | 'desc']>;
    rows.sort((a, b) => {
      const left = a as unknown as Record<string, unknown>;
      const right = b as unknown as Record<string, unknown>;
      for (const [field, direction] of sortEntries) {
        const diff = compareValues(left[field], right[field]);
        if (diff !== 0) return direction === 'desc' ? -diff : diff;
      }
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    const total = rows.length;
    // C-06 契约 §3.3：列表项须带 roleIds（分配角色弹窗预选）与 createdAt。
    // 内存实现不建模创建时间（用户是 seedUser 注入的），roleIds 由关联集合投影。
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map(({ passwordHash: _ignored, ...rest }) => ({
      ...rest,
      roleIds: [...(this.userRoles.get(rest.id) ?? [])],
      createdAt: null,
    }));
    return { items, total, page, pageSize, hasMore: page * pageSize < total };
  }

  async touchUserLogin(id: ID, at: Date, ip: string | null): Promise<void> {
    const user = this.users.get(id);
    if (!user) return;
    this.users.set(id, { ...user, lastLoginAt: at, lastLoginIp: ip });
  }

  // ---------- 角色与权限 ----------

  async listRoles(): Promise<AuthRole[]> {
    return [...this.roles.values()];
  }

  async listRolesByUserId(userId: ID): Promise<AuthRole[]> {
    const ids = this.userRoles.get(userId);
    if (!ids) return [];
    return [...ids].map((id) => this.roles.get(id)).filter((r): r is AuthRole => Boolean(r));
  }

  async listPermissions(): Promise<AuthPermission[]> {
    return [...this.permissions.values()];
  }

  async listPermissionsByUserId(userId: ID): Promise<AuthPermission[]> {
    const roleIds = this.userRoles.get(userId);
    if (!roleIds) return [];
    const codeSet = new Map<ID, AuthPermission>();
    for (const roleId of roleIds) {
      for (const permId of this.rolePermissions.get(roleId) ?? []) {
        const perm = this.permissions.get(permId);
        if (perm) codeSet.set(perm.id, perm);
      }
    }
    return [...codeSet.values()];
  }

  async listMenus(): Promise<AuthMenu[]> {
    return [...this.menus.values()].sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1));
  }

  async replaceUserRoles(userId: ID, roleIds: ID[]): Promise<void> {
    this.userRoles.set(userId, new Set(roleIds));
  }

  async replaceRolePermissions(roleId: ID, permissionIds: ID[]): Promise<void> {
    this.rolePermissions.set(roleId, new Set(permissionIds));
  }

  async listPermissionIdsByRoleId(roleId: ID): Promise<ID[]> {
    return [...(this.rolePermissions.get(roleId) ?? [])];
  }

  async listUserIdsByRoleId(roleId: ID): Promise<ID[]> {
    const userIds: ID[] = [];
    for (const [userId, roleIds] of this.userRoles) {
      if (roleIds.has(roleId)) userIds.push(userId);
    }
    return userIds;
  }

  /** 直接授权（测试便捷方法，等价于 replaceRolePermissions） */
  async grantRolePermissions(roleId: ID, permissionIds: ID[]): Promise<void> {
    await this.replaceRolePermissions(roleId, permissionIds);
  }

  // ---------- 刷新令牌 ----------

  async createRefreshToken(record: NewRefreshToken): Promise<RefreshTokenRecord> {
    const entity: RefreshTokenRecord = { ...record, id: this.nextId() };
    this.refreshTokens.set(entity.id, entity);
    return entity;
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    for (const record of this.refreshTokens.values()) {
      if (record.tokenHash === tokenHash) return record;
    }
    return null;
  }

  async revokeRefreshToken(id: ID, at: Date): Promise<void> {
    const record = this.refreshTokens.get(id);
    if (record && !record.revokedAt) this.refreshTokens.set(id, { ...record, revokedAt: at });
  }

  async revokeRefreshFamily(familyId: string, at: Date): Promise<number> {
    let affected = 0;
    for (const [id, record] of this.refreshTokens) {
      if (record.familyId === familyId && !record.revokedAt) {
        this.refreshTokens.set(id, { ...record, revokedAt: at });
        affected += 1;
      }
    }
    return affected;
  }

  async hasActiveRefreshTokenInFamily(familyId: string, now: Date): Promise<boolean> {
    for (const record of this.refreshTokens.values()) {
      if (record.familyId === familyId && !record.revokedAt && record.expireAt > now) return true;
    }
    return false;
  }

  async revokeUserRefreshTokens(userId: ID, at: Date): Promise<number> {
    let affected = 0;
    for (const [id, record] of this.refreshTokens) {
      if (record.userId === userId && !record.revokedAt) {
        this.refreshTokens.set(id, { ...record, revokedAt: at });
        affected += 1;
      }
    }
    return affected;
  }

  async purgeExpiredRefreshTokens(before: Date): Promise<number> {
    let removed = 0;
    for (const [id, record] of this.refreshTokens) {
      if (record.expireAt < before) {
        this.refreshTokens.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  // ---------- 审计 ----------

  async writeAuditLog(record: NewAuditLog): Promise<void> {
    this.auditLogs.push({ ...record, id: this.nextId() });
  }

  async pageAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    let rows = [...this.auditLogs];
    if (query.userId) rows = rows.filter((r) => r.userId === query.userId);
    if (query.module) rows = rows.filter((r) => r.module === query.module);
    if (query.action) rows = rows.filter((r) => r.action === query.action);
    if (query.targetType) rows = rows.filter((r) => r.targetType === query.targetType);
    if (query.targetId) rows = rows.filter((r) => r.targetId === query.targetId);
    if (query.from) rows = rows.filter((r) => r.createdAt >= (query.from as Date));
    if (query.to) rows = rows.filter((r) => r.createdAt <= (query.to as Date));
    // 最新在前（与数据字典索引 audit(user_id, created_at) 的查询期望一致）
    rows.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
    const total = rows.length;
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize, hasMore: page * pageSize < total };
  }
}

/**
 * 内存排序的字段值比较（BUG-15）
 *
 * Date 按时间戳、number 按数值、其余按字符串比较；null/undefined 视为最小值。
 * 具体方言的 NULL 排序位置差异由 Prisma 实现负责，内存实现只保证「同一输入 → 同一输出」的确定性。
 */
function compareValues(left: unknown, right: unknown): number {
  if (left === right) return 0;
  if (left === null || left === undefined) return -1;
  if (right === null || right === undefined) return 1;
  if (left instanceof Date || right instanceof Date) {
    const leftTime = new Date(left as string | number | Date).getTime();
    const rightTime = new Date(right as string | number | Date).getTime();
    return leftTime - rightTime;
  }
  if (typeof left === 'number' && typeof right === 'number') return left - right;
  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
}
