/*
 * @file 双 token 签发与校验
 * @description PRD-003 FR-02/NFR：HS256 JWT，access/refresh 分型（typ 声明）、最小化 claims（sub/username/roles）；
 *   验签支持 JWT_SECRET 与 JWT_SECRET_PREV 双密钥轮换（TC-AUTH-014）——先当前密钥，失败回退上一版；
 *   过期（ERR_JWT_EXPIRED）与非法令牌区分错误码：3003 vs 3001。
 *   本服务不落库、不缓存，纯函数式；refresh 的存储与轮换在 RefreshTokenService。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import { randomUUID } from 'node:crypto';
import { SignJWT, errors as joseErrors, jwtVerify, type JWTPayload } from 'jose';
import { JWT_ALG, JWT_ISSUER } from './constants.js';
import type { AuthRole, TokenPair, TokenType } from './types.js';

/** 密钥最小长度（弱密钥告警阈值） */
const MIN_SECRET_LENGTH = 32;

/** access token 载荷 */
export interface AccessClaims extends JWTPayload {
  /** 用户 ID */
  sub: string;
  /** 账号名 */
  username: string;
  /** 角色编码列表（最小化 claims：不含权限码与用户资料） */
  roles: string[];
  /** 令牌类型 */
  typ: 'access';
  /** 令牌唯一标识（黑名单键） */
  jti: string;
  /** 所属 refresh 轮换族 ID：登出时按族精确撤销，避免误伤其它设备 */
  fam?: string;
}

/** refresh token 载荷 */
export interface RefreshClaims extends JWTPayload {
  sub: string;
  typ: 'refresh';
  jti: string;
  /** 轮换族 ID */
  fam: string;
}

/** 验签结果 */
export interface VerifyResult {
  claims: AccessClaims | RefreshClaims;
  /** 是否由 JWT_SECRET_PREV 验签通过（轮换过渡期） */
  usedPrevSecret: boolean;
}

/** TokenService 选项 */
export interface TokenServiceOptions {
  /** 当前签名密钥（JWT_SECRET） */
  secret: string;
  /** 上一版签名密钥（JWT_SECRET_PREV），可选 */
  secretPrev?: string;
  /** access 有效期（秒） */
  accessTtlSeconds: number;
  /** refresh 有效期（秒） */
  refreshTtlSeconds: number;
}

/** 签发结果 */
export interface IssuedToken {
  token: string;
  jti: string;
  /** 有效秒数 */
  expiresIn: number;
  /** 过期时间（秒级时间戳） */
  exp: number;
}

/**
 * 令牌服务：签发与验签
 */
export class TokenService {
  private readonly key: Uint8Array;
  private readonly prevKey?: Uint8Array;

  /**
   * @param options 密钥与有效期
   * @throws Error 密钥缺失或过短
   */
  constructor(private readonly options: TokenServiceOptions) {
    if (!options.secret || options.secret.length < MIN_SECRET_LENGTH) {
      throw new Error(`JWT_SECRET 缺失或长度不足（需 ≥ ${MIN_SECRET_LENGTH} 字符）：请在 .env 配置强随机密钥`);
    }
    if (options.accessTtlSeconds <= 0 || options.refreshTtlSeconds <= 0) {
      throw new Error('token 有效期必须为正数（AUTH_ACCESS_TTL / AUTH_REFRESH_TTL）');
    }
    this.key = new TextEncoder().encode(options.secret);
    if (options.secretPrev) this.prevKey = new TextEncoder().encode(options.secretPrev);
  }

  /** 当前 access 有效期（秒） */
  get accessTtlSeconds(): number {
    return this.options.accessTtlSeconds;
  }

  /** 当前 refresh 有效期（秒） */
  get refreshTtlSeconds(): number {
    return this.options.refreshTtlSeconds;
  }

  /**
   * 签发 access token
   * @param user 用户标识与角色
   * @param familyId 所属 refresh 轮换族 ID（登出按族撤销用）
   * @returns 令牌串、jti 与有效期
   */
  async signAccess(user: { id: string; username: string; roles: string[] }, familyId?: string): Promise<IssuedToken> {
    const jti = randomUUID();
    const exp = Math.floor(Date.now() / 1000) + this.options.accessTtlSeconds;
    const token = await new SignJWT({
      username: user.username,
      roles: user.roles,
      typ: 'access' satisfies TokenType,
      ...(familyId ? { fam: familyId } : {}),
    })
      .setProtectedHeader({ alg: JWT_ALG })
      .setIssuer(JWT_ISSUER)
      .setSubject(user.id)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, jti, expiresIn: this.options.accessTtlSeconds, exp };
  }

  /**
   * 签发 refresh token
   * @param userId 用户 ID
   * @param familyId 轮换族 ID
   * @param jti 令牌标识（由调用方生成，便于与存储记录一一对应）
   * @returns 令牌串、jti 与有效期
   */
  async signRefresh(userId: string, familyId: string, jti: string = randomUUID()): Promise<IssuedToken> {
    const exp = Math.floor(Date.now() / 1000) + this.options.refreshTtlSeconds;
    const token = await new SignJWT({ typ: 'refresh' satisfies TokenType, fam: familyId })
      .setProtectedHeader({ alg: JWT_ALG })
      .setIssuer(JWT_ISSUER)
      .setSubject(userId)
      .setJti(jti)
      .setIssuedAt()
      .setExpirationTime(exp)
      .sign(this.key);
    return { token, jti, expiresIn: this.options.refreshTtlSeconds, exp };
  }

  /**
   * 验签：先当前密钥，失败回退上一版密钥（轮换过渡期）
   * @param token 令牌串
   * @returns 载荷与所用密钥
   * @throws TokenVerifyError 令牌非法或已过期
   */
  async verify(token: string): Promise<VerifyResult> {
    if (!token || typeof token !== 'string') {
      throw new TokenVerifyError('missing', '令牌缺失');
    }
    try {
      const { payload } = await jwtVerify(token, this.key, { algorithms: [JWT_ALG], issuer: JWT_ISSUER });
      return { claims: payload as AccessClaims | RefreshClaims, usedPrevSecret: false };
    } catch (error) {
      if (this.isExpired(error)) throw new TokenVerifyError('expired', '令牌已过期');
      if (this.prevKey) {
        try {
          const { payload } = await jwtVerify(token, this.prevKey, { algorithms: [JWT_ALG], issuer: JWT_ISSUER });
          return { claims: payload as AccessClaims | RefreshClaims, usedPrevSecret: true };
        } catch (prevError) {
          if (this.isExpired(prevError)) throw new TokenVerifyError('expired', '令牌已过期');
          throw new TokenVerifyError('invalid', '令牌无效');
        }
      }
      throw new TokenVerifyError('invalid', '令牌无效');
    }
  }

  /**
   * 组装双 token 响应体（不含 refresh 明文存储）
   * @param user 用户标识与角色
   * @param familyId refresh 族 ID
   */
  async issuePair(
    user: { id: string; username: string; roles: string[] },
    familyId: string,
  ): Promise<{ pair: TokenPair; accessJti: string; accessExp: number; refreshJti: string; refreshExp: number; refreshToken: string }> {
    const access = await this.signAccess(user);
    const refresh = await this.signRefresh(user.id, familyId);
    const pair: TokenPair = {
      tokenType: 'Bearer',
      accessToken: access.token,
      refreshToken: refresh.token,
      expiresIn: access.expiresIn,
    };
    return {
      pair,
      accessJti: access.jti,
      accessExp: access.exp,
      refreshJti: refresh.jti,
      refreshExp: refresh.exp,
      refreshToken: refresh.token,
    };
  }

  /** jose 过期错误判定（跨版本兼容 code 与 name 两种形态） */
  private isExpired(error: unknown): boolean {
    if (error instanceof joseErrors.JWTExpired) return true;
    const code = (error as { code?: string } | undefined)?.code;
    return code === 'ERR_JWT_EXPIRED';
  }
}

/** 令牌校验失败原因 */
export type TokenVerifyReason = 'missing' | 'expired' | 'invalid';

/**
 * 令牌校验异常：携带原因，由守卫映射为 3001 / 3003
 */
export class TokenVerifyError extends Error {
  constructor(
    readonly reason: TokenVerifyReason,
    message: string,
  ) {
    super(message);
    this.name = 'TokenVerifyError';
  }
}
