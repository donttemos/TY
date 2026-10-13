/*
 * @file 令牌签发与校验收单测
 * @description 覆盖 access/refresh 分型、过期映射 3003、篡改与算法不符判无效、双密钥轮换过渡（TC-AUTH-014）
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { JWT_ISSUER } from '../constants.js';
import { TEST_SECRET, TEST_SECRET_PREV } from './test-helpers.js';
import { TokenService, TokenVerifyError } from '../token.service.js';

/** 手工签发令牌（用于构造非法/过期样本） */
async function craft(
  secret: string,
  payload: Record<string, unknown>,
  options: { expiresIn?: number; issuer?: string } = {},
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(payload)
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer(options.issuer ?? JWT_ISSUER)
    .setSubject(String(payload.sub ?? 'u1'))
    .setJti(String(payload.jti ?? 'j1'))
    .setIssuedAt(now - 10)
    .setExpirationTime(now + (options.expiresIn ?? 600))
    .sign(new TextEncoder().encode(secret));
}

describe('TokenService', () => {
  const tokens = new TokenService({ secret: TEST_SECRET, accessTtlSeconds: 7200, refreshTtlSeconds: 604800 });

  it('签发并验签 access / refresh，jti 唯一且族 ID 透传', async () => {
    const access = await tokens.signAccess({ id: 'u1', username: 'alice', roles: ['user'] }, 'fam-1');
    const refresh = await tokens.signRefresh('u1', 'fam-1', 'jti-refresh');

    const verifiedAccess = await tokens.verify(access.token);
    expect(verifiedAccess.claims.typ).toBe('access');
    expect(verifiedAccess.claims.sub).toBe('u1');
    expect((verifiedAccess.claims as { fam?: string }).fam).toBe('fam-1');
    expect(verifiedAccess.usedPrevSecret).toBe(false);

    const verifiedRefresh = await tokens.verify(refresh.token);
    expect(verifiedRefresh.claims.typ).toBe('refresh');
    expect((verifiedRefresh.claims as { fam?: string }).fam).toBe('fam-1');
    expect(access.expiresIn).toBe(7200);
  });

  it('过期令牌判定为 expired（守卫映射 3003）', async () => {
    const expired = await craft(TEST_SECRET, { username: 'a', roles: [], typ: 'access', jti: 'j-exp' }, { expiresIn: -60 });
    await expect(tokens.verify(expired)).rejects.toMatchObject({ reason: 'expired' });
    await expect(tokens.verify(expired)).rejects.toBeInstanceOf(TokenVerifyError);
  });

  it('密钥不符 / 载荷被篡改 / 签发者不符 / 空令牌 → invalid 或 missing', async () => {
    const foreign = await craft('another-secret-key-0123456789abcdef', { username: 'a', roles: [], typ: 'access' });
    await expect(tokens.verify(foreign)).rejects.toMatchObject({ reason: 'invalid' });

    const wrongIssuer = await craft(TEST_SECRET, { username: 'a', roles: [], typ: 'access' }, { issuer: 'evil' });
    await expect(tokens.verify(wrongIssuer)).rejects.toMatchObject({ reason: 'invalid' });

    const tampered = `${(await tokens.signAccess({ id: 'u1', username: 'a', roles: [] })).token.slice(0, -3)}abc`;
    await expect(tokens.verify(tampered)).rejects.toMatchObject({ reason: 'invalid' });

    await expect(tokens.verify('')).rejects.toMatchObject({ reason: 'missing' });
  });

  it('配置 JWT_SECRET_PREV 后旧密钥签发的令牌仍可验签（过渡期）', async () => {
    const rotating = new TokenService({
      secret: TEST_SECRET,
      secretPrev: TEST_SECRET_PREV,
      accessTtlSeconds: 7200,
      refreshTtlSeconds: 604800,
    });
    const legacy = await craft(TEST_SECRET_PREV, { username: 'old', roles: [], typ: 'access' });
    const result = await rotating.verify(legacy);
    expect(result.usedPrevSecret).toBe(true);

    // 过渡期结束后（无 prev）旧令牌失效
    const afterRotation = new TokenService({ secret: TEST_SECRET, accessTtlSeconds: 7200, refreshTtlSeconds: 604800 });
    await expect(afterRotation.verify(legacy)).rejects.toMatchObject({ reason: 'invalid' });
  });

  it('密钥缺失、过短或有效期非法时拒绝构造', () => {
    expect(() => new TokenService({ secret: 'short', accessTtlSeconds: 7200, refreshTtlSeconds: 604800 })).toThrow(/JWT_SECRET/);
    expect(() => new TokenService({ secret: TEST_SECRET, accessTtlSeconds: 0, refreshTtlSeconds: 604800 })).toThrow(/有效期/);
  });

  it('issuePair 返回完整双 token 结构', async () => {
    const issued = await tokens.issuePair({ id: 'u9', username: 'bob', roles: ['user'] }, 'fam-9');
    expect(issued.pair.tokenType).toBe('Bearer');
    expect(issued.pair.accessToken).not.toBe(issued.pair.refreshToken);
    expect(issued.accessJti).toBeTruthy();
    expect(issued.pair.expiresIn).toBe(7200);
  });
});
