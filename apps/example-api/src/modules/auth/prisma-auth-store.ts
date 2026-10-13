/*
 * @file 鉴权存储的 Prisma 实现（业务侧适配器）
 * @description 把 @fw/auth 的 AuthStore 端口映射到 example-api 的 M3 表结构（docs/30-data-dictionary.md §3.1~3.13）。
 *   实现分工：
 *   - 带通用审计字段的表（users / roles / permissions / menus / refresh_tokens）走 @fw/db 的 PrismaRepository，
 *     软删过滤、审计字段填充、排序 tie-breaker 由基类保证；
 *   - 关联表（user_role / role_permission）与 audit_logs 没有完整通用字段（audit_logs 仅 created_at），
 *     且列表查询需要 OR / IN 等超出 Repository<T> 公共子集的条件，故直接用模型委托实现，
 *     全部为参数化查询，不涉及原生 SQL（dialect 白名单约束）。
 *   TODO(donttemo, 2026-10-13): 关联表与审计表建议由 @fw/db 补 RelationRepository / ReadOnlyRepository 下沉（M3 后）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 行类型按 @fw/auth 契约把主键收窄为 string（@fw/db 的 BaseEntity.id 为 string | number）
 * @module example-api/auth
 */

import { Inject, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { DB_CLIENT, PrismaRepository, type ModelDelegate, type PrismaClientLike } from '@fw/db';
import type { PageResult } from '@fw/db';
import type {
  AuditAction,
  AuditLogRecord,
  AuditQuery,
  AuthMenu,
  AuthPermission,
  AuthRole,
  AuthStore,
  AuthUser,
  CreateUserInput,
  DataScope,
  ID,
  NewAuditLog,
  NewRefreshToken,
  PermissionType,
  RefreshTokenRecord,
  UserListItem,
  UserQuery,
} from '@fw/auth';
import type { BaseEntity } from '@fw/db';

/**
 * 行类型统一说明：@fw/db 的 BaseEntity.id 为 `string | number`（泛化层需兼容自增主键），
 * 而 @fw/auth 契约要求字符串主键。这里用 Omit 覆盖 id 收窄为 string，
 * 既满足 PrismaRepository<T extends BaseEntity> 约束，又让映射函数返回精确类型。
 */

/** users 表行 */
interface UserRow extends Omit<BaseEntity, 'id'> {
  id: string;
  tenantId: bigint;
  username: string;
  phone: string | null;
  email: string | null;
  passwordHash: string;
  nickname: string | null;
  avatar: string | null;
  status: number;
  lastLoginAt: Date | null;
  lastLoginIp: string | null;
}

/** roles 表行 */
interface RoleRow extends Omit<BaseEntity, 'id'> {
  id: string;
  tenantId: bigint;
  code: string;
  name: string;
  remark: string | null;
  isSystem: number;
  dataScope: string;
  sort: number;
}

/** permissions 表行 */
interface PermissionRow extends Omit<BaseEntity, 'id'> {
  id: string;
  code: string;
  name: string;
  type: string;
  module: string | null;
  sort: number;
}

/** menus 表行 */
interface MenuRow extends Omit<BaseEntity, 'id'> {
  id: string;
  parentId: string;
  name: string;
  path: string | null;
  component: string | null;
  icon: string | null;
  permissionCode: string | null;
  visible: number;
  sort: number;
}

/** refresh_tokens 表行 */
interface RefreshTokenRow extends Omit<BaseEntity, 'id'> {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expireAt: Date;
  revokedAt: Date | null;
  loginIp: string | null;
  userAgent: string | null;
}

/** user_role 行 */
interface UserRoleRow {
  userId: string;
  roleId: string;
}

/** role_permission 行 */
interface RolePermissionRow {
  roleId: string;
  permissionId: string;
}

/** audit_logs 行 */
interface AuditLogRow {
  id: string;
  userId: string | null;
  module: string;
  action: string;
  targetType: string | null;
  targetId: string | null;
  beforeValue: unknown;
  afterValue: unknown;
  ip: string | null;
  userAgent: string | null;
  traceId: string | null;
  createdAt: Date;
}

/** 单页条数上限（与 @fw/db 对齐） */
const PAGE_SIZE_MAX = 100;

/**
 * AuthStore 的 Prisma 实现
 */
@Injectable()
export class PrismaAuthStore implements AuthStore {
  private readonly users: PrismaRepository<UserRow>;
  private readonly roles: PrismaRepository<RoleRow>;
  private readonly permissions: PrismaRepository<PermissionRow>;
  private readonly menus: PrismaRepository<MenuRow>;
  private readonly refreshTokens: PrismaRepository<RefreshTokenRow>;

  /**
   * @param client DbModule 提供的插桩 PrismaClient
   */
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {
    this.users = new PrismaRepository<UserRow>(client, 'user');
    this.roles = new PrismaRepository<RoleRow>(client, 'role');
    this.permissions = new PrismaRepository<PermissionRow>(client, 'permission');
    this.menus = new PrismaRepository<MenuRow>(client, 'menu');
    this.refreshTokens = new PrismaRepository<RefreshTokenRow>(client, 'refreshToken');
  }

  /** 取模型委托（关联表与审计表用） */
  private delegate(model: string): ModelDelegate {
    return this.client[model] as ModelDelegate;
  }

  // ---------- 用户 ----------

  async findUserByAccount(account: string): Promise<AuthUser | null> {
    // 依次按用户名 / 手机号 / 邮箱查询（避免 OR 条件越过 Repository<T> 公共子集）
    for (const field of ['username', 'phone', 'email'] as const) {
      const row = await this.users.findOne({ [field]: account } as unknown as Partial<UserRow>);
      if (row) return this.toAuthUser(row);
    }
    return null;
  }

  async findUserById(id: ID): Promise<AuthUser | null> {
    const row = await this.users.findById(id);
    return row ? this.toAuthUser(row) : null;
  }

  async createUser(input: CreateUserInput): Promise<AuthUser> {
    const row = await this.users.create({
      username: input.username,
      passwordHash: input.passwordHash,
      phone: input.phone ?? null,
      email: input.email ?? null,
      nickname: input.nickname ?? null,
    });
    return this.toAuthUser(row as UserRow);
  }

  async updateUser(id: ID, patch: Partial<AuthUser>): Promise<AuthUser> {
    const row = await this.users.update(id, patch as Partial<UserRow>);
    return this.toAuthUser(row);
  }

  async pageUsers(query: UserQuery): Promise<PageResult<UserListItem>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    const where: Record<string, unknown> = { deletedAt: null };
    if (query.status !== undefined) where.status = query.status;
    if (query.keyword) {
      where.OR = [
        { username: { contains: query.keyword } },
        { nickname: { contains: query.keyword } },
        { phone: { contains: query.keyword } },
      ];
    }
    if (query.roleId) {
      const links = (await this.delegate('userRole').findMany({ where: { roleId: query.roleId } })) as UserRoleRow[];
      where.id = { in: links.map((link) => link.userId) };
    }

    const [rows, total] = await Promise.all([
      this.delegate('user').findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<UserRow[]>,
      this.delegate('user').count({ where }),
    ]);

    return {
      items: rows.map((row) => {
        const { passwordHash: _ignored, ...rest } = this.toAuthUser(row);
        return rest;
      }),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async touchUserLogin(id: ID, at: Date, ip: string | null): Promise<void> {
    await this.users.update(id, { lastLoginAt: at, lastLoginIp: ip } as Partial<UserRow>);
  }

  // ---------- 角色与权限 ----------

  async listRoles(): Promise<AuthRole[]> {
    const rows = await this.roles.list(undefined, { sort: 'asc' });
    return rows.map((row) => this.toAuthRole(row));
  }

  async listRolesByUserId(userId: ID): Promise<AuthRole[]> {
    const links = (await this.delegate('userRole').findMany({ where: { userId } })) as UserRoleRow[];
    if (links.length === 0) return [];
    const rows = (await this.delegate('role').findMany({
      where: { id: { in: links.map((l) => l.roleId) }, deletedAt: null },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    })) as RoleRow[];
    return rows.map((row) => this.toAuthRole(row));
  }

  async listPermissions(): Promise<AuthPermission[]> {
    const rows = await this.permissions.list(undefined, { sort: 'asc' });
    return rows.map((row) => this.toAuthPermission(row));
  }

  async listPermissionsByUserId(userId: ID): Promise<AuthPermission[]> {
    const roleLinks = (await this.delegate('userRole').findMany({ where: { userId } })) as UserRoleRow[];
    if (roleLinks.length === 0) return [];
    const permLinks = (await this.delegate('rolePermission').findMany({
      where: { roleId: { in: roleLinks.map((l) => l.roleId) } },
    })) as RolePermissionRow[];
    if (permLinks.length === 0) return [];
    const rows = (await this.delegate('permission').findMany({
      where: { id: { in: [...new Set(permLinks.map((l) => l.permissionId))] }, deletedAt: null },
      orderBy: [{ sort: 'asc' }, { id: 'asc' }],
    })) as PermissionRow[];
    return rows.map((row) => this.toAuthPermission(row));
  }

  async listMenus(): Promise<AuthMenu[]> {
    const rows = await this.menus.list(undefined, { sort: 'asc' });
    return rows.map((row) => this.toAuthMenu(row));
  }

  async replaceUserRoles(userId: ID, roleIds: ID[]): Promise<void> {
    await this.delegate('userRole').deleteMany({ where: { userId } });
    for (const roleId of [...new Set(roleIds)]) {
      await this.delegate('userRole').create({ data: { userId, roleId } });
    }
  }

  async replaceRolePermissions(roleId: ID, permissionIds: ID[]): Promise<void> {
    await this.delegate('rolePermission').deleteMany({ where: { roleId } });
    for (const permissionId of [...new Set(permissionIds)]) {
      await this.delegate('rolePermission').create({ data: { roleId, permissionId } });
    }
  }

  async listPermissionIdsByRoleId(roleId: ID): Promise<ID[]> {
    const links = (await this.delegate('rolePermission').findMany({ where: { roleId } })) as RolePermissionRow[];
    return links.map((link) => link.permissionId);
  }

  async listUserIdsByRoleId(roleId: ID): Promise<ID[]> {
    const links = (await this.delegate('userRole').findMany({ where: { roleId } })) as UserRoleRow[];
    return links.map((link) => link.userId);
  }

  // ---------- 刷新令牌 ----------

  async createRefreshToken(record: NewRefreshToken): Promise<RefreshTokenRecord> {
    const row = await this.refreshTokens.create({
      userId: record.userId,
      tokenHash: record.tokenHash,
      familyId: record.familyId,
      expireAt: record.expireAt,
      revokedAt: record.revokedAt,
      loginIp: record.loginIp,
      userAgent: record.userAgent,
    } as Partial<RefreshTokenRow>);
    return this.toRefreshToken(row);
  }

  async findRefreshTokenByHash(tokenHash: string): Promise<RefreshTokenRecord | null> {
    const row = await this.refreshTokens.findOne({ tokenHash } as unknown as Partial<RefreshTokenRow>);
    return row ? this.toRefreshToken(row) : null;
  }

  async revokeRefreshToken(id: ID, at: Date): Promise<void> {
    await this.refreshTokens.update(id, { revokedAt: at } as Partial<RefreshTokenRow>);
  }

  async revokeRefreshFamily(familyId: string, at: Date): Promise<number> {
    const result = await this.delegate('refreshToken').updateMany({
      where: { familyId, revokedAt: null, deletedAt: null },
      data: { revokedAt: at },
    });
    return result.count;
  }

  async hasActiveRefreshTokenInFamily(familyId: string, now: Date): Promise<boolean> {
    const count = await this.delegate('refreshToken').count({
      where: { familyId, revokedAt: null, deletedAt: null, expireAt: { gt: now } },
    });
    return count > 0;
  }

  async revokeUserRefreshTokens(userId: ID, at: Date): Promise<number> {
    const result = await this.delegate('refreshToken').updateMany({
      where: { userId, revokedAt: null, deletedAt: null },
      data: { revokedAt: at },
    });
    return result.count;
  }

  async purgeExpiredRefreshTokens(before: Date): Promise<number> {
    const result = await this.delegate('refreshToken').deleteMany({ where: { expireAt: { lt: before } } });
    return result.count;
  }

  // ---------- 审计 ----------

  async writeAuditLog(record: NewAuditLog): Promise<void> {
    await this.delegate('auditLog').create({
      data: {
        userId: record.userId,
        module: record.module,
        action: record.action,
        targetType: record.targetType,
        targetId: record.targetId,
        beforeValue: this.toJson(record.beforeValue),
        afterValue: this.toJson(record.afterValue),
        ip: record.ip,
        userAgent: record.userAgent,
        traceId: record.traceId,
        createdAt: record.createdAt,
      },
    });
  }

  async pageAuditLogs(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    const where: Record<string, unknown> = {};
    if (query.userId) where.userId = query.userId;
    if (query.module) where.module = query.module;
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }

    const [rows, total] = await Promise.all([
      this.delegate('auditLog').findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<AuditLogRow[]>,
      this.delegate('auditLog').count({ where }),
    ]);

    return {
      items: rows.map((row) => this.toAuditLog(row)),
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  // ---------- 行 → 领域对象 ----------

  private toAuthUser(row: UserRow): AuthUser {
    return {
      id: row.id,
      // M8：bigint → 十进制字符串，与 @fw/logger 请求上下文 tenantId 同构（守卫直接比较）
      tenantId: row.tenantId?.toString(),
      username: row.username,
      phone: row.phone,
      email: row.email,
      passwordHash: row.passwordHash,
      nickname: row.nickname,
      avatar: row.avatar,
      status: row.status,
      lastLoginAt: row.lastLoginAt,
      lastLoginIp: row.lastLoginIp,
    };
  }

  private toAuthRole(row: RoleRow): AuthRole {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      dataScope: row.dataScope as DataScope,
      isSystem: row.isSystem === 1,
    };
  }

  private toAuthPermission(row: PermissionRow): AuthPermission {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      type: row.type as PermissionType,
      module: row.module,
    };
  }

  private toAuthMenu(row: MenuRow): AuthMenu {
    return {
      id: row.id,
      parentId: row.parentId,
      name: row.name,
      path: row.path,
      component: row.component,
      icon: row.icon,
      permissionCode: row.permissionCode,
      visible: row.visible === 1,
      sort: row.sort,
    };
  }

  private toRefreshToken(row: RefreshTokenRow): RefreshTokenRecord {
    return {
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      familyId: row.familyId,
      expireAt: row.expireAt,
      revokedAt: row.revokedAt,
      loginIp: row.loginIp,
      userAgent: row.userAgent,
    };
  }

  private toAuditLog(row: AuditLogRow): AuditLogRecord {
    return {
      id: row.id,
      userId: row.userId,
      module: row.module,
      action: row.action as AuditAction,
      targetType: row.targetType,
      targetId: row.targetId,
      beforeValue: row.beforeValue ?? null,
      afterValue: row.afterValue ?? null,
      ip: row.ip,
      userAgent: row.userAgent,
      traceId: row.traceId,
      createdAt: row.createdAt,
    };
  }

  /** 审计 JSON 字段：空值写 DB NULL，非空写 JSON 值 */
  private toJson(value: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
    return value === null || value === undefined ? Prisma.DbNull : (value as Prisma.InputJsonValue);
  }
}
