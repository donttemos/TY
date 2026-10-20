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
 * @modified 2026-10-14 donttemo POST /users 建号带角色改走 AuthService.assignUserRoles
 *   （原先直调 store.replaceUserRoles，绕过写库前校验）；PUT /users/:id 的角色校验
 *   **前置**到 updateUser 之前 —— 原先校验发生在资料已落库之后，非法角色会留下
 *   「资料已改、角色未改」的部分更新（客户端收到 400 却已生效）
 * @modified 2026-10-14 donttemo BUG-15：GET /users 支持 `sort=<snake_case 字段>:<asc|desc>`（api-spec §1.5），
 *   经 @fw/db 的 parseSortQuery 按 USER_SORT_FIELDS 白名单解析后透传存储层；未知字段 / 非法方向 / 超上限一律 400
 * @module example-api/auth
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { parseSortQuery, type PageResult } from '@fw/db';
import {
  AUTH_STORE,
  AuthService,
  AuditService,
  CurrentUser,
  DATA_SCOPE_ORG,
  MASKED,
  PERM,
  PasswordService,
  Permissions,
  ROLE,
  assertWithinDataScope,
  checkPasswordPolicy,
  resolveDataScopeFilter,
  type AuthStore,
  type AuthUser,
  type DataScopeOrgPort,
  type RequestUser,
  type UserListItem,
} from '@fw/auth';
import { ADMIN_STORE } from '../admin/admin-store.js';
import type { AdminStore } from '../admin/admin-store.js';
import { clientIp } from './auth.controller.js';
import type { Request } from 'express';

/** 新建 / 更新用户入参（C-06 契约 §3.3 UserUpsertInput） */
interface UserUpsertBody {
  username?: string;
  password?: string;
  nickname?: string;
  phone?: string;
  email?: string;
  status?: number;
  roleIds?: string[];
}

/** 一次性密码字符集（去除易混淆字符 0/O/1/l/I） */
const ONE_TIME_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const ONE_TIME_SPECIALS = '@#$%&*!';

/** 生成满足密码策略（medium 档：≥8 位含字母数字特殊字符）的一次性密码 */
function generateOneTimePassword(): string {
  const pick = (from: string): string => from[Math.floor(Math.random() * from.length)];
  const body = Array.from({ length: 10 }, () => pick(ONE_TIME_ALPHABET)).join('');
  return `${pick(ONE_TIME_ALPHABET)}${body}${pick('23456789')}${pick(ONE_TIME_SPECIALS)}`;
}

/**
 * 用户列表可排序字段白名单（api-spec §1.5，BUG-15）
 *
 * 键为 HTTP 参数名（snake_case），值为实体字段名。白名单外字段一律 400 ——
 * 既避免把任意 query 参数拼进 orderBy，也避免通过排序推断未暴露字段。
 */
const USER_SORT_FIELDS = {
  id: 'id',
  username: 'username',
  nickname: 'nickname',
  status: 'status',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
  last_login_at: 'lastLoginAt',
} as const;

/**
 * 用户控制器：/api/v1/users
 */
@Controller('/api/v1/users')
export class UsersController {
  /** 密码哈希与策略校验（无状态服务，控制器内直接实例） */
  private readonly passwords = new PasswordService('medium');

  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
    @Inject(DATA_SCOPE_ORG) private readonly org: DataScopeOrgPort,
    @Inject(ADMIN_STORE) private readonly admin: AdminStore,
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
    @Query('sort') sort?: string,
  ): Promise<PageResult<UserListItem>> {
    const scope = await resolveDataScopeFilter(user, this.org);
    const parsedSize = Number(pageSize);
    // 排序解析放在数据范围解析之后、查询之前：非法 sort（未知字段 / 非法方向 / 超上限）直接 400（BUG-15）
    const parsedSort = parseSortQuery<UserListItem>(sort, USER_SORT_FIELDS);

    if (scope.selfOnly) {
      // self 档只返回本人一条；经 AdminStore 取列表项以保证 roleIds / createdAt 与全量列表同构
      const me = await this.admin.findUserListItemById(scope.ownerId ?? user.id);
      const items: UserListItem[] = me ? [me] : [];
      return { items, total: items.length, page: 1, pageSize: parsedSize, hasMore: false };
    }

    return this.store.pageUsers({
      page: Number(page),
      pageSize: parsedSize,
      keyword,
      status: status === undefined ? undefined : Number(status),
      roleId,
      sort: parsedSort,
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

    this.audit.recordEvent('user.status_change', {
      userId: operator,
      targetType: 'user',
      targetId: id,
      targetLabel: before.username,
      before: { status: before.status },
      after: { status: updated.status, forcedLogout: revoked !== null },
      ip: clientIp(request),
    });
    return { id, status: updated.status, forcedLogout: revoked !== null };
  }

  /**
   * 用户详情（含角色 ID）
   * 详情越权校验先于存在性查询：范围外目标一律 3002，不泄露存在性（fail-closed）。
   */
  @Permissions(PERM.USER_READ)
  @Get(':id')
  async detail(@Param('id') id: string, @CurrentUser() user: RequestUser): Promise<UserListItem> {
    await assertWithinDataScope(user, id, this.org);
    const found = await this.admin.findUserListItemById(id);
    if (!found) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');
    return found;
  }

  /** 新建用户（密码走后端强校验，不信任前端强度判断；账号唯一冲突 409） */
  @Permissions(PERM.USER_CREATE)
  @Post()
  async create(
    @Body() body: UserUpsertBody,
    @CurrentUser('id') operator: string,
    @Req() request: Request,
  ): Promise<UserListItem> {
    if (!body?.username) throw new BizError(ErrorCode.BAD_REQUEST, 'username 必填');
    if (!body?.password) throw new BizError(ErrorCode.BAD_REQUEST, 'password 必填');
    const policy = checkPasswordPolicy(body.password, 'medium');
    if (!policy.ok) throw new BizError(ErrorCode.BAD_REQUEST, `密码不合规：${policy.issues.join('；')}`);
    if (body.roleIds !== undefined && !Array.isArray(body.roleIds)) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'roleIds 必须为字符串数组');
    }
    // 账号唯一性：username / phone / email 任一被占用即 409（不指明具体字段，避免枚举）
    for (const candidate of [body.username, body.phone, body.email]) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      if (await this.store.findUserByAccount(candidate)) {
        throw new BizError(ErrorCode.CONFLICT, '账号已被占用');
      }
    }

    const created = await this.store.createUser({
      username: body.username,
      passwordHash: await this.passwords.hash(body.password),
      phone: body.phone,
      email: body.email,
      nickname: body.nickname,
    });
    // 建号即带角色同样要过校验：replaceUserRoles 先删后建，空串/失效 ID 会静默写库
    if (body.roleIds?.length) await this.auth.assertRoleIds(body.roleIds);
    if (body.roleIds?.length) await this.store.replaceUserRoles(created.id, body.roleIds);

    this.audit.recordEvent('user.create', {
      userId: operator,
      targetType: 'user',
      targetId: created.id,
      targetLabel: created.username,
      after: { username: created.username, roleIds: body.roleIds ?? [] },
      ip: clientIp(request),
    });

    const item = await this.admin.findUserListItemById(created.id);
    if (!item) throw new BizError(ErrorCode.INTERNAL, '用户创建成功但读取失败');
    return item;
  }

  /**
   * 更新用户资料
   * 约束：username 不可改（账号是登录与审计锚点）；禁用（status=0）同时强制下线，与 setStatus 同语义。
   */
  @Permissions(PERM.USER_UPDATE)
  @Put(':id')
  async update(
    @Param('id') id: string,
    @Body() body: UserUpsertBody,
    @CurrentUser('id') operator: string,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<UserListItem> {
    if (body.username !== undefined) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '账号不可修改（账号是登录与审计锚点）');
    }
    if (body.status !== undefined && body.status !== 0 && body.status !== 1) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'status 只能为 0（禁用）或 1（启用）');
    }
    if (body.roleIds !== undefined && !Array.isArray(body.roleIds)) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'roleIds 必须为字符串数组');
    }
    await assertWithinDataScope(user, id, this.org);
    const before = await this.admin.findUserListItemById(id);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');

    // 角色校验**前置**：assignUserRoles 内部虽也校验，但那时 patch 已落库 →
    // 校验失败会留下「资料已改、角色未改」的部分更新（客户端收到 400 却已生效）。
    // 这里先校验一次（幂等、无副作用），保证任一入参非法即整体不写。
    if (body.roleIds !== undefined) await this.auth.assertRoleIds(body.roleIds);

    const patch: Partial<AuthUser> = {};
    if (body.nickname !== undefined) patch.nickname = body.nickname;
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.email !== undefined) patch.email = body.email;
    if (body.status !== undefined) patch.status = body.status;
    await this.store.updateUser(id, patch);

    // 角色走 assignUserRoles：除写关联外还按 user 标签失效权限缓存（接口权限即时生效）
    if (body.roleIds !== undefined) {
      await this.auth.assignUserRoles(id, body.roleIds, operator, clientIp(request));
    }
    const revoked = patch.status === 0 ? await this.auth.revokeUserSessions(id, clientIp(request), operator) : null;

    this.audit.recordEvent('user.update', {
      userId: operator,
      targetType: 'user',
      targetId: id,
      targetLabel: before.username,
      before: { nickname: before.nickname, status: before.status, roleIds: before.roleIds },
      after: { nickname: body.nickname ?? before.nickname, status: patch.status ?? before.status, roleIds: body.roleIds ?? before.roleIds, forcedLogout: revoked !== null },
      ip: clientIp(request),
    });

    const item = await this.admin.findUserListItemById(id);
    if (!item) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');
    return item;
  }

  /** 软删除用户（内置管理员拒绝；不可删当前登录账号；删除同时强制下线） */
  @Permissions(PERM.USER_DELETE)
  @Delete(':id')
  async remove(
    @Param('id') id: string,
    @CurrentUser('id') operator: string,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<{ id: string }> {
    if (id === operator) throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '不能删除当前登录账号');
    await assertWithinDataScope(user, id, this.org);
    const target = await this.admin.findUserListItemById(id);
    if (!target) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');
    const roles = await this.store.listRolesByUserId(id);
    if (roles.some((role) => role.code === ROLE.ADMIN)) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, '内置管理员账号不可删除（保证系统可管理性）');
    }

    await this.admin.softDeleteUser(id);
    const revoked = await this.auth.revokeUserSessions(id, clientIp(request), operator);
    this.audit.recordEvent('user.delete', {
      userId: operator,
      targetType: 'user',
      targetId: id,
      targetLabel: target.username,
      before: { username: target.username, status: target.status },
      after: { deleted: true, forcedLogout: revoked.revokedRefreshTokens > 0 },
      ip: clientIp(request),
    });
    return { id };
  }

  /**
   * 重置密码：生成一次性密码并返回（前端据此强制引导改密）
   * 重置即失效该用户全部登录态——旧会话必须全部掉线，否则旧令牌仍可用。
   */
  @Permissions(PERM.USER_RESET_PASSWORD)
  @Post(':id/reset-password')
  async resetPassword(
    @Param('id') id: string,
    @CurrentUser('id') operator: string,
    @CurrentUser() user: RequestUser,
    @Req() request: Request,
  ): Promise<{ id: string; oneTimePassword: string }> {
    await assertWithinDataScope(user, id, this.org);
    const target = await this.admin.findUserListItemById(id);
    if (!target) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');

    const oneTimePassword = generateOneTimePassword();
    await this.store.updateUser(id, { passwordHash: await this.passwords.hash(oneTimePassword) });
    await this.auth.revokeUserSessions(id, clientIp(request), operator);

    this.audit.record({
      userId: operator,
      module: 'user',
      action: 'update',
      targetType: 'user',
      targetId: id,
      before: { passwordHash: MASKED },
      after: { passwordHash: MASKED, reset: true },
      ip: clientIp(request),
    });
    return { id, oneTimePassword };
  }
}
