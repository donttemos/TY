/*
 * @file 认证策略（Passport 语义的可插拔实现）
 * @description PRD-003 FR-06 与 ADR-0005：策略由 AUTH_STRATEGY 与路由元数据选择，
 *   每新增认证方式只需实现 AuthStrategy 并注册，守卫代码不变。
 *   本文件落地 jwt（默认）与 apikey（开放接口）；session 以 SessionStore 端口注入（内网后台可选）；
 *   oauth2 以 provider 注册表形式预留（微信 / 企业微信 / GitHub 由业务侧注册 handler），
 *   未注册时明确拒绝而非静默放行——「不泄漏资源存在性」与「默认拒绝」同时成立。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-07：AuthRequest 增 method/path（apikey 签名参与串接）；
 *   ApiKeyStrategy 可选 HMAC 强制验签（AUTH_API_KEY_SIGN_SECRET 配置后生效，向后兼容）
 * @module @fw/auth
 */

import { createHmac, timingSafeEqual } from 'node:crypto';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import type { ApiKeyEntry, AuthStrategyName, DataScope, ID, TokenType } from './types.js';
import type { TokenBlacklist } from './token-blacklist.js';
import { TokenVerifyError, type AccessClaims, type TokenService } from './token.service.js';
import { DEFAULT_API_KEY_SIGN_SKEW_SECONDS } from './constants.js';

const logger = Logger.for('auth.strategy');

/** 最小请求视图（不绑定 Express 类型，便于单测与多框架复用） */
export interface AuthRequest {
  headers: Record<string, string | string[] | undefined>;
  /** 来源 IP（由平台适配层注入） */
  ip?: string;
  /** 客户端标识 */
  userAgent?: string;
  /** HTTP 方法（E-07 apikey 签名参与串接；由守卫注入） */
  method?: string;
  /** 请求路径（不含查询串；E-07 apikey 签名参与串接，由守卫注入） */
  path?: string;
}

/** 策略身份解析结果 */
export interface StrategyIdentity {
  /** user = 平台用户（需加载权限）；service = 服务账号（权限来自策略自身） */
  kind: 'user' | 'service';
  id: ID;
  username: string;
  via: AuthStrategyName;
  /** 令牌类型（jwt 策略） */
  tokenType?: TokenType;
  /** 令牌唯一标识（jwt 策略，用于黑名单） */
  jti?: string;
  /** 所属 refresh 轮换族 ID（jwt 策略，用于登出精确撤销） */
  fam?: string;
  /** 令牌签发时间（秒级，jwt 策略，用于用户水位校验） */
  issuedAt?: number;
  /** 令牌过期时间（秒级，jwt 策略，用于黑名单 TTL） */
  exp?: number;
  /** 策略已知角色（jwt claims，仅用于日志，权限以 PermissionService 为准） */
  roles?: string[];
  /** 服务账号权限码（apikey / oauth2 客户端） */
  permissions?: string[];
  /** 服务账号数据范围，默认 all */
  dataScope?: DataScope;
}

/** 认证策略接口 */
export interface AuthStrategy {
  /** 策略名 */
  readonly name: AuthStrategyName;
  /**
   * 解析身份
   * @param request 最小请求视图
   * @returns 身份；未携带凭证返回 null；凭证非法抛 BizError(3001/3003)
   */
  authenticate(request: AuthRequest): Promise<StrategyIdentity | null>;
}

/** 从请求头取值（大小写不敏感，兼容数组形态） */
function readHeader(request: AuthRequest, name: string): string | undefined {
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(request.headers)) {
    if (key.toLowerCase() !== target) continue;
    return Array.isArray(value) ? value[0] : value;
  }
  return undefined;
}

/**
 * JWT 策略：`Authorization: Bearer <access token>`
 */
export class JwtStrategy implements AuthStrategy {
  readonly name = 'jwt' as const;

  /**
   * @param tokens 令牌服务
   * @param blacklist 黑名单与用户水位
   */
  constructor(
    private readonly tokens: TokenService,
    private readonly blacklist: TokenBlacklist,
  ) {}

  async authenticate(request: AuthRequest): Promise<StrategyIdentity | null> {
    const header = readHeader(request, 'authorization');
    if (!header) return null;
    const [scheme, token] = header.split(' ');
    if (!token || scheme.toLowerCase() !== 'bearer') {
      throw new BizError(ErrorCode.UNAUTHORIZED, '认证头格式应为 Bearer <token>');
    }

    let claims: AccessClaims;
    try {
      const result = await this.tokens.verify(token);
      claims = result.claims as AccessClaims;
      if (result.usedPrevSecret) {
        logger.warn('令牌由上一版密钥验签通过（轮换过渡期）', { sub: claims.sub, jti: claims.jti });
      }
    } catch (error) {
      if (error instanceof TokenVerifyError && error.reason === 'expired') {
        throw new BizError(ErrorCode.TOKEN_EXPIRED, '令牌已过期');
      }
      throw new BizError(ErrorCode.UNAUTHORIZED, '令牌无效');
    }

    if (claims.typ !== 'access') {
      throw new BizError(ErrorCode.UNAUTHORIZED, '令牌类型不允许用于该接口');
    }
    // 黑名单（登出）与用户水位（改密 / 踢下线）（TC-AUTH-010）
    if (await this.blacklist.isRevoked(claims.jti)) {
      throw new BizError(ErrorCode.UNAUTHORIZED, '令牌已失效，请重新登录');
    }
    const issuedAt = typeof claims.iat === 'number' ? claims.iat : 0;
    if (issuedAt > 0 && (await this.blacklist.isBeforeUserCutoff(claims.sub, issuedAt))) {
      throw new BizError(ErrorCode.UNAUTHORIZED, '凭证已失效，请重新登录');
    }

    return {
      kind: 'user',
      id: claims.sub,
      username: typeof claims.username === 'string' ? claims.username : claims.sub,
      via: 'jwt',
      tokenType: 'access',
      jti: claims.jti,
      fam: typeof claims.fam === 'string' ? claims.fam : undefined,
      issuedAt,
      exp: typeof claims.exp === 'number' ? claims.exp : undefined,
      roles: Array.isArray(claims.roles) ? claims.roles : [],
    };
  }
}

/**
 * API Key 策略：`X-Api-Key: <key>`（开放接口，不走登录流程）
 *
 * E-07 签名模式：配置签名密钥后强制验签（防密钥被中间人截获后重放）——
 *   stringToSign = `${key}\n${timestamp}\n${METHOD}\n${path}`
 *   X-Api-Sign   = HMAC-SHA256(secret, stringToSign) 的 hex 小写
 * `X-Api-Timestamp` 与服务器时差超过 `signSkewSeconds`（默认 300s）即拒绝；
 * 未配置签名密钥时保持原行为（仅验 key，向后兼容）。
 */
export class ApiKeyStrategy implements AuthStrategy {
  readonly name = 'apikey' as const;

  /**
   * @param entries 已解析的 API Key 表
   * @param options 签名选项：signSecret 配置后强制验签；signSkewSeconds 时间戳允许偏差
   */
  constructor(
    private readonly entries: ApiKeyEntry[],
    private readonly options: { signSecret?: string; signSkewSeconds?: number } = {},
  ) {}

  async authenticate(request: AuthRequest): Promise<StrategyIdentity | null> {
    const provided = readHeader(request, 'x-api-key');
    if (!provided) return null;
    const matched = this.entries.find((entry) => safeEqual(entry.key, provided));
    if (!matched) {
      logger.warn('API Key 校验失败', { ip: request.ip });
      throw new BizError(ErrorCode.UNAUTHORIZED, 'API Key 无效');
    }
    if (this.options.signSecret) this.assertSignature(matched.key, request);
    return {
      kind: 'service',
      id: `apikey:${matched.subject}`,
      username: matched.subject,
      via: 'apikey',
      // 空 scope 表示「未授权任何权限码」：默认拒绝，避免配置疏漏导致全量放行
      permissions: matched.scopes,
      dataScope: 'all',
    };
  }

  /** 签名校验（E-07）：时间戳防重放 + HMAC 常量时间比对；失败一律 3001，不区分具体原因防探测 */
  private assertSignature(key: string, request: AuthRequest): void {
    const timestamp = readHeader(request, 'x-api-timestamp');
    const sign = readHeader(request, 'x-api-sign');
    const method = (request.method ?? '').toUpperCase();
    const path = request.path ?? '';
    if (!timestamp || !sign || !method || !path) {
      throw new BizError(ErrorCode.UNAUTHORIZED, '缺少签名头（X-Api-Timestamp / X-Api-Sign）或请求上下文不完整');
    }
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) {
      throw new BizError(ErrorCode.UNAUTHORIZED, 'X-Api-Timestamp 非法');
    }
    const skew = this.options.signSkewSeconds ?? DEFAULT_API_KEY_SIGN_SKEW_SECONDS;
    if (Math.abs(Date.now() / 1000 - ts) > skew) {
      logger.warn('API Key 签名时间戳超出允许偏差', { ip: request.ip, skew });
      throw new BizError(ErrorCode.UNAUTHORIZED, '签名已过期，请校准时间后重试');
    }
    const expected = apiKeySignature(this.options.signSecret as string, key, timestamp, method, path);
    if (!safeEqual(expected, sign)) {
      logger.warn('API Key 签名校验失败', { ip: request.ip, path });
      throw new BizError(ErrorCode.UNAUTHORIZED, 'API Key 签名无效');
    }
  }
}

/**
 * 计算 API Key 请求签名（E-07 约定，docs/41）：HMAC-SHA256(secret, `${key}\n${timestamp}\n${METHOD}\n${path}`) hex 小写。
 * 独立导出供业务方 / 冒烟脚本按同一算法生成签名，避免约定漂移。
 */
export function apiKeySignature(secret: string, key: string, timestamp: string, method: string, path: string): string {
  return createHmac('sha256', secret).update(`${key}\n${timestamp}\n${method.toUpperCase()}\n${path}`).digest('hex');
}

/** 会话存储端口（内网后台可选：由业务侧提供 Redis / DB 实现） */
export interface SessionStore {
  /** 按会话 ID 取用户 ID，未命中返回 null */
  resolve(sessionId: string): Promise<ID | null>;
}

/**
 * Session 策略：`Cookie: fw_sid=<sessionId>`（未注入 SessionStore 时该策略不可用）
 */
export class SessionStrategy implements AuthStrategy {
  readonly name = 'session' as const;

  /** Cookie 名 */
  static readonly COOKIE_NAME = 'fw_sid';

  /**
   * @param store 会话存储（可选）
   */
  constructor(private readonly store?: SessionStore) {}

  async authenticate(request: AuthRequest): Promise<StrategyIdentity | null> {
    const sid = parseCookie(readHeader(request, 'cookie'), SessionStrategy.COOKIE_NAME);
    if (!sid) return null;
    if (!this.store) {
      throw new BizError(ErrorCode.UNAUTHORIZED, 'Session 策略未启用：请注入 SessionStore 或改用 jwt 策略');
    }
    const userId = await this.store.resolve(sid);
    if (!userId) throw new BizError(ErrorCode.UNAUTHORIZED, '会话不存在或已过期');
    return { kind: 'user', id: userId, username: userId, via: 'session' };
  }
}

/** OAuth2 授权码交换上下文 */
export interface OAuth2Context extends AuthRequest {
  /** 提供方名：wechat / wecom / github */
  provider: string;
  /** 授权码或回调参数 */
  code: string;
  /** 回调地址 */
  redirectUri?: string;
}

/** OAuth2 provider handler：由业务侧实现（换取用户信息后返回身份或本地用户 ID） */
export type OAuth2Handler = (
  context: OAuth2Context,
) => Promise<{ kind: 'user' | 'service'; id: ID; username: string; permissions?: string[] }>;

/**
 * OAuth2 策略：provider 注册表（微信 / 企业微信 / GitHub）
 * 未注册的 provider 明确报错，不静默放行。
 */
export class OAuth2Strategy implements AuthStrategy {
  readonly name = 'oauth2' as const;
  private readonly handlers = new Map<string, OAuth2Handler>();

  /** 已注册的提供方 */
  providers(): string[] {
    return [...this.handlers.keys()];
  }

  /**
   * 注册提供方处理器
   * @param provider 提供方名
   * @param handler 处理器
   */
  registerProvider(provider: string, handler: OAuth2Handler): void {
    this.handlers.set(provider, handler);
    logger.info('已注册 OAuth2 提供方', { provider });
  }

  /**
   * 通过 context.provider 分发到具体处理器
   * @param request 请求（需携带 provider / code）
   */
  async authenticate(request: AuthRequest): Promise<StrategyIdentity | null> {
    const context = request as OAuth2Context;
    if (!context.provider || !context.code) return null;
    const handler = this.handlers.get(context.provider);
    if (!handler) {
      throw new BizError(ErrorCode.UNAUTHORIZED, `OAuth2 提供方未注册：${context.provider}`);
    }
    const resolved = await handler(context);
    return {
      kind: resolved.kind,
      id: resolved.id,
      username: resolved.username,
      via: 'oauth2',
      permissions: resolved.permissions,
      dataScope: 'self',
    };
  }
}

/**
 * 策略注册表：按名取用；未注册名 → 明确报错
 */
export class StrategyRegistry {
  private readonly strategies = new Map<AuthStrategyName, AuthStrategy>();

  /**
   * @param strategies 初始策略集合
   */
  constructor(strategies: AuthStrategy[] = []) {
    for (const strategy of strategies) this.register(strategy);
  }

  /**
   * 注册（同名覆盖，便于业务替换实现）
   * @param strategy 策略实例
   */
  register(strategy: AuthStrategy): void {
    this.strategies.set(strategy.name, strategy);
  }

  /** 已注册策略名 */
  names(): AuthStrategyName[] {
    return [...this.strategies.keys()];
  }

  /**
   * 取策略
   * @param name 策略名
   * @throws BizError 3001 策略未注册
   */
  get(name: AuthStrategyName): AuthStrategy {
    const strategy = this.strategies.get(name);
    if (!strategy) throw new BizError(ErrorCode.UNAUTHORIZED, `认证策略未注册：${name}`);
    return strategy;
  }
}

/** 常量时间字符串比较（防时序侧信道） */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return timingSafeEqual(bufA, bufB);
}

/** 解析 Cookie 头中的指定键 */
function parseCookie(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name && rest.length > 0) return rest.join('=');
  }
  return undefined;
}

/**
 * 解析 AUTH_API_KEYS 配置：`key:主体名[:权限码|权限码]`，多条目英文逗号分隔
 *   权限码本身含冒号（`资源:操作`），因此按『前两段为 key/subject、其余拼回 scope 串』切分。
 * @param raw 原始配置串
 * @returns 条目列表（格式非法的条目跳过并告警）
 */
export function parseApiKeys(raw: string | undefined): ApiKeyEntry[] {
  if (!raw || raw.trim() === '') return [];
  const entries: ApiKeyEntry[] = [];
  for (const item of raw.split(',')) {
    const trimmed = item.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(':');
    const key = parts[0];
    const subject = parts[1];
    const scopesRaw = parts.slice(2).join(':');
    if (!key || !subject) {
      logger.warn('AUTH_API_KEYS 条目格式非法，已跳过', { reason: '缺少 key 或主体名（不打印密钥内容）' });
      continue;
    }
    entries.push({
      key,
      subject,
      scopes: scopesRaw
        ? scopesRaw
            .split(/[|;]/)
            .map((scope) => scope.trim())
            .filter(Boolean)
        : [],
    });
  }
  return entries;
}
