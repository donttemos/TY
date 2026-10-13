/*
 * @file 用户管理端点（PRD-003 §3.3，M3 实现到「越权与数据权限可验证」的深度）
 * @description /api/v1/users：
 *   GET  /users           需 user:read —— 演示 TC-AUTH-004（越权 3002）与 TC-AUTH-013（dataScope=self 仅本人）；
 *                          M8 T-M8-04 起四档全量生效（all / org_below / org / self，TC-TNT-004）
 *   PUT  /users/:id/roles 需 user:assign-role —— 演示 TC-AUTH-009（角色变更后权限缓存即时失效）
 *   PUT  /users/:id/status 需 user:update —— 演示 TC-AUTH-011（显式记录变更前后值，敏感字段脱敏）
 *   业务规则集中在 @fw/auth 的 AuthService / PermissionService，控制器只做参数解析与编排。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo M8 T-M8-04：列表改走 resolveDataScopeFilter（四档）；
 *   setStatus / assignRoles 增加 assertWithinDataScope 详情越权校验（范围外 3002）
 * @module example-api/auth
 */

import { Body, Controller, Get, Inject, Param, Put, Query, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import type { PageResult } from '@fw/db';
import {
  AUTH_STORE,
  AuthService,
  AuditService,
  CurrentUser,
  DATA_SCOPE_ORG,
  PERM,
  Permissions,
  assertWithinDataScope,
  resolveDataScopeFilter,
  type AuthStore,
  type DataScopeOrgPort,
  type RequestUser,
  type UserListItem,
} from '@fw/auth';
import { clientIp } from './auth.controller.js';
import type { Request } from 'express';

/**
 * 用户控制器：/api/v1/users
 */
@Controller('/api/v1/users')
export class UsersController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
    @Inject(DATA_SCOPE_ORG) private readonly org: DataScopeOrgPort,
  ) {}

  /**
   * 用户分页列表
   * dataScope 四档（M8 T-M8-04 / TC-TNT-004）：all=全部；org=本人部门；org_below=部门及下级；self=仅本人。
   * 部门集合由数据范围解析注入，**不接受客户端传参**（防越权放宽）。
   */
  @Permissions(PERM.USER_READ)
  @Get()
  async list(
    @CurrentUser() user: RequestUser,
    @Query('page') page = '1',
    @Query('pageSize') pageSize = '20',
    @Query('keyword') keyword?: string,
    @Query('status') status?: string,
    @Query('role_id') roleId?: string,
  ): Promise<PageResult<UserListItem>> {
    const scope = await resolveDataScopeFilter(user, this.org);
    const parsedSize = Number(pageSize);

    if (scope.selfOnly) {
      const me = await this.store.findUserById(scope.ownerId ?? user.id);
      const items: UserListItem[] = me
        ? [
            {
              id: me.id,
              username: me.username,
              phone: me.phone,
              email: me.email,
              nickname: me.nickname,
              avatar: me.avatar,
              status: me.status,
              lastLoginAt: me.lastLoginAt,
              lastLoginIp: me.lastLoginIp,
            },
          ]
        : [];
      return { items, total: items.length, page: 1, pageSize: parsedSize, hasMore: false };
    }

    return this.store.pageUsers({
      page: Number(page),
      pageSize: parsedSize,
      keyword,
      status: status === undefined ? undefined : Number(status),
      roleId,
      // org / org_below：按可见部门集合收敛；all 档不带条件
      ...(scope.departmentIds ? { departmentIds: scope.departmentIds } : {}),
    });
  }

  /** 分配角色（全量覆盖）——变更后按 user 标签失效权限缓存，接口权限即时生效 */
  @Permissions(PERM.USER_ASSIGN_ROLE)
  @Put(':id/roles')
  async assignRoles(
    @Param('id') id: string,
    @Body() body: { roleIds?: string[] },
    @CurrentUser('id') operator: string,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<unknown> {
    if (!Array.isArray(body?.roleIds)) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'roleIds 必填（字符串数组）');
    }
    // 详情越权校验：目标用户不在操作人数据范围内 → 3002（PRD-008 FR-04）
    await assertWithinDataScope(user, id, this.org);
    return this.auth.assignUserRoles(id, body.roleIds, operator, clientIp(request));
  }

  /** 启用 / 禁用账号：显式记录变更前后值（TC-AUTH-011）；禁用同时强制下线 */
  @Permissions(PERM.USER_UPDATE)
  @Put(':id/status')
  async setStatus(
    @Param('id') id: string,
    @Body() body: { status?: number },
    @CurrentUser('id') operator: string,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<unknown> {
    if (body?.status !== 0 && body?.status !== 1) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'status 只能为 0（禁用）或 1（启用）');
    }
    // 详情越权校验：先于存在性查询，范围外目标一律 3002（不泄露存在性，fail-closed）
    await assertWithinDataScope(user, id, this.org);
    const before = await this.store.findUserById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');

    const updated = await this.store.updateUser(id, { status: body.status });
    const revoked = body.status === 0 ? await this.auth.revokeUserSessions(id, clientIp(request), operator) : null;

    this.audit.record({
      userId: operator,
      module: 'user',
      action: 'update',
      targetType: 'user',
      targetId: id,
      before: { status: before.status },
      after: { status: updated.status, forcedLogout: revoked !== null },
      ip: clientIp(request),
    });
    return { id, status: updated.status, forcedLogout: revoked !== null };
  }
}
