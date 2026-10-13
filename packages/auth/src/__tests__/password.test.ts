/*
 * @file 口令哈希与强度策略单测
 * @description 覆盖 Argon2id 哈希/校验、bcrypt 兼容校验与 needsRehash、损坏哈希的安全降级、三档强度策略
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import bcrypt from 'bcryptjs';
import { describe, expect, it } from 'vitest';
import { PasswordService, checkPasswordPolicy } from '../password.service.js';

describe('PasswordService', () => {
  const service = new PasswordService('medium');

  it('Argon2id 哈希可校验且哈希不含明文', async () => {
    const hash = await service.hash('Secret@12345');
    expect(hash.startsWith('$argon2id$')).toBe(true);
    expect(hash).not.toContain('Secret@12345');
    await expect(service.verify(hash, 'Secret@12345')).resolves.toBe(true);
    await expect(service.verify(hash, 'Secret@12346')).resolves.toBe(false);
  });

  it('兼容校验历史 bcrypt 哈希，且 needsRehash 提示升级', async () => {
    const legacy = bcrypt.hashSync('Legacy@12345', 8);
    await expect(service.verify(legacy, 'Legacy@12345')).resolves.toBe(true);
    expect(service.needsRehash(legacy)).toBe(true);
    const fresh = await service.hash('Legacy@12345');
    expect(service.needsRehash(fresh)).toBe(false);
  });

  it('哈希为空或损坏时返回 false，不抛错（防账号枚举）', async () => {
    await expect(service.verify('', 'x')).resolves.toBe(false);
    await expect(service.verify('not-a-hash', 'x')).resolves.toBe(false);
    await expect(service.verify('$argon2id$broken', 'x')).resolves.toBe(false);
    await expect(service.verify('$2b$broken', 'x')).resolves.toBe(false);
  });

  it('mask 只返回占位符，不泄露明文', () => {
    expect(service.mask()).toBe('***');
  });
});

describe('checkPasswordPolicy', () => {
  it('low 档只要求长度 6', () => {
    expect(checkPasswordPolicy('abcdef', 'low').ok).toBe(true);
    expect(checkPasswordPolicy('abcde', 'low').issues[0]).toContain('至少 6 位');
  });

  it('medium 档要求长度 8 + 字母 + 数字', () => {
    expect(checkPasswordPolicy('abc12345', 'medium').ok).toBe(true);
    const weak = checkPasswordPolicy('abcdefgh', 'medium');
    expect(weak.ok).toBe(false);
    expect(weak.issues.some((i) => i.includes('数字'))).toBe(true);
  });

  it('high 档额外要求特殊字符且长度 12', () => {
    expect(checkPasswordPolicy('Abcdef12345!', 'high').ok).toBe(true);
    expect(checkPasswordPolicy('Abcdef123456', 'high').issues.some((i) => i.includes('特殊字符'))).toBe(true);
    expect(checkPasswordPolicy('Ab1!', 'high').issues.some((i) => i.includes('至少 12 位'))).toBe(true);
  });

  it('空密码与超长密码被拒', () => {
    expect(checkPasswordPolicy('', 'low').ok).toBe(false);
    expect(checkPasswordPolicy('a'.repeat(129), 'low').issues.some((i) => i.includes('128'))).toBe(true);
  });
});
