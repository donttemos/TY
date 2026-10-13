/*
 * @file 认证端点（PRD-003 §3.2）
 * @description /api/v1/auth/*：登录、注册、刷新、登出、当前用户、菜单树、修改密码。
 *   公开路由（login/register/refresh）标 @Public()；其余按 API 规格声明权限码，
 *   权限码与 docs/40-api-spec.md §3.2 权限点列同源。
 *   控制器只做入参校验与转发，业务规则全在 @fw/auth 的 AuthService。
 * @author donttemo
 * @created 2026-10-13
 * @module example-api/auth
 */

import { Body, Controller, Get, Post, Req } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import {
  Audit,
  AuthService,
  CurrentUser,
  PERM,
  Permissions,
  Public,
  type MenuNode,
  type RequestUser,
} from '@fw/auth';
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
  constructor(private readonly auth: AuthService) {}

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
  @Audit({ module: 'auth', action: 'logout', targetType: 'user' })
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

  /** 当前用户可见菜单树（后台动态路由数据源） */
  @Permissions(PERM.AUTH_ME)
  @Get('menus')
  async menus(@CurrentUser('id') userId: string): Promise<MenuNode[]> {
    return this.auth.menus(userId);
  }

  /** 修改密码：成功后其它设备下线，当前设备换新令牌 */
  @Permissions(PERM.AUTH_CHANGE_PASSWORD)
  @Audit({ module: 'auth', action: 'update', targetType: 'user' })
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
}
