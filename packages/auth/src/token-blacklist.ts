/*
 * @file 令牌黑名单与用户级失效水位
 * @description PRD-003 FR-03：登出/改密/禁用账号后令牌立即失效。
 *   两种失效语义并存：
 *   1) 精确黑名单（jti）——登出时把当前 access 的 jti 拉黑，TTL = 令牌剩余有效期；
 *   2) 用户级水位（用户「不要早于」时间戳）——改密/踢下线时一次性作废该用户在此刻之前签发的全部令牌，
 *      避免遍历所有在线令牌（分布式下不可能）。网关守卫同时校验两者。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import type { AuthCachePort } from './auth-cache.js';

/** 黑名单键前缀 */
export const BLACKLIST_PREFIX = 'auth:bla:';
/** 用户水位键前缀 */
export const CUTOFF_PREFIX = 'auth:cut:';

/**
 * 令牌黑名单（基于 AuthCachePort，M4 起自动切到 Redis）
 */
export class TokenBlacklist {
  /**
   * @param cache 缓存端口（内存或 Redis）
   */
  constructor(private readonly cache: AuthCachePort) {}

  /**
   * 拉黑一个令牌
   * @param jti 令牌唯一标识
   * @param expiresAtEpochSeconds 令牌过期时间（秒级）；已过期则无需入黑名单
   */
  async revoke(jti: string, expiresAtEpochSeconds: number): Promise<void> {
    if (!jti) return;
    const ttl = expiresAtEpochSeconds - Math.floor(Date.now() / 1000);
    if (ttl <= 0) return; // 已过期，无需占位
    await this.cache.set(`${BLACKLIST_PREFIX}${jti}`, true, ttl);
  }

  /**
   * 判断令牌是否已被拉黑
   * @param jti 令牌唯一标识
   */
  async isRevoked(jti: string): Promise<boolean> {
    if (!jti) return false;
    return (await this.cache.get<boolean>(`${BLACKLIST_PREFIX}${jti}`)) === true;
  }

  /**
   * 设置用户失效水位：签发时间早于该水位的令牌一律拒绝
   * @param userId 用户 ID
   * @param epochSeconds 水位（秒级时间戳）
   * @param ttlSeconds 水位保留时长（通常取 access 有效期）
   */
  async setUserCutoff(userId: string, epochSeconds: number, ttlSeconds: number): Promise<void> {
    await this.cache.set(`${CUTOFF_PREFIX}${userId}`, epochSeconds, ttlSeconds);
  }

  /**
   * 读取用户失效水位
   * @param userId 用户 ID
   * @returns 水位时间戳；未设置返回 0
   */
  async getUserCutoff(userId: string): Promise<number> {
    return (await this.cache.get<number>(`${CUTOFF_PREFIX}${userId}`)) ?? 0;
  }

  /**
   * 判断令牌是否早于用户失效水位（改密后旧 access 立即失效）
   * @param userId 用户 ID
   * @param issuedAtEpochSeconds 令牌签发时间
   * @returns true = 已失效
   */
  async isBeforeUserCutoff(userId: string, issuedAtEpochSeconds: number): Promise<boolean> {
    const cutoff = await this.getUserCutoff(userId);
    if (cutoff <= 0) return false;
    return issuedAtEpochSeconds < cutoff;
  }
}
