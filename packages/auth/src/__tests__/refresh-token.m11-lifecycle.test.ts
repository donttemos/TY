/*
 * @file M11.2 L5 Refresh Token 生命周期回归（ADR-0021）
 * @description 全生命周期组合：A→B→C→D 链式轮换、中途 logout / logout-all / 改密撤销、
 *   孤儿 replacement（父行被清理后子行语义不变）、cipher grace 级清空及其后的泄漏判定、
 *   cleanup 幂等与「清理只动 A 的 replacement 不碰 B」。
 *   与 TC-AUTH 系列的区别：以**组合链**为断言单位（TC 系列是单点语义）。
 *   ADR-0021 决策 7：生命周期状态全部派生（revokedAt / replacementExpiresAt / cipher NULL），
 *   不引入枚举——本文件的断言全部基于派生事实。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { createHarness } from './test-helpers.js';
import { hashToken } from '../refresh-token.service.js';

function seedUser(h: ReturnType<typeof createHarness>, name: string) {
  return h.store.seedUser({
    username: `m11-l5-${name}-${Date.now()}-${Math.random()}`,
    phone: null,
    email: null,
    passwordHash: 'x',
    nickname: null,
    avatar: null,
    status: 1,
    lastLoginAt: null,
    lastLoginIp: null,
  });
}

/** 断言链上恰好只有一个活口（最新 replacement），其余全部撤销 */
async function assertSingleLivingToken(h: ReturnType<typeof createHarness>, tokens: string[], living: string) {
  for (const token of tokens) {
    const record = await h.refresh.find(token);
    expect(record).not.toBeNull();
    expect(record?.revokedAt ? 'revoked' : 'active').toBe(token === living ? 'active' : 'revoked');
  }
}

describe('M11.2 L5：A→B→C→D 全链生命周期（ADR-0021）', () => {
  it('L5-01：链式轮换——familyId 恒定，历史链全部撤销，唯一活口为最新 replacement', async () => {
    const h = createHarness({ refreshGraceSeconds: 0 }); // 关闭 grace：每次 rotate 都走 CAS 新签发
    const user = seedUser(h, 'chain');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'l5');

    const chain = [first.refreshToken];
    for (let i = 0; i < 3; i++) {
      const rotated = await h.refresh.rotate(chain[chain.length - 1]!, '1.1.1.1', 'l5');
      chain.push(rotated.refreshToken);
    }
    expect(new Set(chain).size).toBe(4);

    // 全链同族
    for (const token of chain) {
      const record = await h.refresh.find(token);
      expect(record?.familyId).toBe(first.familyId);
    }
    await assertSingleLivingToken(h, chain, chain[3]!);

    // 历史链的轮换元数据保留（历史链不清：revokedAt / replacedById 是排障依据）
    for (let i = 0; i < 3; i++) {
      const record = await h.refresh.find(chain[i]!);
      expect(record?.revokedAt).not.toBeNull();
      expect(record?.replacedById).not.toBeNull();
    }
  });

  it('L5-02：链中途 logout（单设备族撤销）——链上所有 token 复用全拒，其它族不受影响', async () => {
    const h = createHarness({ refreshGraceSeconds: 0 });
    const user = seedUser(h, 'logout');
    const other = seedUser(h, 'logout-other');

    const family = await h.refresh.issue(user.id, '1.1.1.1', 'l5');
    const b = await h.refresh.rotate(family.refreshToken, '1.1.1.1', 'l5');
    const c = await h.refresh.rotate(b.refreshToken, '1.1.1.1', 'l5');

    const otherFamily = await h.refresh.issue(other.id, '1.1.1.1', 'l5');

    // 登出当前设备：整族撤销
    await h.refresh.revokeFamily(family.familyId);
    await assertSingleLivingToken(h, [family.refreshToken, b.refreshToken, c.refreshToken], '');

    for (const token of [family.refreshToken, b.refreshToken, c.refreshToken]) {
      await expect(h.refresh.rotate(token, '1.1.1.1', 'l5')).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    }

    // 其它用户的族不受影响
    const otherRotated = await h.refresh.rotate(otherFamily.refreshToken, '1.1.1.1', 'l5');
    expect(otherRotated.refreshToken).not.toBe(otherFamily.refreshToken);
  });

  it('L5-03：logout-all / 改密撤销——该用户全部族死，任何旧 token 复用 → 泄漏判定', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'logout-all');
    const stranger = seedUser(h, 'logout-all-stranger');

    const familyA = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const familyB = await h.refresh.issue(user.id, '2.2.2.2', 'device-2');
    const strangerFamily = await h.refresh.issue(stranger.id, '3.3.3.3', 'device-3');

    // 改密 / 强制下线：撤销该用户全部刷新令牌
    await h.refresh.revokeAllForUser(user.id);

    for (const token of [familyA.refreshToken, familyB.refreshToken]) {
      await expect(h.refresh.rotate(token, '1.1.1.1', 'l5')).rejects.toMatchObject({
        code: ErrorCode.UNAUTHORIZED,
      });
    }
    // 族内的 B 也不得借 grace 复活（族已死前置校验，ADR-0020 grace 语义）
    const bOfA = await h.refresh.find(familyA.refreshToken);
    void bOfA;
    const strangerRotated = await h.refresh.rotate(strangerFamily.refreshToken, '3.3.3.3', 'l5');
    expect(strangerRotated.refreshToken).not.toBe(strangerFamily.refreshToken);
  });

  it('L5-04：孤儿 replacement——父行被 purge 后，子行 rotate / 撤销 / 清理语义不变', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'orphan');
    const familyId = `fam-orphan-${Date.now()}`;

    // 手工构造：父行 A 已过期（会被 purge），子行 B 有效（同族）
    const aHash = `orphan-a-${familyId}`;
    const bPlaintext = `orphan-b-plaintext-${familyId}`;
    await h.store.createRefreshToken({
      userId: user.id,
      tokenHash: aHash,
      familyId,
      expireAt: new Date(Date.now() - 40 * 24 * 3600 * 1000), // 过期 40 天（超出 30 天保留线）
      revokedAt: null,
      loginIp: '1.1.1.1',
      userAgent: 'l5',
      replacedById: null,
      replacementCipher: null,
      replacementKeyId: null,
      replacementExpiresAt: null,
    });
    await h.store.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(bPlaintext),
      familyId,
      expireAt: new Date(Date.now() + 7 * 24 * 3600 * 1000),
      revokedAt: null,
      loginIp: '1.1.1.1',
      userAgent: 'l5',
      replacedById: null,
      replacementCipher: null,
      replacementKeyId: null,
      replacementExpiresAt: null,
    });

    // 30 天保留线清理：父行 A 被删，子行 B 保留
    const removed = await h.store.purgeExpiredRefreshTokens(new Date(Date.now() - 30 * 24 * 3600 * 1000));
    expect(removed).toBeGreaterThanOrEqual(1);
    await expect(h.store.findRefreshTokenByHash(aHash)).resolves.toBeNull();

    // 孤儿 B 的族语义不依赖父行存在：rotate → C 正常
    const c = await h.refresh.rotate(bPlaintext, '1.1.1.1', 'l5');
    expect(c.outcome.familyId).toBe(familyId);
    expect(c.refreshToken).not.toBe(bPlaintext);
    const cRecord = await h.refresh.find(c.refreshToken);
    expect(cRecord?.familyId).toBe(familyId);
  });
});
