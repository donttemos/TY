/*
 * @file 鉴权存储内存实现
 * @description AuthStore 的内存实现：用于单元测试、无数据库演示与 M4 前的 stub（对齐 85 文档 §4 stub 策略）。
 *   与 Prisma 实现对齐的部分：分页 page 从 1 起、pageSize 上限 100；用户出参不含口令哈希；
 *   权限按 user_role → role_permission 聚合去重；用户带真实 createdAt（种子时刻/创建时刻）；
 *   用户列表默认排序 createdAt desc + id asc；关联写入校验引用存在（对齐 DB 外键）。
 *   **已知差异**（评审确认，非遗漏）：① NULL 在内存排序中视为最小值——Postgres 视 NULL 为最大、
 *   MySQL 视为最小，方言位置差异由各 Prisma 实现承担，内存实现只保证「同一输入 → 同一输出」；
 *   ② 仅进程内，多实例不共享状态。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 实现 hasActiveRefreshTokenInFamily
 * @modified 2026-10-14 donttemo BUG-15：pageUsers 消费 query.sort（内存排序 + 主键 tie-breaker 回落，
 *   与 Prisma 实现的排序语义保持一致）
 * @modified 2026-10-16 donttemo 驱动审查修复：① nextId 与 seedXxx 显式 id 撞号——种子 id 为 `mem-N`
 *   时推进计数器、发号时校验全表不重号（此前 seed mem-1 后 createUser 生成 mem-1 静默覆盖种子用户）；
 *   ② 用户建模真实 createdAt（此前列表恒 null，与 Prisma 不一致）；
 *   ③ updateUser 定义 patch 语义：业务列白名单（对齐 Prisma 可更新列），未知列报错；
 *   ④ replaceUserRoles / replaceRolePermissions 校验引用存在（对齐 DB 外键，杜绝悬空引用）；
 *   ⑤ 移除 grantRolePermissions 测试便利方法（与 replaceRolePermissions 完全等价，不该出现在生产类面）。
 * @module @fw/auth
 */

import type { PageResult } from '@fw/db';
import type {
  RotateRefreshTokenInput,
  RefreshRotationResult,
} from './auth-store.js';
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
 * updateUser 可更新的业务列白名单（对齐 Prisma users 表可更新列；
 * id 为主键、createdAt 由存储层管理，均不可经 patch 修改）
 */
const USER_PATCH_FIELDS: readonly string[] = [
  'tenantId',
  'username',
  'phone',
  'email',
  'passwordHash',
  'nickname',
  'avatar',
  'status',
  'lastLoginAt',
  'lastLoginIp',
];

/** `mem-N` 形态的种子 id：提取 N 用于推进计数器，避免与后续发号撞号 */
const MEM_ID_PATTERN = /^mem-(\d+)$/;

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
  /** 用户创建时间（seedUser / createUser 时刻；列表投影与排序用，对齐 Prisma 行为） */
  private readonly userCreatedAt = new Map<ID, Date>();
  private seq = 0;

  /** 生成自增主键（测试可预期；对已占用的 `mem-N` 跳号，绝不覆盖既有记录） */
  private nextId(): string {
    for (;;) {
      this.seq += 1;
      const id = `mem-${this.seq}`;
      if (!this.idInUse(id)) return id;
    }
  }

  /** id 是否已被任何一张内存表占用 */
  private idInUse(id: string): boolean {
    return (
      this.users.has(id) ||
      this.roles.has(id) ||
      this.permissions.has(id) ||
      this.menus.has(id) ||
      this.refreshTokens.has(id) ||
      this.auditLogs.some((log) => log.id === id)
    );
  }

  /** 种子显式 id 为 `mem-N` 时推进计数器（后续发号从 N+1 起，消除撞号窗口） */
  private noteSeededId(id: ID): void {
    const match = MEM_ID_PATTERN.exec(id);
    if (match) this.seq = Math.max(this.seq, Number(match[1]));
  }

  // ---------- 装配辅助（仅内存实现提供） ----------

  /** 直接注入用户（测试预置数据；createdAt 缺省为注入时刻，不入实体——实体结构与 Prisma 对齐） */
  seedUser(user: Omit<AuthUser, 'id'> & { id?: ID; createdAt?: Date }): AuthUser {
    const id = user.id ?? this.nextId();
    this.noteSeededId(id);
    const { createdAt, ...entityFields } = user;
    const entity: AuthUser = { ...entityFields, id };
    this.users.set(id, entity);
    this.userCreatedAt.set(id, createdAt ?? new Date());
    return entity;
  }

  /** 注入角色 */
  seedRole(role: Omit<AuthRole, 'id'> & { id?: ID }): AuthRole {
    const id = role.id ?? this.nextId();
    this.noteSeededId(id);
    const entity: AuthRole = { ...role, id };
    this.roles.set(id, entity);
    return entity;
  }

  /** 注入权限点 */
  seedPermission(permission: Omit<AuthPermission, 'id'> & { id?: ID }): AuthPermission {
    const id = permission.id ?? this.nextId();
    this.noteSeededId(id);
    const entity: AuthPermission = { ...permission, id };
    this.permissions.set(id, entity);
    return entity;
  }

  /** 注入菜单 */
  seedMenu(menu: Omit<AuthMenu, 'id'> & { id?: ID }): AuthMenu {
    const id = menu.id ?? this.nextId();
    this.noteSeededId(id);
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
    this.userCreatedAt.set(entity.id, new Date());
    return entity;
  }

  async updateUser(id: ID, patch: Partial<AuthUser>): Promise<AuthUser> {
    const current = this.users.get(id);
    if (!current) throw new Error(`用户不存在: ${id}`);
    // patch 语义（对齐 Prisma 列更新）：仅接受业务列白名单；未知列报错而非静默忽略
    // （Prisma 遇到未知列同样抛错）；id 不可变更，createdAt 由存储层管理
    const unknown = Object.keys(patch).filter((key) => !USER_PATCH_FIELDS.includes(key));
    if (unknown.length > 0) {
      throw new Error(`updateUser 不支持的字段: ${unknown.join(', ')}（仅接受用户业务列，id/createdAt 不可经 patch 修改）`);
    }
    const next = { ...current, ...patch, id };
    this.users.set(id, next);
    return next;
  }

  async pageUsers(query: UserQuery): Promise<PageResult<UserListItem>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    // createdAt 由存储层单独建模（AuthUser 实体与 Prisma 行结构对齐，不含创建时间列），
    // 排序与投影时从映射取真实值
    let rows = [...this.users.values()].map((user) => ({ user, createdAt: this.userCreatedAt.get(user.id) ?? null }));
    if (query.status !== undefined) rows = rows.filter((r) => r.user.status === query.status);
    if (query.keyword) {
      const kw = query.keyword.toLowerCase();
      rows = rows.filter(
        (r) => r.user.username.toLowerCase().includes(kw) || (r.user.nickname ?? '').toLowerCase().includes(kw),
      );
    }
    if (query.roleId) {
      rows = rows.filter((r) => this.userRoles.get(r.user.id)?.has(query.roleId as string) === true);
    }
    // 排序（BUG-15）：字段白名单已在 HTTP 层校验，这里只负责方向；
    // 未传时与 Prisma 实现一致回落 createdAt desc（createdAt 为真实种子/创建时刻）
    const sortEntries = Object.entries(query.sort ?? { createdAt: 'desc' }) as Array<[string, 'asc' | 'desc']>;
    rows.sort((a, b) => {
      for (const [field, direction] of sortEntries) {
        const left = field === 'createdAt' ? a.createdAt : (a.user as unknown as Record<string, unknown>)[field];
        const right = field === 'createdAt' ? b.createdAt : (b.user as unknown as Record<string, unknown>)[field];
        const diff = compareValues(left, right);
        if (diff !== 0) return direction === 'desc' ? -diff : diff;
      }
      return a.user.id < b.user.id ? -1 : a.user.id > b.user.id ? 1 : 0;
    });
    const total = rows.length;
    // C-06 契约 §3.3：列表项须带 roleIds（分配角色弹窗预选）与 createdAt。
    // createdAt 为真实种子/创建时刻（对齐 Prisma 行为）；roleIds 由关联集合投影。
    const items = rows.slice((page - 1) * pageSize, page * pageSize).map(({ user, createdAt }) => {
      const { passwordHash: _ignored, ...rest } = user;
      return { ...rest, roleIds: [...(this.userRoles.get(user.id) ?? [])], createdAt };
    });
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
    // 对齐 DB 外键：悬空引用直接报错，不静默写库（Prisma 侧 FK 违例同形）
    this.assertExists('用户', this.users.has(userId), userId);
    const missing = roleIds.filter((roleId) => !this.roles.has(roleId));
    this.assertMissing('角色', missing);
    this.userRoles.set(userId, new Set(roleIds));
  }

  async replaceRolePermissions(roleId: ID, permissionIds: ID[]): Promise<void> {
    this.assertExists('角色', this.roles.has(roleId), roleId);
    const missing = permissionIds.filter((permissionId) => !this.permissions.has(permissionId));
    this.assertMissing('权限点', missing);
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

  /**
   * 轮换 CAS（ADR-0020 Rule 1/5）。
   *
   * 内存实现的单线程语义下，「A 判断 → A 更新 → B 写入」处于同一个连续同步临界段
   * （中间无 await，等价于数据库事务的原子性）；CAS 谓词 = 未撤销 + 未过期。
   * grace 窗口与族存活评估不在这里——存储层只返回事实（ADR-0020 接口契约）。
   */
  async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<RefreshRotationResult> {
    const old = this.refreshTokens.get(input.oldTokenId);
    if (!old) return { outcome: 'replay_detected', reason: 'not_found' };
    if (old.expireAt.getTime() <= input.now.getTime()) {
      return { outcome: 'replay_detected', reason: 'expired' };
    }
    if (old.revokedAt) {
      if (!old.replacementCipher || !old.replacementKeyId || !old.replacementExpiresAt) {
        return { outcome: 'replay_detected', reason: 'no_replacement' };
      }
      return {
        outcome: 'already_rotated',
        oldToken: { revokedAt: old.revokedAt, familyId: old.familyId },
        replacement: {
          cipher: old.replacementCipher,
          keyId: old.replacementKeyId,
          recoverableUntil: old.replacementExpiresAt,
        },
      };
    }
    // CAS 赢家：更新 A + 写入 B 必须在同一同步临界段内完成（中间不得出现 await）
    const replacement: RefreshTokenRecord = {
      id: this.nextId(),
      userId: old.userId,
      tokenHash: input.replacementTokenHash,
      familyId: old.familyId,
      expireAt: input.replacementTokenExpiresAt,
      revokedAt: null,
      loginIp: input.replacementLoginIp,
      userAgent: input.replacementUserAgent,
      replacedById: null,
      replacementCipher: null,
      replacementKeyId: null,
      replacementExpiresAt: null,
    };
    this.refreshTokens.set(old.id, {
      ...old,
      revokedAt: input.now,
      replacedById: replacement.id,
      replacementCipher: input.replacementCipher,
      replacementKeyId: input.replacementKeyId,
      replacementExpiresAt: input.replacementRecoverableUntil,
    });
    this.refreshTokens.set(replacement.id, replacement);
    return { outcome: 'rotated', replacementId: replacement.id };
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

  /**
   * replacement 密文 grace 级清空（ADR-0021 决策 1/2）。
   * `replacementExpiresAt` 是唯一判据（部分写入/脏数据同样回收）；幂等性由「清空时
   * expiresAt 一并置 NULL」自然保证（该行不再满足判据，重复执行计 0）。同步临界段遍历。
   */
  async clearExpiredReplacementCiphers(now: Date): Promise<number> {
    let cleared = 0;
    for (const [id, record] of this.refreshTokens) {
      if (record.replacementExpiresAt !== null && record.replacementExpiresAt < now) {
        this.refreshTokens.set(id, {
          ...record,
          replacementCipher: null,
          replacementKeyId: null,
          replacementExpiresAt: null,
        });
        cleared += 1;
      }
    }
    return cleared;
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
    // 排序（BUG-15）：字段白名单已在 HTTP 层校验，这里只负责方向；
    // 未传时回落「最新在前」（与数据字典索引 audit(user_id, created_at) 的查询期望一致），
    // 两种情况都追加主键 tie-breaker，保证 skip/take 分页稳定（TC-ORM-002）
    const sortEntries = Object.entries(query.sort ?? { createdAt: 'desc' }) as Array<[string, 'asc' | 'desc']>;
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
    const items = rows.slice((page - 1) * pageSize, page * pageSize);
    return { items, total, page, pageSize, hasMore: page * pageSize < total };
  }

  /** 引用主体不存在的统一报错（对齐 DB 外键违例语义） */
  private assertExists(label: string, exists: boolean, id: ID): void {
    if (!exists) throw new Error(`${label}不存在: ${id}（关联写入须引用已存在的记录，外键约束）`);
  }

  /** 引用集合中不存在项的统一报错 */
  private assertMissing(label: string, missing: readonly string[]): void {
    if (missing.length > 0) throw new Error(`${label}不存在: ${missing.join(', ')}（关联写入须引用已存在的记录，外键约束）`);
  }
}

/**
 * 内存排序的字段值比较（BUG-15）
 *
 * Date 按时间戳、number 按数值、其余按字符串比较；null/undefined 视为最小值。
 * 具体方言的 NULL 排序位置差异由 Prisma 实现负责，内存实现只保证「同一输入 → 同一输出」的确定性
 * （见文件头「已知差异」）。
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
