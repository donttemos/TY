/*
 * @file 角色与权限端点（PRD-003 §3.4）
 * @description /api/v1/roles、/api/v1/permissions：
 *   GET  /roles                     需 role:read
 *   GET  /roles/:id/permissions      需 role:read
 *   PUT  /roles/:id/permissions      需 role:grant —— 全量授权，写入 role_permission 并即时失效相关用户权限缓存
 *   GET  /permissions                需 permission:read（按 module 分组，供后台角色授权页勾选）
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/auth
 */

import { Body, Controller, Get, Inject, Param, Put, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import {
  AUTH_STORE,
  AuthService,
  CurrentUser,
  PERM,
  Permissions,
  ROLE,
  type AuthPermission,
  type AuthRole,
  type AuthStore,
} from '@fw/auth';
import { clientIp } from './auth.controller.js';
import type { Request } from 'express';

/** 权限点按 module 分组后的展示结构 */
interface PermissionGroup {
  module: string;
  items: AuthPermission[];
}

/**
 * 角色与权限控制器：/api/v1
 */
@Controller('/api/v1')
export class RbacController {
  constructor(
    private readonly auth: AuthService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
  ) {}

  /** 角色列表 */
  @Permissions(PERM.ROLE_READ)
  @Get('roles')
  async listRoles(): Promise<AuthRole[]> {
    return this.store.listRoles();
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
}
