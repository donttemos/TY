/*
 * @file 登录安全加固：失败计数、账号锁定、接口限流
 * @description PRD-003 FR-07 与 TC-AUTH-002：同一「IP + 账号」维度连续失败达阈值（默认 5 次）锁定（默认 15 分钟），
 *   第 5 次返回 3004；登录接口按 IP 固定窗口限流，超限返回 9003（429）。
 *   计数与锁状态存于 AuthCachePort（M4 起落 Redis，多实例一致）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import type { AuthCachePort } from './auth-cache.js';
import { DEFAULT_LOCK_MINUTES, DEFAULT_LOGIN_RATE_LIMIT, DEFAULT_MAX_FAILED } from './constants.js';

const logger = Logger.for('auth.login');

/** 失败计数键前缀 */
const FAIL_PREFIX = 'auth:fail:';
/** 锁定键前缀 */
const LOCK_PREFIX = 'auth:lock:';
/** 限流键前缀 */
const RATE_PREFIX = 'auth:rl:';

/** 锁定状态 */
export interface LockState {
  locked: boolean;
  /** 剩余锁定秒数（未锁定时为 0） */
  retryAfterSeconds: number;
}

/** 失败记录结果 */
export interface FailureOutcome {
  /** 当前累计失败次数 */
  failed: number;
  /** 本次是否触发锁定 */
  locked: boolean;
  /** 锁定秒数（未锁定为 0） */
  lockSeconds: number;
}

/** 登录安全选项 */
export interface LoginSecurityOptions {
  /** 失败阈值 */
  maxFailed?: number;
  /** 锁定时长（分钟） */
  lockMinutes?: number;
  /** 限流窗口与次数 */
  rateLimit?: { windowSeconds: number; max: number };
}

/**
 * 登录安全服务
 */
export class LoginSecurity {
  private readonly maxFailed: number;
  private readonly lockMs: number;
  private readonly rateLimit: { windowSeconds: number; max: number };

  /**
   * @param cache 缓存端口
   * @param options 阈值与限流配置
   */
  constructor(
    private readonly cache: AuthCachePort,
    options: LoginSecurityOptions = {},
  ) {
    this.maxFailed = options.maxFailed ?? DEFAULT_MAX_FAILED;
    this.lockMs = (options.lockMinutes ?? DEFAULT_LOCK_MINUTES) * 60 * 1000;
    this.rateLimit = options.rateLimit ?? DEFAULT_LOGIN_RATE_LIMIT;
  }

  /**
   * 查询锁定状态
   * @param ip 来源 IP
   * @param account 账号（用户名 / 手机号 / 邮箱）
   * @returns 是否锁定与剩余秒数
   */
  async checkLock(ip: string, account: string): Promise<LockState> {
    const lockUntil = await this.cache.get<number>(`${LOCK_PREFIX}${this.key(ip, account)}`);
    if (!lockUntil) return { locked: false, retryAfterSeconds: 0 };
    const remainingMs = lockUntil - Date.now();
    if (remainingMs <= 0) {
      await this.cache.del(`${LOCK_PREFIX}${this.key(ip, account)}`);
      return { locked: false, retryAfterSeconds: 0 };
    }
    return { locked: true, retryAfterSeconds: Math.ceil(remainingMs / 1000) };
  }

  /**
   * 记录一次失败；达阈值即锁定并清空失败计数
   * @param ip 来源 IP
   * @param account 账号
   * @returns 累计失败次数与锁定信息
   */
  async recordFailure(ip: string, account: string): Promise<FailureOutcome> {
    const failKey = `${FAIL_PREFIX}${this.key(ip, account)}`;
    const ttlSeconds = Math.ceil(this.lockMs / 1000);
    const failed = ((await this.cache.get<number>(failKey)) ?? 0) + 1;

    if (failed >= this.maxFailed) {
      const lockUntil = Date.now() + this.lockMs;
      await this.cache.set(`${LOCK_PREFIX}${this.key(ip, account)}`, lockUntil, ttlSeconds);
      await this.cache.del(failKey);
      logger.warn('登录失败达阈值，账号已锁定', { ip, account, failed, lockMinutes: ttlSeconds / 60 });
      return { failed, locked: true, lockSeconds: ttlSeconds };
    }

    await this.cache.set(failKey, failed, ttlSeconds);
    logger.warn('登录失败计数 +1', { ip, account, failed, maxFailed: this.maxFailed });
    return { failed, locked: false, lockSeconds: 0 };
  }

  /**
   * 登录成功后清空失败计数与锁
   * @param ip 来源 IP
   * @param account 账号
   */
  async clear(ip: string, account: string): Promise<void> {
    await this.cache.del(`${FAIL_PREFIX}${this.key(ip, account)}`);
    await this.cache.del(`${LOCK_PREFIX}${this.key(ip, account)}`);
  }

  /**
   * 登录接口限流（固定窗口）
   * @param ip 来源 IP
   * @throws BizError 9003 超限（HTTP 429）
   */
  async assertRateLimit(ip: string): Promise<void> {
    const windowIndex = Math.floor(Date.now() / (this.rateLimit.windowSeconds * 1000));
    const key = `${RATE_PREFIX}${ip}:${windowIndex}`;
    const count = ((await this.cache.get<number>(key)) ?? 0) + 1;
    await this.cache.set(key, count, this.rateLimit.windowSeconds);
    if (count > this.rateLimit.max) {
      logger.warn('登录接口触发限流', { ip, count, windowSeconds: this.rateLimit.windowSeconds });
      throw new BizError(ErrorCode.RATE_LIMITED, `登录过于频繁，请 ${this.rateLimit.windowSeconds} 秒后再试`);
    }
  }

  /** 失败/锁定维度键：IP + 账号 */
  private key(ip: string, account: string): string {
    return `${ip}|${account}`;
  }
}
