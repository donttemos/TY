/*
 * @file OAuth2 授权码端点（E-07：授权码端到端）
 * @description /api/v1/auth/oauth2/*：providers（已注册提供方列表，登录页渲染入口）、
 *   authorize（302 跳转 IdP，redirect_uri 强制白名单 + state 防 CSRF）、callback（state 一次性
 *   消费 → code 换 token → 拉用户信息 → 映射本地账号 → 签发登录会话）。
 *   身份映射约定（应用层职责，框架不做）：本地账号 = IdP 用户信息的 email 优先，
 *   其次 username / preferred_username；不自动建号——外部身份必须先在本地建号并绑定同名字段，
 *   否则 3001（防外部身份自动提权）。
 *   response_mode=json 供冒烟与客户端集成直接拿 TokenPair；缺省 302 回 redirect_uri，
 *   令牌放 URL fragment（#，不进服务器日志与 Referer）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/auth
 */

import { Controller, Get, Inject, Param, Query, Res } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { AUTH_OAUTH2_FLOW, AuthService, OAuth2FlowService, Public, type LoginResult } from '@fw/auth';
import type { Response } from 'express';
import { clientIp, clientUserAgent } from './auth.controller.js';

/** 从 IdP 用户信息提取本地账号（email 优先，其次 username / preferred_username） */
function extractAccount(userInfo: Record<string, unknown>): string {
  for (const field of ['email', 'username', 'preferred_username']) {
    const value = userInfo[field];
    if (typeof value === 'string' && value.trim() !== '') return value.trim();
  }
  return '';
}

/**
 * OAuth2 授权码控制器：/api/v1/auth/oauth2
 */
@Controller('/api/v1/auth/oauth2')
export class OAuth2Controller {
  constructor(
    @Inject(AUTH_OAUTH2_FLOW) private readonly flow: OAuth2FlowService,
    private readonly auth: AuthService,
  ) {}

  /** 已注册提供方列表（公开；前端按非空渲染 OAuth2 登录入口） */
  @Public()
  @Get('providers')
  providers(): { providers: string[] } {
    return { providers: this.flow.listProviders() };
  }

  /**
   * 发起授权：校验回调白名单 → 生成一次性 state → 302 到 IdP 授权端点
   * redirect_uri 由前端按自身 origin 提供（后端不猜测部署形态），
   * 必须前缀命中 AUTH_OAUTH2_REDIRECT_WHITELIST，否则 400/1001。
   */
  @Public()
  @Get(':provider/authorize')
  async authorize(
    @Param('provider') provider: string,
    @Query('redirect_uri') redirectUri: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const url = await this.flow.buildAuthorizeUrl(provider, redirectUri);
    res.redirect(302, url);
  }

  /**
   * 授权回调：state 校验（一次性）→ code 换 token → 用户信息 → 本地账号映射 → 登录会话
   * response_mode=json 返回 TokenPair JSON；缺省 302 回 redirect_uri 并以 fragment 携带令牌。
   */
  @Public()
  @Get(':provider/callback')
  async callback(
    @Param('provider') provider: string,
    @Query('code') code: string | undefined,
    @Query('state') state: string | undefined,
    @Query('response_mode') responseMode: string | undefined,
    @Res({ passthrough: true }) res: Response,
  ): Promise<LoginResult | void> {
    const resolved = await this.flow.resolveCallback(provider, code, state);
    const account = extractAccount(resolved.userInfo);
    if (!account) {
      throw new BizError(ErrorCode.UNAUTHORIZED, 'IdP 用户信息缺少可绑定的账号字段（email / username）');
    }
    const result = await this.auth.loginByOAuth2({
      provider,
      account,
      ip: clientIp(res.req),
      userAgent: clientUserAgent(res.req),
    });
    if (responseMode === 'json') return result;
    // 浏览器流：fragment 携带令牌（# 后内容不进服务器日志与 Referer）
    const fragment = new URLSearchParams({
      access_token: result.accessToken,
      refresh_token: result.refreshToken,
      expires_in: String(result.expiresIn),
    }).toString();
    res.redirect(302, `${resolved.redirectUri}#${fragment}`);
  }
}
