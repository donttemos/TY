/*
 * @file 鉴权存储的 Prisma 实现（业务侧适配器）
 * @description 把 @fw/auth 的 AuthStore 端口映射到 example-api 的 M3 表结构（docs/30-data-dictionary.md §3.1~3.13）。
 *   实现分工：
 *   - 带通用审计字段的表（users / roles / permissions / menus / refresh_tokens）走 @fw/db 的 PrismaRepository，
 *     软删过滤、审计字段填充、排序 tie-breaker 由基类保证；
 *   - 关联表（user_role / role_permission / user_department）与 audit_logs 没有完整通用字段（audit_logs 仅 created_at），
 *     且列表查询需要 OR / IN 等超出 Repository<T> 公共子集的条件，故直接用模型委托实现，
 *     全部为参数化查询，不涉及原生 SQL（dialect 白名单约束）。
 *   - M8 T-M8-04：本类同时实现 @fw/auth 的 DataScopeOrgPort（departments / user_department 查询），
 *     支撑 org / org_below 两档数据范围（PRD-008 FR-04/FR-05）；departments 与 users 列表同语义，
 *     暂不按租户过滤（与 M3 基线一致，跨租户收敛由守卫保证，FR-03 加固见 Backlog）。
 *   TODO(donttemo, 2026-10-13): 关联表与审计表建议由 @fw/db 补 RelationRepository / ReadOnlyRepository 下沉（M3 后）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-06）：audit_logs 统一事件契约增列透传（category/event/result/familyId/jti/requestId）
 * @modified 2026-10-13 donttemo 行类型按 @fw/auth 契约把主键收窄为 string（@fw/db 的 BaseEntity.id 为 string | number）
 * @modified 2026-10-14 donttemo M8 T-M8-04：实现 DataScopeOrgPort；pageUsers 支持 departmentIds、pageAuditLogs 支持 userIds
 * @modified 2026-10-14 donttemo BUG-15：pageUsers 消费 query.sort（映射为 Prisma orderBy，并始终追加 id asc tie-breaker）
 * @module example-api/auth
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
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
  DataScopeOrgPort,
  ID,
  NewAuditLog,
  NewRefreshToken,
  PermissionType,
  RefreshRotationResult,
  RefreshTokenRecord,
  RotateRefreshTokenInput,
  UserListItem,
  UserQuery,
} from '@fw/auth';
import { collectDescendantIds } from '@fw/auth';
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

/** refresh_tokens 表行（M11.1 起含 replacement 四列；旧库未迁移前列不存在 → optional） */
interface RefreshTokenRow extends Omit<BaseEntity, 'id'> {
  id: string;
  userId: string;
  tokenHash: string;
  familyId: string;
  expireAt: Date;
  revokedAt: Date | null;
  loginIp: string | null;
  userAgent: string | null;
  replacedById?: string | null;
  replacementCipher?: string | null;
  replacementKeyId?: string | null;
  replacementExpiresAt?: Date | null;
  rotatedFingerprint?: string | null;
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

/** user_department 行（M8 组织架构关联表） */
interface UserDepartmentRow {
  userId: string;
  departmentId: string;
  isPrimary: number;
}

/** departments 行（M8 组织架构；id/parentId 为 UUID 字符串，'0' 为顶级） */
interface DepartmentRow {
  id: string;
  parentId: string;
}

/** audit_logs 行 */
interface AuditLogRow {
  id: string;
  userId: string | null;
  module: string;
  action: string;
  category: string | null;
  event: string | null;
  result: string | null;
  familyId: string | null;
  jti: string | null;
  requestId: string | null;
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

/** rotation CAS 失败哨兵：仅用于触发事务回滚，由 catch 区分（真实存储错误原样上抛） */
class CasLostError extends Error {
  constructor() {
    super('rotation CAS lost');
    this.name = 'CasLostError';
  }
}

/**
 * AuthStore 的 Prisma 实现；同时实现 DataScopeOrgPort（M8 组织架构数据范围）
 */
@Injectable()
export class PrismaAuthStore implements AuthStore, DataScopeOrgPort {
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

    // roleId 与 departmentIds 均收敛为「用户 ID 集合」条件；同时传入时取交集（都不命中即空结果）
    let idFilter: string[] | null = null;
    if (query.roleId) {
      const links = (await this.delegate('userRole').findMany({ where: { roleId: query.roleId } })) as UserRoleRow[];
      idFilter = links.map((link) => link.userId);
    }
    if (query.departmentIds && query.departmentIds.length > 0) {
      const links = (await this.delegate('userDepartment').findMany({
        where: { departmentId: { in: query.departmentIds } },
      })) as UserDepartmentRow[];
      const deptUsers = links.map((link) => link.userId);
      idFilter = idFilter ? idFilter.filter((id) => deptUsers.includes(id)) : deptUsers;
    }
    if (idFilter) where.id = { in: idFilter };

    // 排序（BUG-15）：query.sort 已由 HTTP 层按字段白名单解析（未知字段在到达这里前即 400）；
    // 未传时回落 createdAt desc。无论哪种情形都以 id asc 收尾，保证分页在同一排序键下稳定（TC-ORM-002）。
    const sortEntries = Object.entries(query.sort ?? {});
    const orderBy: Array<Record<string, string>> = sortEntries.length
      ? sortEntries.map(([field, direction]) => ({ [field]: direction }))
      : [{ createdAt: 'desc' }];
    if (!sortEntries.some(([field]) => field === 'id')) orderBy.push({ id: 'asc' });

    const [rows, total] = await Promise.all([
      this.delegate('user').findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
      }) as Promise<UserRow[]>,
      this.delegate('user').count({ where }),
    ]);

    // 列表批量投影角色 ID（C-06 契约 §3.3：分配角色弹窗预选），避免逐行 N+1
    const roleLinks = rows.length
      ? ((await this.delegate('userRole').findMany({
          where: { userId: { in: rows.map((row) => row.id) } },
        })) as UserRoleRow[])
      : [];
    const roleIdsByUser = new Map<string, string[]>();
    for (const link of roleLinks) {
      const bucket = roleIdsByUser.get(link.userId) ?? [];
      bucket.push(link.roleId);
      roleIdsByUser.set(link.userId, bucket);
    }

    return {
      items: rows.map((row) => {
        const { passwordHash: _ignored, ...rest } = this.toAuthUser(row);
        return { ...rest, roleIds: roleIdsByUser.get(row.id) ?? [], createdAt: row.createdAt };
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
      // replacement 四列透传（ADR-0021：契约字段不得静默丢弃；正常业务均为 NULL）
      replacedById: record.replacedById ?? null,
      replacementCipher: record.replacementCipher ?? null,
      replacementKeyId: record.replacementKeyId ?? null,
      replacementExpiresAt: record.replacementExpiresAt ?? null,
      rotatedFingerprint: record.rotatedFingerprint ?? null,
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

  /**
   * 轮换 CAS（ADR-0020 Rule 1/3/4）：
   *
   * 事务内只做两条持久化操作——CAS 更新 A（affectedRows===1 即 rotation 权）+ 插入 B；
   * CAS 谓词含未撤销 + 未软删 + 未过期（Rule 2，消除 TOCTOU）。
   * CAS 失败抛 CasLostError 回滚整个事务，随后**在事务外**做判定性重读（Rule 4：
   * MySQL REPEATABLE READ 快照陷阱——任何 already_rotated/replay 的区分都不得复用
   * CAS 事务的快照）。生成 B / 签名 / 加密已在服务层事务外完成。
   */
  async rotateRefreshToken(input: RotateRefreshTokenInput): Promise<RefreshRotationResult> {
    const replacementId = randomUUID();
    try {
      // 显式放宽交互式事务超时：CAS 本身极短，但 SQLite 单写者下排队事务会顶到
      // Prisma 默认 5s 上限（MySQL/PG 行锁 + busy 重试无此约束）
      await this.client.$transaction(
        async (tx) => {
          // Rule 3 严格两条持久化语句：
          // ① CAS UPDATE A——一次性写入撤销/归属链/三列/指纹（replacedById 即本方法
          //    生成的 replacementId，不依赖读 A；B 的归属由服务层经 input 传入）；
          // ② INSERT B。
          // 事务内零 SELECT：归属字段 userId/familyId 轮换期内不可变，无 stale 风险；
          // 判定权只在 CAS 的 affectedRows（Rule 1），重读一律在事务外（Rule 4）。
          const cas = await tx.refreshToken.updateMany({
            where: {
              id: input.oldTokenId,
              revokedAt: null,
              deletedAt: null,
              expireAt: { gt: input.now },
            },
            data: {
              revokedAt: input.now,
              replacedById: replacementId,
              replacementCipher: input.replacementCipher,
              replacementKeyId: input.replacementKeyId,
              replacementExpiresAt: input.replacementRecoverableUntil,
              rotatedFingerprint: input.fingerprint,
            },
          });
          if (cas.count !== 1) throw new CasLostError();

          await tx.refreshToken.create({
            data: {
              id: replacementId,
              userId: input.replacementUserId,
              familyId: input.replacementFamilyId,
              tokenHash: input.replacementTokenHash,
              expireAt: input.replacementTokenExpiresAt,
              revokedAt: null,
              loginIp: input.replacementLoginIp,
              userAgent: input.replacementUserAgent,
            },
          });
        },
        { maxWait: 5_000, timeout: 15_000 },
      );
      return { outcome: 'rotated', replacementId };
    } catch (error) {
      if (!(error instanceof CasLostError)) throw error;
    }

    // Rule 4：以下判定性读取全部发生在 CAS 事务之外（新查询）
    const a = (await this.delegate('refreshToken').findUnique({
      where: { id: input.oldTokenId },
    })) as RefreshTokenRow | null;
    if (!a || a.deletedAt) return { outcome: 'replay_detected', reason: 'not_found' };
    if (a.expireAt.getTime() <= input.now.getTime()) {
      return { outcome: 'replay_detected', reason: 'expired' };
    }
    if (a.revokedAt && a.replacementCipher && a.replacementKeyId && a.replacementExpiresAt) {
      return {
        outcome: 'already_rotated',
        oldToken: { revokedAt: a.revokedAt, familyId: a.familyId },
        replacement: {
          cipher: a.replacementCipher,
          keyId: a.replacementKeyId,
          recoverableUntil: a.replacementExpiresAt,
        },
        fingerprint: a.rotatedFingerprint ?? null,
      };
    }
    return { outcome: 'replay_detected', reason: 'no_replacement' };
  }

  async purgeExpiredRefreshTokens(before: Date): Promise<number> {
    const result = await this.delegate('refreshToken').deleteMany({ where: { expireAt: { lt: before } } });
    return result.count;
  }

  /**
   * replacement 密文 grace 级清空（ADR-0021 决策 1/2）：
   * `replacementExpiresAt` 是唯一判据（部分写入/脏数据同样回收——含 cipher/keyId 已为 NULL
   * 而 expiresAt 残留的形态，清后三列必然全 NULL，满足 metadata invariant）；
   * 幂等性由「清空时 expiresAt 一并置 NULL」自然保证（该行不再满足 lt: now，重复执行 count = 0）；
   * 只置三列 NULL，保留 revokedAt / replacedById 历史链。
   */
  /**
   * 各 replacement keyId 的「仍存在可恢复密文」计数（ADR-0024 退役判据）：
   * 只统计 cipher/keyId/expiresAt 三列齐备且未过期的行——cipher 已清空的历史行不计入。
   */
  async countReplacementCiphersByKeyId(now: Date): Promise<Record<string, number>> {
    const rows = (await this.delegate('refreshToken').findMany({
      where: {
        replacementCipher: { not: null },
        replacementKeyId: { not: null },
        replacementExpiresAt: { gt: now },
      },
      select: { replacementKeyId: true },
    })) as Array<{ replacementKeyId: string | null }>;
    const counts: Record<string, number> = {};
    for (const row of rows) {
      if (row.replacementKeyId) {
        counts[row.replacementKeyId] = (counts[row.replacementKeyId] ?? 0) + 1;
      }
    }
    return counts;
  }

  async clearExpiredReplacementCiphers(now: Date): Promise<number> {
    const result = await this.delegate('refreshToken').updateMany({
      where: {
        replacementExpiresAt: { lt: now },
      },
      data: {
        replacementCipher: null,
        replacementKeyId: null,
        replacementExpiresAt: null,
      },
    });
    return result.count;
  }

  // ---------- 审计 ----------

  async writeAuditLog(record: NewAuditLog): Promise<void> {
    await this.delegate('auditLog').create({
      data: {
        userId: record.userId,
        module: record.module,
        action: record.action,
        category: record.category,
        event: record.event,
        result: record.result,
        familyId: record.familyId,
        jti: record.jti,
        requestId: record.requestId,
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
    if (query.userIds !== undefined) {
      // 数据范围注入的归属人集合（org / org_below 展开部门成员）；与 userId 同时传入取交集，
      // 空集合匹配不到任何记录（fail-closed，绝不因「无展开结果」退化为全量）
      const ids = query.userId ? query.userIds.filter((id) => id === query.userId) : query.userIds;
      where.userId = { in: ids };
    } else if (query.userId) {
      where.userId = query.userId;
    }
    if (query.module) where.module = query.module;
    if (query.action) where.action = query.action;
    if (query.targetType) where.targetType = query.targetType;
    if (query.targetId) where.targetId = query.targetId;
    // M12 W2 OBS-14：契约字段精确过滤（列于 migration 20261017110000 软增列，均有索引）
    if (query.traceId) where.traceId = query.traceId;
    if (query.requestId) where.requestId = query.requestId;
    if (query.familyId) where.familyId = query.familyId;
    if (query.category) where.category = query.category;
    if (query.event) where.event = query.event;
    if (query.from || query.to) {
      where.createdAt = {
        ...(query.from ? { gte: query.from } : {}),
        ...(query.to ? { lte: query.to } : {}),
      };
    }

    // 排序（BUG-15）：query.sort 已由 HTTP 层按字段白名单解析（未知字段在到达这里前即 400）；
    // 未传时回落 createdAt desc（与索引 audit(user_id, created_at) 的查询期望一致）。
    // 无论哪种情形都以 id asc 收尾，保证分页在同一排序键下稳定（TC-ORM-002）。
    const sortEntries = Object.entries(query.sort ?? {});
    const orderBy: Array<Record<string, string>> = sortEntries.length
      ? sortEntries.map(([field, direction]) => ({ [field]: direction }))
      : [{ createdAt: 'desc' }];
    if (!sortEntries.some(([field]) => field === 'id')) orderBy.push({ id: 'asc' });

    const [rows, total] = await Promise.all([
      this.delegate('auditLog').findMany({
        where,
        orderBy,
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

  // ---------- 组织架构（M8 T-M8-04，DataScopeOrgPort：PRD-008 FR-04/FR-05） ----------

  async listDepartmentIdsByUserId(userId: ID): Promise<ID[]> {
    const links = (await this.delegate('userDepartment').findMany({ where: { userId } })) as UserDepartmentRow[];
    return links.map((link) => link.departmentId);
  }

  async listVisibleDepartmentIds(userId: ID, scope: 'org' | 'org_below'): Promise<ID[]> {
    const own = await this.listDepartmentIdsByUserId(userId);
    // 无部门归属：返回空集合，由上层收敛为 self（放大会导致全量可见）
    if (own.length === 0) return [];
    if (scope === 'org') return own;
    const rows = (await this.delegate('department').findMany({ where: { deletedAt: null } })) as DepartmentRow[];
    return collectDescendantIds(rows, own);
  }

  async listUserIdsByDepartmentIds(departmentIds: ID[]): Promise<ID[]> {
    if (departmentIds.length === 0) return [];
    const links = (await this.delegate('userDepartment').findMany({
      where: { departmentId: { in: departmentIds } },
    })) as UserDepartmentRow[];
    return [...new Set(links.map((link) => link.userId))];
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
    // M11.1（ADR-0020）：replacement 四列随 20261016140000 migration 落库；旧库无列时 → null
    return {
      id: row.id,
      userId: row.userId,
      tokenHash: row.tokenHash,
      familyId: row.familyId,
      expireAt: row.expireAt,
      revokedAt: row.revokedAt,
      loginIp: row.loginIp,
      userAgent: row.userAgent,
      replacedById: row.replacedById ?? null,
      replacementCipher: row.replacementCipher ?? null,
      replacementKeyId: row.replacementKeyId ?? null,
      replacementExpiresAt: row.replacementExpiresAt ?? null,
      rotatedFingerprint: row.rotatedFingerprint ?? null,
    };
  }

  private toAuditLog(row: AuditLogRow): AuditLogRecord {
    return {
      id: row.id,
      userId: row.userId,
      module: row.module,
      action: row.action as AuditAction,
      category: (row.category ?? null) as AuditLogRecord['category'],
      event: row.event,
      result: (row.result ?? null) as AuditLogRecord['result'],
      familyId: row.familyId,
      jti: row.jti,
      requestId: row.requestId,
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
