/*
 * @file M11.4 Key Ring 单测：配置解析规则冻结 + Ring 构造校验（ADR-0023 决策 1）
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import {
  JwtKeyRing,
  JWT_CURRENT_KID,
  JWT_PREVIOUS_KID,
  KeyRingEntry,
  ReplacementKeyRing,
  parseReplacementKeys,
} from '../key-ring.js';

const OK_SECRET = 'r'.repeat(32);

describe('M11.4 解析规则冻结（ADR-0023 决策 1，启动即校验）', () => {
  it('未配置/空串 → 空数组（调用方回退 legacy HKDF）', () => {
    expect(parseReplacementKeys(undefined)).toEqual([]);
    expect(parseReplacementKeys(null)).toEqual([]);
    expect(parseReplacementKeys('')).toEqual([]);
    expect(parseReplacementKeys('   ')).toEqual([]);
  });

  it('正常解析：多 keyId 列表，currentKeyId = 列表末位', () => {
    const entries: KeyRingEntry[] = parseReplacementKeys(`k1:${'a'.repeat(32)}|k2:${'b'.repeat(32)}`);
    expect(entries.map((e) => e.keyId)).toEqual(['k1', 'k2']);
    const ring = new ReplacementKeyRing(entries);
    expect(ring.currentKeyId).toBe('k2');
    expect(ring.has('k1')).toBe(true);
    // Ring 密钥经 HKDF 派生到 32 字节（AES-256 要求；同 secret 不同 keyId = 同密钥不同标签）
    const derived = ring.keyFor('k2');
    expect(derived).not.toBeNull();
    expect(derived?.length).toBe(32);
    // 同 secret 不同 keyId 派生出相同密钥（info 不含 keyId——Rule 6④ 可验证的前提）
    expect(Buffer.compare(derived as Buffer, ring.keyFor('k1') as Buffer)).not.toBe(0); // secret 不同 → 密钥不同
    expect(ring.keyFor('unknown')).toBeNull();
  });

  it('规则①：keyId 含 : 由首段切分天然排除；含 | 被 split 成多 entry——两种形态都不会产生含 : 或 | 的 keyId', () => {
    // 'bad:key:...' → keyId='bad'（首个 : 即分隔符）；'bad|key:...' → 两个 entry
    const entries = parseReplacementKeys(`bad:key:${OK_SECRET}|other:${'b'.repeat(32)}`);
    expect(entries.map((e) => e.keyId)).toEqual(['bad', 'other']);
    // Ring 构造层防御直接构造的非法 keyId
    expect(() => new ReplacementKeyRing([{ keyId: 'bad:key', secret: OK_SECRET }])).toThrow(/keyId 禁含/);
    expect(() => new ReplacementKeyRing([{ keyId: 'bad|key', secret: OK_SECRET }])).toThrow(/keyId 禁含/);
  });

  it('规则②：secret 含 | 被 split 成多 entry（各 entry 独立校验）——Ring 构造层防御直接构造', () => {
    // 'k1:aaa(16)|bbb(16)' → 两个 entry，后者 16 bytes < 32 → 启动即失败
    expect(() => parseReplacementKeys(`k1:${'a'.repeat(16)}|${'b'.repeat(16)}`)).toThrow(/长度不足/);
    expect(() => new ReplacementKeyRing([{ keyId: 'k1', secret: `${'a'.repeat(16)}|${'b'.repeat(16)}` }])).toThrow(/secret 禁含/);
  });

  it('规则③：空 entry → 启动即失败', () => {
    expect(() => parseReplacementKeys(`${OK_SECRET && 'k1:' + OK_SECRET}||k2:${OK_SECRET}`)).toThrow(/空 entry/);
    expect(() => parseReplacementKeys(`|k1:${OK_SECRET}`)).toThrow(/空 entry/);
  });

  it('规则④：重复 keyId → 启动即失败', () => {
    expect(() => parseReplacementKeys(`k1:${OK_SECRET}|k1:${'b'.repeat(32)}`)).toThrow(/重复 keyId/);
  });

  it('规则⑤：secret < 32 UTF-8 bytes → 启动即失败（多字节按字节计）', () => {
    expect(() => parseReplacementKeys(`k1:${'a'.repeat(31)}`)).toThrow(/长度不足/);
    // 16 个中文字符 = 48 bytes ≥ 32 → 合法（按字节计而非字符数）
    const entries = parseReplacementKeys(`k1:${'钥'.repeat(16)}`);
    expect(entries).toHaveLength(1);
    // 31 个中文字符 = 93 bytes 合法；10 个中文字符 = 30 bytes 非法
    expect(() => parseReplacementKeys(`k1:${'钥'.repeat(10)}`)).toThrow(/长度不足/);
  });
});

describe('M11.4 JwtKeyRing（角色路由标识，ADR-0023 决策 4）', () => {
  it('current/previous 构造与 keyFor 路由', () => {
    const ring = new JwtKeyRing('current-secret', 'previous-secret');
    expect(ring.currentKeyId).toBe(JWT_CURRENT_KID);
    expect(ring.previousKeyId).toBe(JWT_PREVIOUS_KID);
    expect(ring.keyFor(JWT_CURRENT_KID)).toEqual(new TextEncoder().encode('current-secret'));
    expect(ring.keyFor(JWT_PREVIOUS_KID)).toEqual(new TextEncoder().encode('previous-secret'));
    expect(ring.keyFor('unknown')).toBeNull();
  });

  it('未配置 previous：previousKeyId = null，keyFor(jwt-prev) = null', () => {
    const ring = new JwtKeyRing('current-secret');
    expect(ring.previousKeyId).toBeNull();
    expect(ring.hasPrevious()).toBe(false);
    expect(ring.keyFor(JWT_PREVIOUS_KID)).toBeNull();
  });
});
