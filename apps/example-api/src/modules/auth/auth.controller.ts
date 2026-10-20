/*
 * @file 认证端点（PRD-003 §3.2）
 * @description /api/v1/auth/*：登录、注册、刷新、登出、当前用户、菜单树、修改密码。
 *   公开路由（login/register/refresh）标 @Public()；其余按 API 规格声明权限码，
 *   权限码与 docs/40-api-spec.md §3.2 权限点列同源。
 *   控制器只做入参校验与转发，业务规则全在 @fw/auth 的 AuthService。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 新增 PUT /auth/profile（本人资料自助维护，需 auth:me）：
 *   管理后台「个人中心」原先只能借 PUT /users/:id 保存资料，而该端点需 user:update，
 *   普通角色（仅 auth:me + user:read）改不了自己的资料 → 3002。此处只放开 nickname/phone/email，
 *   username / status / roleIds 一律不收（防自助提权）。
 * @modified 2026-10-14 donttemo 补 AuditService 注入：updateProfile 的 this.audit.record 缺字段，
 *   构造函数没有 audit 依赖，tsc 直接报 TS2339（构建即失败）
 * @module example-api/auth
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import {
  AUTH_STORE,
  AuditService,
  AuthService,
  CurrentUser,
  PERM,
  Permissions,
  Public,
  type AuthStore,
  type AuthUser,
  type MeResult,
  type MenuNode,
  type RequestUser,
} from '@fw/auth';
import { ADMIN_STORE } from '../admin/admin-store.js';
import type { AdminStore, LoginSessionView } from '../admin/admin-store.js';
import type { Request } from 'express';

/** 取客户端 IP（容器内取 x-forwarded-for 首段） */
export function clientIp(request: Request): string {
  const forwarded = request.headers['x-forwarded-for'];
  const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  return (raw ? raw.split(',')[0].trim() : '') || request.ip || 'unknown';
}

/** 取客户端标识 */
export function clientUserAgent(request: Request): string | null {
  const ua = request.headers['user-agent'];
  return typeof ua === 'string' ? ua : null;
}

/**
 * 认证控制器：/api/v1/auth
 */
@Controller('/api/v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    @Inject(AUTH_STORE) private readonly store: AuthStore,
    @Inject(ADMIN_STORE) private readonly admin: AdminStore,
  ) {}

  /** 登录：账号密码 → 双 token（公开；失败计数达阈值锁定） */
  @Public()
  @Post('login')
  async login(@Body() body: { account?: string; password?: string }, @Req() request: Request): Promise<unknown> {
    if (!body?.account || !body?.password) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'account 与 password 必填');
    }
    return this.auth.login({
      account: body.account,
      password: body.password,
      ip: clientIp(request),
      userAgent: clientUserAgent(request),
    });
  }

  /** 注册：受 AUTH_ALLOW_REGISTER 开关控制（公开） */
  @Public()
  @Post('register')
  async register(
    @Body() body: { username?: string; password?: string; phone?: string; email?: string; nickname?: string },
    @Req() request: Request,
  ): Promise<unknown> {
    if (!body?.username || !body?.password) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'username 与 password 必填');
    }
    return this.auth.register({
      username: body.username,
      password: body.password,
      phone: body.phone,
      email: body.email,
      nickname: body.nickname,
      ip: clientIp(request),
      userAgent: clientUserAgent(request),
    });
  }

  /** 刷新：轮换 refresh（公开，需携带 refresh token） */
  @Public()
  @Post('refresh')
  async refresh(@Body() body: { refreshToken?: string }, @Req() request: Request): Promise<unknown> {
    if (!body?.refreshToken) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'refreshToken 必填');
    }
    return this.auth.refreshSession(body.refreshToken, clientIp(request), clientUserAgent(request));
  }

  /** 登出：access 进黑名单 + 撤销当前设备 refresh 族 */
  @Permissions(PERM.AUTH_LOGOUT)
  @Post('logout')
  async logout(@CurrentUser() user: RequestUser, @Req() request: Request): Promise<unknown> {
    return this.auth.logout(user, user.exp, clientIp(request), clientUserAgent(request));
  }

  /** 当前用户资料 + 角色 + 权限码（供前端按钮级权限渲染） */
  @Permissions(PERM.AUTH_ME)
  @Get('me')
  async me(@CurrentUser('id') userId: string): Promise<unknown> {
    return this.auth.me(userId);
  }

  /**
   * 本人资料视图（GET / PUT /auth/profile 共用）
   * /auth/me 只含身份与权限，不含手机 / 邮箱；个人中心回显需要它们，且不该要求 user:read，
   * 故在此补齐（数据取自 AdminStore，与用户管理页同源，避免两处口径漂移）。
   */
  private async profileView(userId: string): Promise<MeResult & { phone: string | null; email: string | null }> {
    const me = (await this.auth.me(userId)) as MeResult;
    const detail = await this.admin.findUserListItemById(userId);
    return { ...me, phone: detail?.phone ?? null, email: detail?.email ?? null };
  }

  /** 本人资料（个人中心回显；需 auth:me，不依赖 user:read） */
  @Permissions(PERM.AUTH_ME)
  @Get('profile')
  async profile(@CurrentUser('id') userId: string): Promise<unknown> {
    return this.profileView(userId);
  }

  /**
   * 更新本人资料（个人中心自助）
   * 白名单：nickname / phone / email。账号名是登录与审计锚点、status 与角色属管理面（PUT /users/:id），
   * 一律不收，避免「自助改状态 / 加角色」的提权路径。
   * phone / email 与其他账号冲突时 409（与建号唯一性策略一致，不指明冲突字段以避免枚举）。
   */
  @Permissions(PERM.AUTH_ME)
  @Put('profile')
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() body: { nickname?: string; phone?: string; email?: string },
    @Req() request: Request,
  ): Promise<unknown> {
    const patch: Partial<AuthUser> = {};
    if (body?.nickname !== undefined) patch.nickname = body.nickname;
    if (body?.phone !== undefined) patch.phone = body.phone;
    if (body?.email !== undefined) patch.email = body.email;
    if (Object.keys(patch).length === 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'nickname / phone / email 至少传一个');
    }

    const before = await this.store.findUserById(userId);
    if (!before) throw new BizError(ErrorCode.NOT_FOUND, '用户不存在');

    for (const candidate of [patch.phone, patch.email]) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      const occupied = await this.store.findUserByAccount(candidate);
      if (occupied && occupied.id !== userId) {
        throw new BizError(ErrorCode.CONFLICT, '手机号或邮箱已被其他账号占用');
      }
    }

    await this.store.updateUser(userId, patch);
    this.audit.recordEvent('auth.profile_update', {
      userId,
      targetType: 'user',
      targetId: userId,
      targetLabel: before.username,
      before: { nickname: before.nickname, phone: before.phone, email: before.email },
      after: { nickname: patch.nickname ?? before.nickname, phone: patch.phone ?? before.phone, email: patch.email ?? before.email },
      ip: clientIp(request),
    });
    // 返回与 GET /auth/profile 同构，前端保存后可直接刷新昵称，少一次往返
    return this.profileView(userId);
  }

  /** 当前用户可见菜单树（后台动态路由数据源） */
  @Permissions(PERM.AUTH_ME)
  @Get('menus')
  async menus(@CurrentUser('id') userId: string): Promise<MenuNode[]> {
    return this.auth.menus(userId);
  }

  /** 修改密码：成功后其它设备下线，当前设备换新令牌 */
  @Permissions(PERM.AUTH_CHANGE_PASSWORD)
  @Post('change-password')
  async changePassword(
    @CurrentUser('id') userId: string,
    @Body() body: { oldPassword?: string; newPassword?: string },
    @Req() request: Request,
  ): Promise<unknown> {
    if (!body?.oldPassword || !body?.newPassword) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'oldPassword 与 newPassword 必填');
    }
    return this.auth.changePassword({
      userId,
      oldPassword: body.oldPassword,
      newPassword: body.newPassword,
      ip: clientIp(request),
      userAgent: clientUserAgent(request),
    });
  }

  /**
   * 当前用户的登录设备列表
   * 语义：一次登录对应一个刷新令牌轮换族（换设备 / 重登即新族），族内多条为正常轮换结果。
   * current：与本次请求同 IP 且同 User-Agent 的会话判为当前设备（供前端禁止踢自己下线）。
   */
  @Permissions(PERM.AUTH_ME)
  @Get('sessions')
  async sessions(@CurrentUser('id') userId: string, @Req() request: Request): Promise<LoginSessionView[]> {
    const sessions = await this.admin.listSessionsByUser(userId, new Date());
    const ip = clientIp(request);
    const agent = clientUserAgent(request);
    return sessions.map((session) => ({
      ...session,
      device: session.device ?? '未知设备',
      current: session.ip === ip && session.device === agent,
    }));
  }

  /** 下线指定设备：先确认该族属于当前用户，再整族撤销（防越权踢他人下线） */
  @Permissions(PERM.AUTH_REVOKE_SESSION)
  @Delete('sessions/:id')
  async revokeSession(
    @CurrentUser('id') userId: string,
    @Param('id') sessionId: string,
    @Req() request: Request,
  ): Promise<{ revoked: string }> {
    const sessions = await this.admin.listSessionsByUser(userId, new Date());
    const target = sessions.find((session) => session.id === sessionId);
    if (!target) {
      throw new BizError(ErrorCode.NOT_FOUND, '登录设备不存在或已下线');
    }
    await this.store.revokeRefreshFamily(target.familyId, new Date());
    // 单设备下线与「撤销全部会话」语义不同，摘要显式覆盖（同一事件码的必要性见 ADR-0032 R1）
    this.audit.recordEvent('auth.session_revoke', {
      userId,
      targetType: 'session',
      targetId: sessionId,
      summary: `下线登录设备「${target.device ?? sessionId}」`,
      after: { familyId: target.familyId, ip: target.ip ?? null, device: target.device ?? null },
      ip: clientIp(request),
    });
    return { revoked: sessionId };
  }
}
