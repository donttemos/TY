/*
 * @file 角色与权限端点（PRD-003 §3.4）
 * @description /api/v1/roles、/api/v1/permissions：
 *   GET  /roles                     需 role:read；支持 sort=<snake_case 字段>:<asc|desc>（白名单解析）
 *   GET  /roles/:id/permissions      需 role:read
 *   PUT  /roles/:id/permissions      需 role:grant —— 全量授权，写入 role_permission 并即时失效相关用户权限缓存
 *   GET  /permissions                需 permission:read（按 module 分组，供后台角色授权页勾选）
 *   GET  /permissions/tree           需 permission:read（M10 E-04：业务域 → 菜单 → 按钮/接口 三层树，
 *                                  供后台选择器类组件消费——权限码选择器 / 授权分组换接此端点，悬空契约收口）
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo GET /roles 接入排序白名单（BUG-15 增量）：parseSortQuery 解析后
 *   透传存储层，未知字段 / 非法方向 / 超上限一律 400，与 users / audit-logs / tenants 同语义
 * @modified 2026-10-15 donttemo M10 E-04：新增 GET /permissions/tree 三层树（api-spec §3.4 悬空契约落地）——
 *   层 1 = 业务域（module），层 2 = 菜单类权限点（type=menu），层 3 = 按钮/接口类权限点（type=button|api）。
 *   module 内无菜单类权限点时按钮/接口直升层 2（不造空层级）。接口层来自权限表 type=api（权限码变更
 *   随部署走——与「权限码唯一权威 packages/auth PERM」一致）
 * @module example-api/auth
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type Sort } from '@fw/db';
import {
  AUTH_STORE,
  Audit,
  AuthService,
  CurrentUser,
  PERM,
  Permissions,
  ROLE,
  type AuthPermission,
  type AuthRole,
  type AuthStore,
} from '@fw/auth';
import { ADMIN_STORE } from '../admin/admin-store.js';
import type { AdminStore, RoleDetail, RoleUpsertInput } from '../admin/admin-store.js';
import { clientIp } from './auth.controller.js';
import type { Request } from 'express';

/** 权限点按 module 分组后的展示结构 */
interface PermissionGroup {
  module: string;
  items: AuthPermission[];
}

/** 权限树节点（M10 E-04）：type = module（层 1）/ menu（层 2）/ button|api（层 3） */
interface PermissionTreeNode {
  /** 节点键（module 名或权限码，同级唯一） */
  key: string;
  /** 展示名（module 用原名；权限点用 name） */
  label: string;
  type: 'module' | AuthPermission['type'];
  /** 权限点 ID（module 层无；授权页勾选提交 permissionIds 直接可用） */
  id?: string;
  /** 该节点下的权限码集合（含子孙——前端扁平化取码无需递归） */
  codes: string[];
  children: PermissionTreeNode[];
}

/** GET /roles 排序白名单（HTTP 参数名 snake_case → RoleDetail 字段名）。
 * 只收视图可见字段：permissionCount 是聚合计算字段、createdAt 不在 RoleDetail 视图内，均不可排序 */
const ROLE_SORT_FIELDS = {
  id: 'id',
  code: 'code',
  name: 'name',
  remark: 'remark',
  data_scope: 'dataScope',
  sort: 'sort',
} as const;

/**
 * 角色与权限控制器：/api/v1
 */
@Controller('/api/v1')
export class RbacController {
  constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
    @Inject(ADMIN_STORE) private readonly admin: AdminStore,
  ) {}

  /** 角色列表（含权限点计数，C-06 契约 §3.4 RoleListItem）；sort 经白名单解析，非法即 400 */
  @Permissions(PERM.ROLE_READ)
  @Get('roles')
  async listRoles(@Query('sort') sort?: string): Promise<RoleDetail[]> {
    const parsedSort = parseSortQuery<RoleDetail>(sort, ROLE_SORT_FIELDS);
    return this.admin.listRoleDetails(parsedSort as Sort<RoleDetail> | undefined);
  }

  /** 某角色已授权的权限点 */
  @Permissions(PERM.ROLE_READ)
  @Get('roles/:id/permissions')
  async rolePermissions(@Param('id') id: string): Promise<{ roleId: string; permissions: AuthPermission[] }> {
    const roles = await this.store.listRoles();
    if (!roles.some((role) => role.id === id)) {
      throw new BizError(ErrorCode.NOT_FOUND, '角色不存在');
    }
    const [grantedIds, all] = await Promise.all([
      this.store.listPermissionIdsByRoleId(id),
      this.store.listPermissions(),
    ]);
    const granted = new Set(grantedIds);
    return { roleId: id, permissions: all.filter((permission) => granted.has(permission.id)) };
  }

  /** 全量授权：写入 role_permission 并即时失效持有该角色用户的权限缓存（TC-AUTH-009） */
  @Permissions(PERM.ROLE_GRANT)
  @Put('roles/:id/permissions')
  async grant(
    @Param('id') id: string,
    @Body() body: { permissionIds?: string[] },
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<unknown> {
    if (!Array.isArray(body?.permissionIds)) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'permissionIds 必填（字符串数组）');
    }
    const roles = await this.store.listRoles();
    const role = roles.find((item) => item.id === id);
    if (!role) throw new BizError(ErrorCode.NOT_FOUND, '角色不存在');
    if (role.code === ROLE.ADMIN) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '内置管理员角色不允许调整权限（保证系统可管理）');
    }
    return this.auth.grantRolePermissions(id, body.permissionIds, operator, clientIp(request));
  }

  /** 权限点列表（按 module 分组，供后台授权页勾选） */
  @Permissions(PERM.PERMISSION_READ)
  @Get('permissions')
  async listPermissions(): Promise<PermissionGroup[]> {
    const all = await this.store.listPermissions();
    const groups = new Map<string, AuthPermission[]>();
    for (const permission of all) {
      const key = permission.module ?? 'other';
      const bucket = groups.get(key) ?? [];
      bucket.push(permission);
      groups.set(key, bucket);
    }
    return [...groups.entries()].map(([module, items]) => ({ module, items }));
  }

  /**
   * 权限树（M10 E-04，api-spec §3.4 悬空契约收口）
   *
   * 形态：业务域（module）→ 权限点（menu 类在前，button/api 类随后）→ 子资源（预留，当前为空）。
   * **实现注记**：权限点与菜单之间无「属于哪个菜单」外键（menus 经 permissionCode 弱关联），
   * 树不伪造「按钮挂在菜单下」的归属层级——按钮/接口与菜单类权限点在业务域内平级、以 type 区分，
   * 契约「菜单 / 按钮 / 接口三层」的字面归属语义待权限点引入归属外键后再收（登记为 E-04 遗留注记）。
   * 每个节点携带 `codes`（含子孙的权限码集合）——前端选择器扁平化取码无需递归。
   */
  @Permissions(PERM.PERMISSION_READ)
  @Get('permissions/tree')
  async permissionTree(): Promise<PermissionTreeNode[]> {
    const all = await this.store.listPermissions();
    const byModule = new Map<string, AuthPermission[]>();
    for (const permission of all) {
      const key = permission.module ?? 'other';
      const bucket = byModule.get(key) ?? [];
      bucket.push(permission);
      byModule.set(key, bucket);
    }
    const typeRank: Record<string, number> = { menu: 0, button: 1, api: 2 };
    return [...byModule.entries()]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([module, items]) => ({
        key: module,
        label: module,
        type: 'module' as const,
        codes: items.map((item) => item.code),
        children: items
          .slice()
          .sort((a, b) => (typeRank[a.type] ?? 3) - (typeRank[b.type] ?? 3) || a.code.localeCompare(b.code))
          .map((item) => ({
            key: item.code,
            label: item.name,
            type: item.type,
            id: item.id,
            codes: [item.code],
            children: [],
          })),
      }));
  }

  /** 新建角色（编码唯一，冲突 409；新角色默认无权限，需再走授权接口） */
  @Permissions(PERM.ROLE_CREATE)
  @Audit({ module: 'role', action: 'create', targetType: 'role' })
  @Post('roles')
  async createRole(
    @Body() body: RoleUpsertInput,
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<RoleDetail> {
    try {
      return await this.admin.createRole(body);
    } catch (error) {
      throw this.conflict(error, '角色编码已存在');
    }
  }

  /**
   * 更新角色资料
   * 约束：code 不可改（code 是权限判定与种子同步的锚点）；内置角色不可改 dataScope
   * （保证内置管理员始终 all，否则改窄即失去系统可管理性）。dataScope 变更后失效相关用户缓存。
   */
  @Permissions(PERM.ROLE_UPDATE)
  @Audit({ module: 'role', action: 'update', targetType: 'role' })
  @Put('roles/:id')
  async updateRole(
    @Param('id') id: string,
    @Body() body: RoleUpsertInput,
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<RoleDetail> {
    if (body.code !== undefined) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '角色编码不可修改（编码是权限判定锚点）');
    }
    const existing = (await this.admin.listRoleDetails()).find((role) => role.id === id);
    if (!existing) throw new BizError(ErrorCode.NOT_FOUND, '角色不存在');
    if (existing.isSystem && body.dataScope !== undefined && body.dataScope !== existing.dataScope) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '内置角色的数据范围不可调整（保证系统可管理性）');
    }
    const updated = await this.admin.updateRole(id, body);
    if (body.dataScope !== undefined && body.dataScope !== existing.dataScope) {
      await this.auth.invalidateUsersOfRole(id);
    }
    return updated;
  }

  /** 删除角色（内置角色拒绝；仍有用户持有时拒绝，先解绑） */
  @Permissions(PERM.ROLE_DELETE)
  @Audit({ module: 'role', action: 'delete', targetType: 'role' })
  @Delete('roles/:id')
  async deleteRole(@Param('id') id: string, @CurrentUser('id') operator: string, @Req() request: Request): Promise<{ id: string }> {
    const existing = (await this.admin.listRoleDetails()).find((role) => role.id === id);
    if (!existing) throw new BizError(ErrorCode.NOT_FOUND, '角色不存在');
    if (existing.isSystem) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '内置角色不可删除');
    }
    const holders = await this.admin.countRoleUsers(id);
    if (holders > 0) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, `仍有 ${holders} 个用户持有该角色，请先解绑`);
    }
    await this.admin.deleteRole(id);
    return { id };
  }

  /** 复制角色（含权限）；新角色编码自动加 `-copy` 后缀并保证唯一 */
  @Permissions(PERM.ROLE_CREATE)
  @Audit({ module: 'role', action: 'create', targetType: 'role' })
  @Post('roles/:id/copy')
  async copyRole(@Param('id') id: string): Promise<RoleDetail> {
    return this.admin.copyRole(id);
  }

  /** 唯一约束冲突转业务 409（其余原样抛出，交由全局异常过滤） */
  private conflict(error: unknown, message: string): unknown {
    if (error && typeof error === 'object' && (error as { code?: string }).code === 'P2002') {
      return new BizError(ErrorCode.CONFLICT, message);
    }
    return error;
  }
}
