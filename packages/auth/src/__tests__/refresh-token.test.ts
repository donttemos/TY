/*
 * @file 刷新令牌轮换与重放检测单测
 * @description 覆盖 TC-AUTH-006（轮换后旧令牌立即失效）、TC-AUTH-007（超窗口复用判定泄漏并终止全族）、
 *   TC-AUTH-008（10s 宽限窗口内并发使用不误判）、族撤销 / 全量撤销 / 过期清理与「不存明文」断言
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo 补「整族撤销后宽限窗口内复用亦被拒」用例（e2e 发现的泄漏处置绕过缺陷）
 * @module @fw/auth
 */
import { describe, expect, it, vi } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { createHarness } from './test-helpers.js';
import { hashToken } from '../refresh-token.service.js';

describe('RefreshTokenService', () => {
  it('首次签发只落哈希，明文不落库', async () => {
    const h = createHarness();
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const issued = await h.refresh.issue(user.id, '1.1.1.1', 'jest');
    const record = await h.refresh.find(issued.refreshToken);
    expect(record).not.toBeNull();
    expect(record?.tokenHash).toBe(hashToken(issued.refreshToken));
    expect(record?.tokenHash).not.toBe(issued.refreshToken);
    expect(record?.familyId).toBe(issued.familyId);
    expect(record?.revokedAt).toBeNull();
  });

  it('TC-AUTH-006：轮换后旧 refresh 立即失效，新 refresh 同族', async () => {
    const h = createHarness();
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const first = await h.refresh.issue(user.id, '1.1.1.1', null);
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', null);
    expect(rotated.outcome.familyId).toBe(first.familyId);
    expect(rotated.outcome.reuseDetected).toBe(false);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const oldRecord = await h.refresh.find(first.refreshToken);
    expect(oldRecord?.revokedAt).not.toBeNull();

    const newRecord = await h.refresh.find(rotated.refreshToken);
    expect(newRecord?.revokedAt).toBeNull();
    expect(newRecord?.familyId).toBe(first.familyId);
  });

  it('TC-AUTH-008：宽限窗口内复用旧 refresh 按并发处理，不判泄漏', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const first = await h.refresh.issue(user.id, '1.1.1.1', null);
    await h.refresh.rotate(first.refreshToken, '1.1.1.1', null);
    const concurrent = await h.refresh.rotate(first.refreshToken, '1.1.1.1', null);
    expect(concurrent.outcome.withinGrace).toBe(true);
    expect(concurrent.outcome.reuseDetected).toBe(false);
  });

  it('TC-AUTH-007：超出宽限窗口复用判定泄漏，整族与用户全部令牌被撤销', async () => {
    // 宽限窗口设为 0：任何非同时刻的复用都判定为泄漏（避免依赖时钟伪造）
    const h = createHarness({ refreshGraceSeconds: 0 });
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const first = await h.refresh.issue(user.id, '1.1.1.1', null);
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', null);

    // 让撤销时间早于当前至少 1ms
    await new Promise((resolve) => setTimeout(resolve, 20));
    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', null)).rejects.toBeInstanceOf(BizError);

    // 整族被撤销：本轮换产生的新令牌也失效
    const familyToken = await h.refresh.find(rotated.refreshToken);
    expect(familyToken?.revokedAt).not.toBeNull();
    await expect(h.refresh.rotate(rotated.refreshToken, '1.1.1.1', null)).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('族被整族撤销后，即使仍在宽限窗口内也拒绝复用（防止泄漏处置被绕过）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const first = await h.refresh.issue(user.id, '1.1.1.1', null);
    const rotated = await h.refresh.rotate(first.refreshToken, '1.1.1.1', null);

    // 前置确认：族内仍有有效令牌时，宽限通道确实生效（否则本用例可能因其它原因通过）
    const concurrent = await h.refresh.rotate(first.refreshToken, '1.1.1.1', null);
    expect(concurrent.outcome.withinGrace).toBe(true);

    // 整族撤销（登出 / 强制下线 / 泄漏处置）后，同族旧令牌不得再借宽限窗口换发
    await h.refresh.revokeFamily(first.familyId);
    await expect(h.refresh.rotate(first.refreshToken, '1.1.1.1', null)).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    await expect(h.refresh.rotate(rotated.refreshToken, '1.1.1.1', null)).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
  });

  it('未知 refresh 返回 3001，过期 refresh 返回 3003', async () => {
    const h = createHarness();
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await expect(h.refresh.rotate('not-a-token', '1.1.1.1', null)).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const issued = await h.refresh.issue(user.id, '1.1.1.1', null);
    vi.useFakeTimers();
    // 跳过 refresh 有效期（7 天）后再使用：先判过期（3003）
    vi.setSystemTime(new Date(Date.now() + 8 * 24 * 3600 * 1000));
    await expect(h.refresh.rotate(issued.refreshToken, '1.1.1.1', null)).rejects.toMatchObject({
      code: ErrorCode.TOKEN_EXPIRED,
    });
    vi.useRealTimers();
  });

  it('revokeFamily / revokeAllForUser / cleanup 行为正确', async () => {
    const h = createHarness();
    const user = h.store.seedUser({
      username: 'u1',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const a = await h.refresh.issue(user.id, '1.1.1.1', null);
    const b = await h.refresh.issue(user.id, '1.1.1.1', null);

    expect(await h.refresh.revokeFamily(a.familyId)).toBe(1);
    const recordA = await h.refresh.find(a.refreshToken);
    expect(recordA?.revokedAt).not.toBeNull();

    expect(await h.refresh.revokeAllForUser(user.id)).toBe(1);
    const recordB = await h.refresh.find(b.refreshToken);
    expect(recordB?.revokedAt).not.toBeNull();

    expect(await h.refresh.cleanup(new Date(Date.now() + 8 * 24 * 3600 * 1000))).toBe(2);
  });
});
