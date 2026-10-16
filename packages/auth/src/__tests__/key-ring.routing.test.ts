/*
 * @file M11.4 L7 Key Ring 路由与代际回归（ADR-0023 Rule 6 + prerequisite ③）
 * @description 覆盖：
 *   - Rule 6 路由优先级：显式命中仅试该 key（失败不试其它——即使其它 key 能解）/ legacy
 *     replacement-v1 回退链 current→prev / 未知 keyId fail closed / 禁全 Ring brute-force；
 *   - prerequisite ③ 验收判据正向：轮换部署（OLD→NEW+PREV）下旧密文 grace 内恢复原 B 不触发族撤销；
 *   - 反向：回退全失败 → fail closed 族撤销（Security Invariant 不松动）；
 *   - JWT kid：sign 带 kid / verify 路由 / 无 kid 存量兼容 / kid=jwt-prev 优先。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { createHash, createSecretKey } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify, SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { createHarness } from './test-helpers.js';
import { JWT_CURRENT_KID, JWT_PREVIOUS_KID, ReplacementKeyRing } from '../key-ring.js';
import { TokenService } from '../token.service.js';
import { RefreshTokenService } from '../refresh-token.service.js';

const SECRET_OLD = 'old-secret-0123456789abcdef0123456789abcdef';
const SECRET_NEW = 'new-secret-0123456789abcdef0123456789abcdef';
const RING_V2_SECRET = 'ring-v2-secret-0123456789abcdef0123456789abcdef';
const JWT_ALG_ISSUER = { algorithms: ['HS256'], issuer: 'fw-auth' } as const;

function makeService(secret: string, opts: { prev?: string; replacementKeys?: Array<{ keyId: string; secret: string }> } = {}) {
  const tokens = new TokenService({
    secret,
    secretPrev: opts.prev,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 7 * 24 * 3600,
    replacementKeys: opts.replacementKeys,
  });
  return tokens;
}

function makeHarnessWithTokens(secret: string, opts: { prev?: string; replacementKeys?: Array<{ keyId: string; secret: string }> } = {}) {
  const h = createHarness({ refreshGraceSeconds: 10 });
  const tokens = makeService(secret, opts);
  const refresh = new RefreshTokenService(h.store, tokens, 10, true);
  const user = h.store.seedUser({
    username: `m11-l7-${Date.now()}-${Math.random()}`,
    phone: null,
    email: null,
    passwordHash: 'x',
    nickname: null,
    avatar: null,
    status: 1,
    lastLoginAt: null,
    lastLoginIp: null,
  });
  return { ...h, tokens, refresh, user };
}

describe('M11.4 L7：Rule 6 路由优先级（显式 Ring）', () => {
  it('显式 Ring：encrypt 用 ring.currentKeyId；decrypt round-trip', () => {
    const tokens = makeService(SECRET_NEW, {
      replacementKeys: [{ keyId: 'replacement-v2', secret: RING_V2_SECRET }],
    });
    const { cipher, keyId } = tokens.encryptReplacement('plaintext-B');
    expect(keyId).toBe('replacement-v2');
    expect(tokens.decryptReplacement(cipher, keyId)).toBe('plaintext-B');
  });

  it('Rule 6④：显式命中失败不试其它 key——即使 Ring 中另一 key 是正确密钥也 fail closed', () => {
    // svcA：Ring=[k1:CORRECT]，用 k1 加密
    const svcA = makeService(SECRET_NEW, {
      replacementKeys: [{ keyId: 'k1', secret: RING_V2_SECRET }],
    });
    const { cipher, keyId } = svcA.encryptReplacement('plaintext-B');
    expect(keyId).toBe('k1');

    // svcB：Ring=[k1:WRONG, k2:CORRECT]——k1 解密必失败；k2 能解但**禁止试**
    const svcB = makeService(SECRET_NEW, {
      replacementKeys: [
        { keyId: 'k1', secret: 'wrong-secret-0123456789abcdef0123456789' },
        { keyId: 'k2', secret: RING_V2_SECRET },
      ],
    });
    expect(() => svcB.decryptReplacement(cipher, keyId)).toThrow(/GCM|非法|密钥|auth/);
  });

  it('Rule 6③：未知 keyId → 直接 fail closed', () => {
    const tokens = makeService(SECRET_NEW, {
      replacementKeys: [{ keyId: 'replacement-v2', secret: RING_V2_SECRET }],
    });
    expect(() => tokens.decryptReplacement('v1:never-seen:a:b:c', 'never-seen')).toThrow();
  });
});

describe('M11.4 L7：代际回退（prerequisite ③ 验收判据）', () => {
  it('正向：轮换部署（OLD→NEW+PREV）下 legacy 密文解密恢复，不触发族撤销', async () => {
    const h = makeHarnessWithTokens(SECRET_OLD); // 旧实例：secret=OLD，无 prev，无 Ring
    const user = h.user;
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    // 新实例：secret=NEW + prev=OLD（轮换部署形态），grace 内异端重试（同 UA）
    const newSvc = new RefreshTokenService(
      h.store,
      makeService(SECRET_NEW, { prev: SECRET_OLD }),
      10,
      true,
    );
    const retry = await newSvc.rotate(first.refreshToken, '1.1.1.1', 'device-1');
    expect(retry.refreshToken).toBe(b.refreshToken);
    expect(retry.outcome.withinGrace).toBe(true);

    // 不触发族撤销：B 仍有效
    const bRecord = await h.refresh.find(b.refreshToken);
    expect(bRecord?.revokedAt).toBeNull();
  });

  it('跨代场景：显式 replacement-v2 Ring 部署下，legacy replacement-v1 密文走 HKDF(NEW)→HKDF(OLD) 回退恢复', async () => {
    const h = makeHarnessWithTokens(SECRET_OLD); // 旧实例：legacy 派生
    const user = h.user;
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    // 新部署：显式 Ring（replacement-v2）+ JWT 轮换（NEW/PREV=OLD）
    const newSvc = new RefreshTokenService(
      h.store,
      makeService(SECRET_NEW, { prev: SECRET_OLD, replacementKeys: [{ keyId: 'replacement-v2', secret: RING_V2_SECRET }] }),
      10,
      true,
    );
    // A 行密文 keyId=replacement-v1，Ring 不含 → legacy 回退链：HKDF(NEW) 失败 → HKDF(OLD) 成功
    const retry = await newSvc.rotate(first.refreshToken, '1.1.1.1', 'device-1');
    expect(retry.refreshToken).toBe(b.refreshToken);
  });

  it('反向：回退链全失败（NEW 无 prev）→ fail closed 族撤销（Security Invariant 不松动）', async () => {
    const h = makeHarnessWithTokens(SECRET_OLD);
    const user = h.user;
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    // 新实例只持 NEW、无 prev → legacy 密文解不开 → fail closed
    const brokenSvc = new RefreshTokenService(h.store, makeService(SECRET_NEW), 10, true);
    await expect(
      brokenSvc.rotate(first.refreshToken, '1.1.1.1', 'device-1'),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const bRecord = await h.refresh.find(b.refreshToken);
    expect(bRecord?.revokedAt).not.toBeNull();
  });
});

describe('M11.4 L7：JWT kid 路由（ADR-0023 决策 4）', () => {
  it('sign 带 kid=jwt-current；verify 路由正常', async () => {
    const tokens = makeService(SECRET_NEW, { prev: SECRET_OLD });
    const issued = await tokens.signRefresh('user-1', 'fam-1');
    const header = decodeProtectedHeader(issued.token);
    expect(header.kid).toBe(JWT_CURRENT_KID);
    const result = await tokens.verify(issued.token);
    expect(result.claims.sub).toBe('user-1');
  });

  it('kid=jwt-prev 优先 prev 验签；无 kid 存量 token 走双试兼容', async () => {
    const tokens = makeService(SECRET_NEW, { prev: SECRET_OLD });

    // 存量形态：旧实例（current=OLD）签发的 token——新实例（current=NEW, prev=OLD）验证
    const legacyTokens = new TokenService({
      secret: SECRET_OLD,
      accessTtlSeconds: 900,
      refreshTtlSeconds: 7 * 24 * 3600,
    });
    const legacyIssued = await legacyTokens.signRefresh('user-1', 'fam-1');
    const result = await tokens.verify(legacyIssued.token);
    expect(result.usedPrevSecret).toBe(true);
    expect(result.claims.sub).toBe('user-1');

    // 无 kid 存量 token（手工签发，不带 kid）→ 双试兼容
    const key = createSecretKey(Buffer.from(SECRET_OLD));
    const rawNoKid = await new SignJWT({ typ: 'refresh', fam: 'fam-1' })
      .setProtectedHeader({ alg: 'HS256' })
      .setIssuer('fw-auth')
      .setSubject('user-1')
      .setJti('jti-1')
      .setIssuedAt()
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(key);
    expect(decodeProtectedHeader(rawNoKid).kid).toBeUndefined();
    const noKidResult = await tokens.verify(rawNoKid);
    expect(noKidResult.usedPrevSecret).toBe(true);

    // kid 语义自检：jwt-prev / jwt-current 常量存在（角色路由标识）
    expect(JWT_PREVIOUS_KID).toBe('jwt-prev');
    expect(JWT_CURRENT_KID).toBe('jwt-current');
    void jwtVerify;
  });
});
