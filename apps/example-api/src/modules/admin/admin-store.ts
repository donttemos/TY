/*
 * @file 管理后台存储端口与 Prisma 实现（C-06 前端 API 契约 §3.3~§3.6 的落地）
 * @description C-06 契约冻结于 M5，前端 admin-web 与 mock 已按契约全量实现，而真实后端只落地到
 *   「M3/M8 演示可验证」深度，导致契约声明、mock 存在、后端未注册的端点接入真实 API 后集体 404。
 *   本文件补齐这批能力（用户软删、角色维护、菜单维护、登录设备、审计详情、字典），
 *   与 @fw/auth 的 AuthStore 分工：
 *     - AuthStore：鉴权域能力（登录 / 双 token / RBAC 判定 / 审计写入 / 用户与菜单的只读查询）；
 *     - AdminStore：管理面维护能力（写操作 + 列表增强字段），不改动框架包契约，避免 MemoryAuthStore 回归。
 *   表结构仍走 @fw/db 的 PrismaRepository：软删过滤、审计字段（createdBy/updatedBy）、
 *   tenant 收敛由基类保证；关联表与字典项用模型委托（条件超出 Repository<T> 公共子集），全部参数化查询。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api/admin
 */

import { Inject, Injectable } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { DB_CLIENT, PrismaRepository, type ModelDelegate, type PrismaClientLike } from '@fw/db';
import type { BaseEntity } from '@fw/db';
import type {
  AuditAction,
  AuditLogRecord,
  AuthMenu,
  DataScope,
  ID,
  UserListItem,
} from '@fw/auth';

/**
 * 行类型统一说明：@fw/db 的 BaseEntity.id 为 `string | number`（泛化层需兼容自增主键），
 * 而本模块契约要求字符串主键。用 Omit 覆盖 id 收窄为 string，与 PrismaAuthStore 同构。
 */

/** users 表行（仅用于复用 PrismaRepository 的软删与审计字段填充） */
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
  code: string;
  name: string;
  remark: string | null;
  isSystem: number;
  dataScope: string;
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

/** dict_categories 表行 */
interface DictCategoryRow extends Omit<BaseEntity, 'id'> {
  id: string;
  code: string;
  name: string;
  remark: string | null;
}

/** dict_items 表行 */
interface DictItemRow extends Omit<BaseEntity, 'id'> {
  id: string;
  categoryId: string;
  label: string;
  value: string;
  color: string | null;
  sort: number;
}

/** audit_logs 表行 */
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

/** 用户-角色关联行 */
interface UserRoleRow {
  userId: string;
  roleId: string;
}

/** 登录设备视图（C-06 契约 §3.2 LoginSession；设备语义为刷新令牌轮换族） */
export interface SessionView {
  /** 会话标识（族内最新一条刷新令牌 ID，供下线接口使用） */
  id: string;
  userId: string;
  /** 轮换族 ID：族内出现复用即判定泄漏，登出即整族撤销 */
  familyId: string;
  /** 设备描述（User-Agent 原文） */
  device: string | null;
  ip: string | null;
  /** 最近活跃时间（族内最新令牌创建时间） */
  lastSeenAt: Date;
  createdAt: Date;
}

/** 登录设备对外视图（控制器叠加 current 标记后的形状，与 C-06 契约 LoginSession 逐字段对应） */
export interface LoginSessionView extends SessionView {
  /** 设备描述（null 归一为占位文案） */
  device: string;
  /** 是否当前设备（同 IP 且同 User-Agent） */
  current: boolean;
}

/** 角色详情（C-06 契约 §3.4 RoleListItem：列表需带 permissionCount 供授权页展示） */
export interface RoleDetail {
  id: ID;
  code: string;
  name: string;
  remark: string | null;
  dataScope: DataScope;
  isSystem: boolean;
  sort: number;
  /** 已授权权限点数量（role_permission 关联条数，避免列表逐角色 N+1 查询） */
  permissionCount: number;
}

/** 新建 / 更新角色入参 */
export interface RoleUpsertInput {
  code?: string;
  name?: string;
  remark?: string | null;
  dataScope?: DataScope;
  sort?: number;
}

/** 新建 / 更新菜单入参（parentId 缺省 '0' 为顶级） */
export interface MenuUpsertInput {
  parentId?: string;
  name?: string;
  path?: string | null;
  component?: string | null;
  icon?: string | null;
  permissionCode?: string | null;
  visible?: boolean;
  sort?: number;
}

/** 字典分类视图（C-06 契约 §3.6 DictCategory） */
export interface DictCategoryView {
  id: ID;
  code: string;
  name: string;
  remark: string | null;
}

/** 字典项视图（C-06 契约 §3.6 DictItem） */
export interface DictItemView {
  id: ID;
  categoryId: ID;
  label: string;
  value: string;
  color: 'primary' | 'success' | 'warning' | 'danger' | 'info' | null;
  sort: number;
}

/** 字典项入参 */
export interface DictItemUpsertInput {
  label: string;
  value: string;
  color?: DictItemView['color'];
  sort?: number;
}

/** 字典分类入参 */
export interface DictCategoryUpsertInput {
  code: string;
  name: string;
  remark?: string | null;
}

/**
 * 管理后台存储端口
 */
export interface AdminStore {
  // ---------- 用户补充能力 ----------

  /** 某用户持有的角色 ID 列表（分配角色弹窗预选） */
  listRoleIdsByUserId(userId: ID): Promise<ID[]>;
  /** 按主键查用户列表项（含 roleIds / createdAt；已软删返回 null） */
  findUserListItemById(userId: ID): Promise<UserListItem | null>;
  /** 软删除用户（不可删内置管理员由调用方裁定） */
  softDeleteUser(id: ID): Promise<void>;

  // ---------- 角色维护 ----------

  /** 角色详情列表（含权限点计数，按 sort 升序） */
  listRoleDetails(): Promise<RoleDetail[]>;
  /** 新建角色（code 唯一冲突抛 409） */
  createRole(input: RoleUpsertInput): Promise<RoleDetail>;
  /** 更新角色资料（内置角色不可改 code，由调用方裁定） */
  updateRole(id: ID, patch: RoleUpsertInput): Promise<RoleDetail>;
  /** 删除角色（需先确认无用户绑定，调用方裁定） */
  deleteRole(id: ID): Promise<void>;
  /** 复制角色（含权限），新角色 code 追加 `-copy` 后缀并保证唯一 */
  copyRole(id: ID): Promise<RoleDetail>;
  /** 持有指定角色的用户数（删除前校验） */
  countRoleUsers(roleId: ID): Promise<number>;

  // ---------- 菜单维护 ----------

  /** 新建菜单 */
  createMenu(input: MenuUpsertInput): Promise<AuthMenu>;
  /** 更新菜单 */
  updateMenu(id: ID, patch: MenuUpsertInput): Promise<AuthMenu>;
  /** 删除菜单（软删；有子菜单由调用方拒绝） */
  deleteMenu(id: ID): Promise<void>;
  /** 子菜单数量（删除前校验） */
  countChildMenus(id: ID): Promise<number>;

  // ---------- 登录设备 ----------

  /** 某用户的活跃会话（未撤销且未过期的轮换族，按最近活跃倒序） */
  listSessionsByUser(userId: ID, now: Date): Promise<SessionView[]>;

  // ---------- 审计详情 ----------

  /** 按主键查审计日志（不存在返回 null） */
  findAuditLogById(id: ID): Promise<AuditLogRecord | null>;

  // ---------- 字典 ----------

  listDictCategories(): Promise<DictCategoryView[]>;
  createDictCategory(input: DictCategoryUpsertInput): Promise<DictCategoryView>;
  updateDictCategory(id: ID, patch: Partial<DictCategoryUpsertInput>): Promise<DictCategoryView>;
  /** 删除分类（连带软删其下字典项） */
  deleteDictCategory(id: ID): Promise<void>;
  listDictItems(categoryId: ID): Promise<DictItemView[]>;
  /** 按分类编码取字典项（useDict 消费入口） */
  listDictItemsByCode(code: string): Promise<DictItemView[]>;
  createDictItem(categoryId: ID, input: DictItemUpsertInput): Promise<DictItemView>;
  updateDictItem(id: ID, patch: Partial<DictItemUpsertInput>): Promise<DictItemView>;
  deleteDictItem(id: ID): Promise<void>;
}

/** 字典项颜色白名单（与前端 StatusTag / DictSelect 的 tag 类型对齐） */
const DICT_COLORS = new Set<DictItemView['color']>(['primary', 'success', 'warning', 'danger', 'info']);

/** 数据范围白名单（与 roles.data_scope 同源） */
const DATA_SCOPES = new Set<string>(['all', 'org_below', 'org', 'self']);

/** 管理后台存储注入令牌（与 @fw/auth 的 AUTH_STORE 同风格：端口由业务侧实现，经 DI 注入） */
export const ADMIN_STORE = Symbol('FW_ADMIN_STORE');

/**
 * AdminStore 的 Prisma 实现
 */
@Injectable()
export class PrismaAdminStore implements AdminStore {
  private readonly roles: PrismaRepository<RoleRow>;
  private readonly users: PrismaRepository<UserRow>;
  private readonly menus: PrismaRepository<MenuRow>;
  private readonly dictCategories: PrismaRepository<DictCategoryRow>;
  private readonly dictItems: PrismaRepository<DictItemRow>;

  /** @param client DbModule 提供的插桩 PrismaClient */
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {
    this.roles = new PrismaRepository<RoleRow>(client, 'role');
    this.users = new PrismaRepository<UserRow>(client, 'user');
    this.menus = new PrismaRepository<MenuRow>(client, 'menu');
    this.dictCategories = new PrismaRepository<DictCategoryRow>(client, 'dictCategory');
    this.dictItems = new PrismaRepository<DictItemRow>(client, 'dictItem');
  }

  /** 取模型委托（关联表 / 审计表 / 用户软删用） */
  private delegate(model: string): ModelDelegate {
    return this.client[model] as ModelDelegate;
  }

  // ---------- 用户补充能力 ----------

  async listRoleIdsByUserId(userId: ID): Promise<ID[]> {
    const links = (await this.delegate('userRole').findMany({ where: { userId } })) as UserRoleRow[];
    return links.map((link) => link.roleId);
  }

  async findUserListItemById(userId: ID): Promise<UserListItem | null> {
    const row = (await this.delegate('user').findUnique({ where: { id: userId } })) as UserRow | null;
    if (!row || row.deletedAt) return null;
    return {
      id: row.id,
      // bigint → 十进制字符串，与 AuthUser.tenantId 同构（守卫直接比较）
      tenantId: row.tenantId?.toString(),
      username: row.username,
      phone: row.phone,
      email: row.email,
      nickname: row.nickname,
      avatar: row.avatar,
      status: row.status,
      lastLoginAt: row.lastLoginAt,
      lastLoginIp: row.lastLoginIp,
      roleIds: await this.listRoleIdsByUserId(userId),
      createdAt: row.createdAt,
    };
  }

  async softDeleteUser(id: ID): Promise<void> {
    const row = (await this.delegate('user').findUnique({ where: { id } })) as UserRow | null;
    if (!row) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');
    // 释放唯一键：软删记录仍占用 username / phone / email 的唯一约束，同名账号将永远无法重建
    // （人员离职后重新入职即撞 409，且错误信息无法指出真实原因）。追加重删后缀释放占用，
    // 保留可读性，审计仍可按原 id 追溯；已释放过的跳过，保证重复调用幂等。
    const suffix = `#deleted-${id.slice(0, 8)}`;
    const released = row.username.includes('#deleted-');
    await this.users.update(id, {
      ...(released
        ? {}
        : {
            username: `${row.username}${suffix}`,
            phone: row.phone ? `${row.phone}${suffix}` : null,
            email: row.email ? `${row.email}${suffix}` : null,
          }),
      deletedAt: new Date(),
    } as Partial<UserRow>);
  }

  // ---------- 角色维护 ----------

  async listRoleDetails(): Promise<RoleDetail[]> {
    const rows = await this.roles.list(undefined, { sort: 'asc' });
    // 权限点计数一次聚合，避免列表 N+1（role_permission 无 relation，Prisma 不能 include）
    const links = (await this.delegate('rolePermission').findMany({})) as Array<{ roleId: string }>;
    const counts = new Map<string, number>();
    for (const link of links) counts.set(link.roleId, (counts.get(link.roleId) ?? 0) + 1);
    return rows.map((row) => this.toRoleDetail(row, counts.get(row.id) ?? 0));
  }

  async createRole(input: RoleUpsertInput): Promise<RoleDetail> {
    if (!input.code || !input.name) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'code 与 name 必填');
    }
    if (input.dataScope && !DATA_SCOPES.has(input.dataScope)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `dataScope 仅支持 ${[...DATA_SCOPES].join(' / ')}`);
    }
    const row = await this.roles.create({
      code: input.code,
      name: input.name,
      remark: input.remark ?? null,
      isSystem: 0,
      dataScope: input.dataScope ?? 'self',
      sort: input.sort ?? 0,
    } as Partial<RoleRow>);
    return this.toRoleDetail(row as RoleRow, 0);
  }

  async updateRole(id: ID, patch: RoleUpsertInput): Promise<RoleDetail> {
    if (patch.dataScope && !DATA_SCOPES.has(patch.dataScope)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `dataScope 仅支持 ${[...DATA_SCOPES].join(' / ')}`);
    }
    const data: Partial<RoleRow> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.remark !== undefined) data.remark = patch.remark;
    if (patch.dataScope !== undefined) data.dataScope = patch.dataScope;
    if (patch.sort !== undefined) data.sort = patch.sort;
    const row = await this.roles.update(id, data);
    const links = (await this.delegate('rolePermission').findMany({ where: { roleId: id } })) as Array<{ roleId: string }>;
    return this.toRoleDetail(row as RoleRow, links.length);
  }

  async deleteRole(id: ID): Promise<void> {
    // 先删关联再删角色：role_permission / user_role 无级联（M3 建表即无外键），须显式清理
    await this.delegate('rolePermission').deleteMany({ where: { roleId: id } });
    await this.delegate('userRole').deleteMany({ where: { roleId: id } });
    await this.roles.hardDelete(id);
  }

  async copyRole(id: ID): Promise<RoleDetail> {
    const source = await this.roles.findById(id);
    if (!source) throw new BizError(ErrorCode.NOT_FOUND, '角色不存在');
    const granted = (await this.delegate('rolePermission').findMany({ where: { roleId: id } })) as Array<{
      permissionId: string;
    }>;
    const code = await this.uniqueRoleCode(`${source.code}-copy`);
    const created = await this.roles.create({
      code,
      name: `${source.name} 副本`,
      remark: source.remark,
      isSystem: 0,
      dataScope: source.dataScope as DataScope,
      sort: source.sort,
    } as Partial<RoleRow>);
    for (const link of granted) {
      await this.delegate('rolePermission').create({ data: { roleId: created.id, permissionId: link.permissionId } });
    }
    return this.toRoleDetail(created as RoleRow, granted.length);
  }

  async countRoleUsers(roleId: ID): Promise<number> {
    return this.delegate('userRole').count({ where: { roleId } });
  }

  // ---------- 菜单维护 ----------

  async createMenu(input: MenuUpsertInput): Promise<AuthMenu> {
    if (!input.name) throw new BizError(ErrorCode.BAD_REQUEST, 'name 必填');
    const row = await this.menus.create({
      parentId: input.parentId ?? '0',
      name: input.name,
      path: input.path ?? null,
      component: input.component ?? null,
      icon: input.icon ?? null,
      permissionCode: input.permissionCode ?? null,
      visible: input.visible === false ? 0 : 1,
      sort: input.sort ?? 0,
    } as Partial<MenuRow>);
    return this.toAuthMenu(row as MenuRow);
  }

  async updateMenu(id: ID, patch: MenuUpsertInput): Promise<AuthMenu> {
    const data: Partial<MenuRow> = {};
    if (patch.parentId !== undefined) data.parentId = patch.parentId;
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.path !== undefined) data.path = patch.path;
    if (patch.component !== undefined) data.component = patch.component;
    if (patch.icon !== undefined) data.icon = patch.icon;
    if (patch.permissionCode !== undefined) data.permissionCode = patch.permissionCode;
    if (patch.visible !== undefined) data.visible = patch.visible ? 1 : 0;
    if (patch.sort !== undefined) data.sort = patch.sort;
    const row = await this.menus.update(id, data);
    return this.toAuthMenu(row as MenuRow);
  }

  async deleteMenu(id: ID): Promise<void> {
    await this.menus.softDelete(id);
  }

  async countChildMenus(id: ID): Promise<number> {
    return this.delegate('menu').count({ where: { parentId: id, deletedAt: null } });
  }

  // ---------- 登录设备 ----------

  async listSessionsByUser(userId: ID, now: Date): Promise<SessionView[]> {
    const rows = (await this.delegate('refreshToken').findMany({
      where: { userId, revokedAt: null, deletedAt: null, expireAt: { gt: now } },
      orderBy: { createdAt: 'asc' },
    })) as Array<{
      id: string;
      userId: string;
      familyId: string;
      loginIp: string | null;
      userAgent: string | null;
      createdAt: Date;
    }>;
    // 一个轮换族即一次登录（一台设备）：族内最新一条的创建时间为最近活跃
    const byFamily = new Map<string, { latest: typeof rows[number]; createdAt: Date }>();
    for (const row of rows) {
      const current = byFamily.get(row.familyId);
      if (!current) byFamily.set(row.familyId, { latest: row, createdAt: row.createdAt });
      else byFamily.set(row.familyId, { latest: row, createdAt: current.createdAt });
    }
    return [...byFamily.values()]
      .map(({ latest, createdAt }) => ({
        id: latest.id,
        userId: latest.userId,
        familyId: latest.familyId,
        device: latest.userAgent,
        ip: latest.loginIp,
        lastSeenAt: latest.createdAt,
        createdAt,
      }))
      .sort((a, b) => b.lastSeenAt.getTime() - a.lastSeenAt.getTime());
  }

  // ---------- 审计详情 ----------

  async findAuditLogById(id: ID): Promise<AuditLogRecord | null> {
    const row = (await this.delegate('auditLog').findUnique({ where: { id } })) as AuditLogRow | null;
    return row ? this.toAuditLog(row) : null;
  }

  // ---------- 字典 ----------

  async listDictCategories(): Promise<DictCategoryView[]> {
    const rows = await this.dictCategories.list(undefined, { createdAt: 'asc' });
    return rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      remark: row.remark,
    }));
  }

  async createDictCategory(input: DictCategoryUpsertInput): Promise<DictCategoryView> {
    if (!input.code || !input.name) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'code 与 name 必填');
    }
    const row = await this.dictCategories.create({
      code: input.code,
      name: input.name,
      remark: input.remark ?? null,
    } as Partial<DictCategoryRow>);
    return { id: row.id, code: row.code, name: row.name, remark: row.remark };
  }

  async updateDictCategory(id: ID, patch: Partial<DictCategoryUpsertInput>): Promise<DictCategoryView> {
    const data: Partial<DictCategoryRow> = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.remark !== undefined) data.remark = patch.remark;
    const row = await this.dictCategories.update(id, data);
    return { id: row.id, code: row.code, name: row.name, remark: row.remark };
  }

  async deleteDictCategory(id: ID): Promise<void> {
    const category = await this.dictCategories.findById(id);
    if (!category) throw new BizError(ErrorCode.NOT_FOUND, '字典分类不存在');
    // 连带软删其下字典项（分类与项之间无外键，须显式清理）
    const items = await this.dictItems.list({ categoryId: id } as Partial<DictItemRow>);
    for (const item of items) await this.releaseDictItem(item);
    // 释放唯一键：软删分类仍占 code 唯一约束，同编码分类将永远无法重建
    await this.dictCategories.update(id, {
      ...(category.code.includes('#deleted-') ? {} : { code: `${category.code}#deleted-${id.slice(0, 8)}` }),
      deletedAt: new Date(),
    } as Partial<DictCategoryRow>);
  }

  async listDictItems(categoryId: ID): Promise<DictItemView[]> {
    const rows = await this.dictItems.list({ categoryId } as Partial<DictItemRow>, { sort: 'asc' });
    return rows.map((row) => this.toDictItem(row));
  }

  async listDictItemsByCode(code: string): Promise<DictItemView[]> {
    const category = await this.dictCategories.findOne({ code } as Partial<DictCategoryRow>);
    if (!category) return [];
    return this.listDictItems(category.id);
  }

  async createDictItem(categoryId: ID, input: DictItemUpsertInput): Promise<DictItemView> {
    if (!input.label || input.value === undefined || input.value === '') {
      throw new BizError(ErrorCode.BAD_REQUEST, 'label 与 value 必填');
    }
    if (input.color !== undefined && input.color !== null && !DICT_COLORS.has(input.color)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `color 仅支持 ${[...DICT_COLORS].filter(Boolean).join(' / ')}`);
    }
    const row = await this.dictItems.create({
      categoryId,
      label: input.label,
      value: String(input.value),
      color: input.color ?? null,
      sort: input.sort ?? 0,
    } as Partial<DictItemRow>);
    return this.toDictItem(row as DictItemRow);
  }

  async updateDictItem(id: ID, patch: Partial<DictItemUpsertInput>): Promise<DictItemView> {
    if (patch.color !== undefined && patch.color !== null && !DICT_COLORS.has(patch.color)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `color 仅支持 ${[...DICT_COLORS].filter(Boolean).join(' / ')}`);
    }
    const data: Partial<DictItemRow> = {};
    if (patch.label !== undefined) data.label = patch.label;
    if (patch.value !== undefined) data.value = String(patch.value);
    if (patch.color !== undefined) data.color = patch.color;
    if (patch.sort !== undefined) data.sort = patch.sort;
    const row = await this.dictItems.update(id, data);
    return this.toDictItem(row as DictItemRow);
  }

  async deleteDictItem(id: ID): Promise<void> {
    const item = await this.dictItems.findById(id);
    if (!item) throw new BizError(ErrorCode.NOT_FOUND, '字典项不存在');
    await this.releaseDictItem(item);
  }

  /**
   * 软删字典项并释放唯一键
   * uk_dict_item_category_value 是 (categoryId, value)：软删行仍在表内，同分类下同 value 将无法重建。
   * value 追加重删后缀释放占用；已释放过的跳过，保证重复调用幂等。
   */
  private async releaseDictItem(item: DictItemRow): Promise<void> {
    await this.dictItems.update(item.id, {
      ...(item.value.includes('#deleted-') ? {} : { value: `${item.value}#deleted-${item.id.slice(0, 8)}` }),
      deletedAt: new Date(),
    } as Partial<DictItemRow>);
  }

  // ---------- 行 → 视图 ----------

  private toRoleDetail(row: RoleRow, permissionCount: number): RoleDetail {
    return {
      id: row.id,
      code: row.code,
      name: row.name,
      remark: row.remark,
      dataScope: row.dataScope as DataScope,
      isSystem: row.isSystem === 1,
      sort: row.sort,
      permissionCount,
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

  private toDictItem(row: DictItemRow): DictItemView {
    const color = row.color;
    return {
      id: row.id,
      categoryId: row.categoryId,
      label: row.label,
      value: row.value,
      color: DICT_COLORS.has(color as DictItemView['color']) ? (color as DictItemView['color']) : null,
      sort: row.sort,
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

  /** 角色编码唯一化：追加 -copy 后缀后仍冲突则追加序号 */
  private async uniqueRoleCode(base: string): Promise<string> {
    const rows = await this.roles.list(undefined, { sort: 'asc' });
    const taken = new Set(rows.map((row) => row.code));
    if (!taken.has(base)) return base;
    let index = 2;
    while (taken.has(`${base}${index}`)) index += 1;
    return `${base}${index}`;
  }
}
