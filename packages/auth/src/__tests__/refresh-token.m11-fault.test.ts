/*
 * @file M11.1 L4 故障注入（Case B–F，ADR-0020《测试分层》）
 * @description 六个故障场景中：
 *   - Case A（CAS 成功 + INSERT B 失败 → 事务回滚、A 保持 active）在 Prisma 层验证——
 *     依赖数据库唯一约束制造写入失败，见 example-api refresh-rotation 集成测试；
 *   - 本文件覆盖 Case B/C/D/E/F：密文损坏 / keyId 未知（Security Invariant：fail closed，
 *     绝不从 A 生成第二个 replacement）、grace 过期、B 已消费后 A replay、A 自身过期。
 *   注入点在 store↔service 边界（monkey-patch rotateRefreshToken 的返回事实），
 *   模拟「磁盘位腐 / 密钥失配 / 时钟漂移」在持久化事实上的表现。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { createHarness } from './test-helpers.js';
import { hashToken } from '../refresh-token.service.js';
import type { RotateRefreshTokenInput, RefreshRotationResult } from '../auth-store.js';
import type { MemoryAuthStore } from '../memory-auth-store.js';

function seedUser(h: ReturnType<typeof createHarness>) {
  return h.store.seedUser({
    username: `m11-fault-${Date.now()}-${Math.random()}`,
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

type CorruptMode = 'cipher' | 'keyId' | 'expired';

/**
 * 给 store 的 rotateRefreshToken 挂一个「事实篡改器」：
 * CAS 赢家路径不受影响；already_rotated 返回前按 mode 篡改 replacement 事实。
 * 直接改实例属性（遮蔽原型方法），不影响同文件其他 harness。
 */
function injectCorruption(store: MemoryAuthStore, mode: () => CorruptMode) {
  const inner = store.rotateRefreshToken.bind(store);
  const patched = async (input: RotateRefreshTokenInput): Promise<RefreshRotationResult> => {
    const result = await inner(input);
    if (result.outcome !== 'already_rotated') return result;
    const modeValue = mode();
    if (modeValue === 'cipher') {
      result.replacement.cipher = 'v1:replacement-v1:AAAA:BBBB:CCCC'; // 密文损坏（GCM 认证必失败）
    } else if (modeValue === 'keyId') {
      result.replacement.keyId = 'unknown-key-2077'; // 密钥失配 / Key Ring 中不存在
    } else {
      result.replacement.recoverableUntil = new Date(Date.now() - 1000); // 时钟漂移 / 窗口已过
    }
    return result;
  };
  store.rotateRefreshToken = patched as typeof store.rotateRefreshToken;
}

describe('M11.1 L4 故障注入（ADR-0020）', () => {
  it('Case C：replacement 密文损坏 ⇒ fail closed（族撤销 + 3001），绝不生成第二个 replacement', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-fault');
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault');

    injectCorruption(h.store, () => 'cipher');

    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });

    // Security Invariant：A 之上没有出现第三个 token——族内仅 A(revoked) + B(revoked by 族撤销)
    const bRecord = await h.refresh.find(rotated.refreshToken);
    expect(bRecord?.revokedAt).not.toBeNull();
    const aRecord = await h.refresh.find(first.refreshToken);
    expect(aRecord?.revokedAt).not.toBeNull();
  });

  it('Case C：keyId 未知（密钥失配）⇒ 同样 fail closed', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-fault');
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault');

    injectCorruption(h.store, () => 'keyId');

    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    const bRecord = await h.refresh.find(rotated.refreshToken);
    expect(bRecord?.revokedAt).not.toBeNull();
  });

  it('Case D：grace 过期 ⇒ replay_detected（族撤销 + 拒绝）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-fault');
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault');

    injectCorruption(h.store, () => 'expired');

    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    const bRecord = await h.refresh.find(rotated.refreshToken);
    expect(bRecord?.revokedAt).not.toBeNull();
  });

  it('Case E：B 已消费（B→C）后 A replay ⇒ fail closed，整族（含 C）撤销', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-fault');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault');
    const c = await h.refresh.rotate(b.refreshToken, '1.1.1.1', 'm11-fault');
    expect(c.refreshToken).not.toBe(b.refreshToken);

    // 攻击者仍在用旧 A（grace 已不适用——A 的 replacement B 自己已被消费）
    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });

    // 族撤销必须波及最新的 C
    const cRecord = await h.refresh.find(c.refreshToken);
    expect(cRecord?.revokedAt).not.toBeNull();
    // 且 A 不能再换来任何 token
    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault')).rejects.toBeDefined();
  });

  it('Case F：A 自身过期 ⇒ 仅拒绝（3003），不触发族撤销', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-fault');
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-fault');

    // 经公开 API 构造一条「已过期、未撤销」的记录（tokenHash 必须是 hashToken(明文)，
    // 否则 findRefreshTokenByHash 查不到——会被误判为 not_found 而非 expired），
    // 过期分支先于 CAS 到达，验证的是「过期仅拒绝、无副作用」语义
    const expiredPlaintext = `expired-${Date.now()}`;
    await h.store.createRefreshToken({
      userId: user.id,
      tokenHash: hashToken(expiredPlaintext),
      familyId: first.familyId,
      expireAt: new Date(Date.now() - 1000),
      revokedAt: null,
      loginIp: '1.1.1.1',
      userAgent: 'm11-fault',
      replacedById: null,
      replacementCipher: null,
      replacementKeyId: null,
      replacementExpiresAt: null,
    });

    await expect(h.refresh.rotate(expiredPlaintext, '1.1.1.1', 'm11-fault')).rejects.toMatchObject({
      code: ErrorCode.TOKEN_EXPIRED,
    });

    // 不做族撤销：同族仍有效的 B 不受影响
    const bRecord = await h.refresh.find(rotated.refreshToken);
    expect(bRecord?.revokedAt).toBeNull();
  });
});
