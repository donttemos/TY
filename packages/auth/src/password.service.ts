/*
 * @file 口令哈希与密码强度策略
 * @description PRD-003 FR-01/FR-07：默认 Argon2id（OWASP 推荐参数），兼容校验历史 bcrypt 哈希
 *   （`$2a$/$2b$/$2y$` 前缀自动分流）并提供 needsRehash 供登录时静默升级；
 *   密码强度按 low/medium/high 三档校验，永不落明文、永不写日志。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import { hash as argonHash, verify as argonVerify, type Algorithm } from '@node-rs/argon2';
import bcrypt from 'bcryptjs';
import { MASKED } from './constants.js';
import type { PasswordPolicy } from './types.js';

/**
 * Argon2id 算法编号：@node-rs/argon2 的 Algorithm 是 ambient const enum，
 * isolatedModules 下不能按值引用，故用字面量 + 类型断言（0=Argon2d / 1=Argon2i / 2=Argon2id）。
 */
const ALGORITHM_ARGON2ID = 2 as Algorithm;

/** Argon2id 参数（OWASP 2024 推荐：19 MiB / 2 轮 / 单通道） */
export const ARGON2_OPTIONS = {
  algorithm: ALGORITHM_ARGON2ID,
  memoryCost: 19 * 1024,
  timeCost: 2,
  parallelism: 1,
} as const;

/** bcrypt 兼容参数 */
const BCRYPT_ROUNDS = 10;

/** 强度策略约束表 */
const POLICY_RULES: Record<PasswordPolicy, { min: number; requireLetter: boolean; requireDigit: boolean; requireSpecial: boolean }> = {
  low: { min: 6, requireLetter: false, requireDigit: false, requireSpecial: false },
  medium: { min: 8, requireLetter: true, requireDigit: true, requireSpecial: false },
  high: { min: 12, requireLetter: true, requireDigit: true, requireSpecial: true },
};

/** 特殊字符集合（high 档要求） */
const SPECIAL_RE = /[^A-Za-z0-9]/;

/** 密码校验结果 */
export interface PasswordCheck {
  ok: boolean;
  /** 未通过的规则说明（中文，可直接回显给用户） */
  issues: string[];
}

/**
 * 按策略校验密码强度
 * @param plain 明文密码
 * @param policy 策略档位
 * @returns 校验结果（issues 为空表示通过）
 */
export function checkPasswordPolicy(plain: string, policy: PasswordPolicy): PasswordCheck {
  const rule = POLICY_RULES[policy];
  const issues: string[] = [];
  if (typeof plain !== 'string' || plain.length === 0) {
    return { ok: false, issues: ['密码不能为空'] };
  }
  if (plain.length < rule.min) issues.push(`密码长度至少 ${rule.min} 位`);
  if (plain.length > 128) issues.push('密码长度不能超过 128 位');
  if (rule.requireLetter && !/[A-Za-z]/.test(plain)) issues.push('密码需包含字母');
  if (rule.requireDigit && !/\d/.test(plain)) issues.push('密码需包含数字');
  if (rule.requireSpecial && !SPECIAL_RE.test(plain)) issues.push('密码需包含特殊字符');
  return { ok: issues.length === 0, issues };
}

/**
 * 口令哈希与校验服务（无状态，可全局单例）
 */
export class PasswordService {
  /**
   * @param policy 默认强度策略（校验时可覆盖）
   */
  constructor(private readonly policy: PasswordPolicy = 'medium') {}

  /**
   * 生成 Argon2id 哈希
   * @param plain 明文密码
   * @returns 哈希串（`$argon2id$...`）
   */
  async hash(plain: string): Promise<string> {
    return argonHash(plain, ARGON2_OPTIONS);
  }

  /**
   * 校验明文与哈希是否匹配；按哈希前缀自动选择算法（argon2 优先，bcrypt 兼容）
   * @param hash 存储的哈希
   * @param plain 待校验明文
   * @returns 是否匹配；hash 为空或格式非法返回 false（不抛错，避免枚举）
   */
  async verify(hash: string, plain: string): Promise<boolean> {
    if (!hash || typeof hash !== 'string' || typeof plain !== 'string') return false;
    try {
      if (hash.startsWith('$argon2')) return await argonVerify(hash, plain);
      if (/^\$2[aby]\$/.test(hash)) return bcrypt.compareSync(plain, hash);
      return false;
    } catch {
      // 哈希损坏视为不匹配，不向上抛错（避免异常泄露账号状态）
      return false;
    }
  }

  /**
   * 判断哈希是否需要用当前算法与参数重新生成（bcrypt → Argon2id 迁移用）
   * @param hash 存储的哈希
   * @returns true 表示登录成功后可静默重算
   */
  needsRehash(hash: string): boolean {
    if (!hash.startsWith('$argon2id$')) return true;
    // 参数降级检测：内存/轮数低于当前配置即需重算
    return !hash.includes(`m=${ARGON2_OPTIONS.memoryCost},t=${ARGON2_OPTIONS.timeCost},p=${ARGON2_OPTIONS.parallelism}`);
  }

  /**
   * 校验强度并按需返回错误
   * @param plain 明文密码
   * @param policy 覆盖默认策略
   * @returns 校验结果
   */
  check(plain: string, policy: PasswordPolicy = this.policy): PasswordCheck {
    return checkPasswordPolicy(plain, policy);
  }

  /** 脱敏占位（日志安全：任何情况下不要把明文传出去） */
  mask(): string {
    return MASKED;
  }
}
