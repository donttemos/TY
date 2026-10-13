/*
 * @file 刷新令牌轮换与重放检测
 * @description PRD-003 FR-02 与 TC-AUTH-006/007/008：refresh 每次使用即轮换，旧令牌立即失效；
 *   复用已撤销的旧令牌在宽限窗口（默认 10s）内视为并发刷新不报错，超出窗口判定为泄漏——
 *   整个轮换族（family）撤销 + 用户其余刷新令牌作废 + 告警日志。
 *   令牌只存 sha256 哈希，明文仅存在于响应体。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 宽限通道增加「族仍存活」前置校验：整族撤销后旧令牌不得再借窗口换发
 * @module @fw/auth
 */

import { createHash, randomUUID } from 'node:crypto';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import type { AuthStore } from './auth-store.js';
import { DEFAULT_REFRESH_GRACE_SECONDS } from './constants.js';
import type { TokenService } from './token.service.js';
import type { ID, RefreshTokenRecord } from './types.js';

const logger = Logger.for('auth.refresh');

/**
 * 计算令牌哈希（落库前一律哈希，明文不落盘）
 * @param token 令牌明文
 * @returns sha256 十六进制串
 */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** 轮换结果 */
export interface RotationOutcome {
  /** 命中记录所属轮换族 */
  familyId: string;
  /** 记录归属用户 */
  userId: ID;
  /** 是否触发了复用检测（超宽限窗口使用旧令牌） */
  reuseDetected: boolean;
  /** 是否走并发宽限通道 */
  withinGrace: boolean;
}

/**
 * 刷新令牌服务：签发、轮换、族撤销
 */
export class RefreshTokenService {
  /**
   * @param store 鉴权存储
   * @param tokens 令牌服务（签发 refresh）
   * @param graceSeconds 并发宽限窗口（秒）
   */
  constructor(
    private readonly store: AuthStore,
    private readonly tokens: TokenService,
    private readonly graceSeconds: number = DEFAULT_REFRESH_GRACE_SECONDS,
  ) {}

  /**
   * 首次签发：登录 / 注册 / OAuth2 回调后调用
   * @param userId 用户 ID
   * @param ip 登录 IP
   * @param userAgent 客户端标识
   * @returns refresh 明文、族 ID 与过期时间
   */
  async issue(
    userId: ID,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ refreshToken: string; familyId: string; expireAt: Date; jti: string }> {
    const familyId = randomUUID();
    const jti = randomUUID();
    const signed = await this.tokens.signRefresh(userId, familyId, jti);
    await this.store.createRefreshToken({
      userId,
      tokenHash: hashToken(signed.token),
      familyId,
      expireAt: new Date(signed.exp * 1000),
      revokedAt: null,
      loginIp: ip,
      userAgent,
    });
    return { refreshToken: signed.token, familyId, expireAt: new Date(signed.exp * 1000), jti };
  }

  /**
   * 校验并轮换：撤销旧记录，签发同族新 refresh
   * @param refreshToken refresh 明文
   * @param ip 本次请求 IP
   * @param userAgent 本次请求客户端标识
   * @returns 轮换结果与新令牌
   * @throws BizError 3001 令牌无效 / 3003 令牌过期 / 3001 复用泄漏
   */
  async rotate(
    refreshToken: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ outcome: RotationOutcome; refreshToken: string; expireAt: Date; jti: string }> {
    const record = await this.store.findRefreshTokenByHash(hashToken(refreshToken));
    if (!record) throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌无效');

    const now = new Date();
    if (record.expireAt.getTime() <= now.getTime()) {
      throw new BizError(ErrorCode.TOKEN_EXPIRED, '刷新令牌已过期，请重新登录');
    }

    if (record.revokedAt) {
      const ageMs = now.getTime() - record.revokedAt.getTime();
      // 宽限窗口仅适用于「正常轮换产生的瞬时撤销」：必须同时满足
      //   1) 撤销发生在窗口内；2) 族内仍有有效令牌（说明族未被整族撤销）。
      // 只看撤销时间是不够的——泄漏处置 / 登出 / 强制下线都会把 revokedAt 刷成「刚刚」，
      // 若不再校验族存活，攻击者可在窗口内继续用旧令牌换发新令牌，泄漏处置形同虚设。
      const familyAlive = await this.store.hasActiveRefreshTokenInFamily(record.familyId, now);
      if (ageMs <= this.graceSeconds * 1000 && familyAlive) {
        // 宽限窗口：并发刷新（TC-AUTH-008），不判泄漏，仅追加一条同族新令牌
        logger.warn('refresh 并发宽限命中，按并发刷新处理', {
          userId: record.userId,
          familyId: record.familyId,
          ageMs,
        });
        const issued = await this.issueInFamily(record.userId, record.familyId, ip, userAgent);
        return {
          outcome: { familyId: record.familyId, userId: record.userId, reuseDetected: false, withinGrace: true },
          ...issued,
        };
      }
      // 超窗口复用：判定泄漏（TC-AUTH-007）
      const revoked = await this.store.revokeRefreshFamily(record.familyId, now);
      const others = await this.store.revokeUserRefreshTokens(record.userId, now);
      logger.error('检测到 refresh 令牌复用，已终止该用户全部会话', {
        userId: record.userId,
        familyId: record.familyId,
        familyRevoked: revoked,
        userTokensRevoked: others,
        reuseAgeSeconds: Math.floor(ageMs / 1000),
      });
      throw new BizError(ErrorCode.UNAUTHORIZED, '刷新令牌已被使用，疑似泄漏，已终止全部会话，请重新登录');
    }

    // 正常轮换：旧令牌立即失效（TC-AUTH-006）
    await this.store.revokeRefreshToken(record.id, now);
    const issued = await this.issueInFamily(record.userId, record.familyId, ip, userAgent);
    return {
      outcome: { familyId: record.familyId, userId: record.userId, reuseDetected: false, withinGrace: false },
      ...issued,
    };
  }

  /**
   * 撤销一个轮换族（登出单设备）
   * @param familyId 族 ID
   * @returns 受影响条数
   */
  async revokeFamily(familyId: string): Promise<number> {
    return this.store.revokeRefreshFamily(familyId, new Date());
  }

  /**
   * 撤销用户全部刷新令牌（改密 / 强制下线）
   * @param userId 用户 ID
   * @returns 受影响条数
   */
  async revokeAllForUser(userId: ID): Promise<number> {
    return this.store.revokeUserRefreshTokens(userId, new Date());
  }

  /**
   * 清理过期记录（数据字典 §3.9：过期 30 天以上由定时任务清理）
   * @param before 早于该时间的记录将被删除
   * @returns 清理条数
   */
  async cleanup(before: Date): Promise<number> {
    return this.store.purgeExpiredRefreshTokens(before);
  }

  /**
   * 按族签发新 refresh（不改变族归属，保证泄漏能追溯到源头）
   * @param userId 用户 ID
   * @param familyId 族 ID
   * @param ip 请求 IP
   * @param userAgent 客户端标识
   */
  private async issueInFamily(
    userId: ID,
    familyId: string,
    ip: string | null,
    userAgent: string | null,
  ): Promise<{ refreshToken: string; expireAt: Date; jti: string }> {
    const jti = randomUUID();
    const signed = await this.tokens.signRefresh(userId, familyId, jti);
    await this.store.createRefreshToken({
      userId,
      tokenHash: hashToken(signed.token),
      familyId,
      expireAt: new Date(signed.exp * 1000),
      revokedAt: null,
      loginIp: ip,
      userAgent,
    });
    return { refreshToken: signed.token, expireAt: new Date(signed.exp * 1000), jti };
  }

  /**
   * 查询令牌记录（测试与排障用）
   * @param refreshToken 明文
   */
  async find(refreshToken: string): Promise<RefreshTokenRecord | null> {
    return this.store.findRefreshTokenByHash(hashToken(refreshToken));
  }
}
