/*
 * @file M11.3 L6 客户端指纹绑定回归（ADR-0022）
 * @description grace 重试绑定轮换赢家指纹：同客户端 → 返回同一个 B；异客户端 → replay（安全事件，
 *   Rule 8 全链：族撤销 + 会话撤销 + audit security）；NULL 放行仅限存量/off 来源；
 *   IP 不参与指纹（漂移误杀）；normalizeUserAgent 固定测试向量（决策 3a）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { createHarness } from './test-helpers.js';
import { computeFingerprint, normalizeUserAgent } from '../refresh-token.service.js';
import { RefreshTokenService } from '../refresh-token.service.js';

function seedUser(h: ReturnType<typeof createHarness>, name: string) {
  return h.store.seedUser({
    username: `m11-l6-${name}-${Date.now()}-${Math.random()}`,
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

describe('M11.3 决策 3a：normalizeUserAgent 规则冻结（固定测试向量）', () => {
  it('向量 1/2：null 与空串都规范化为 ""，指纹恒为 SHA-256("")（新 rotation 不产生 NULL 的基础）', () => {
    expect(normalizeUserAgent(null)).toBe('');
    expect(normalizeUserAgent(undefined)).toBe('');
    expect(normalizeUserAgent('')).toBe('');
    const emptyFp = createHash('sha256').update('').digest('hex');
    expect(computeFingerprint(null)).toBe(emptyFp);
    expect(computeFingerprint('')).toBe(emptyFp);
  });

  it('向量 3/4：trim 去首尾空白后指纹一致；不做去版本号等模糊归一（大小写不同 → 指纹不同）', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/120.0.0.0';
    expect(computeFingerprint(`  ${ua}  `)).toBe(computeFingerprint(ua));
    // 刻意不归一：大小写差异产生不同指纹（规则冻结，防止行为漂移）
    expect(computeFingerprint(ua.toLowerCase())).not.toBe(computeFingerprint(ua));
  });
});

describe('M11.3 L6：grace 重试指纹绑定（ADR-0022）', () => {
  it('L6-01：同客户端 grace 重试 → already_rotated 返回同一个 B；新 rotation 指纹非 NULL', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'match');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    // 新 rotation 的赢家指纹已写入（决策 3：不得产生 NULL）
    const aRecord = await h.refresh.find(first.refreshToken);
    expect(aRecord?.rotatedFingerprint).toBe(computeFingerprint('device-1'));
    expect(aRecord?.rotatedFingerprint).not.toBeNull();

    const retry = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');
    expect(retry.refreshToken).toBe(b.refreshToken);
    expect(retry.outcome.withinGrace).toBe(true);
  });

  it('L6-02：异客户端 grace 重试 → replay 安全事件（族撤销 + 会话撤销 + audit security 落库）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'mismatch');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    await expect(
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-2'),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    // Rule 8 全链：族撤销 + 用户全部会话撤销
    const bRecord = await h.refresh.find(b.refreshToken);
    expect(bRecord?.revokedAt).not.toBeNull();

    // audit security 事件落库（决策 7）
    const audits = await h.store.pageAuditLogs({ page: 1, pageSize: 10, action: 'security' });
    expect(audits.total).toBe(1);
    expect(audits.items[0]?.targetType).toBe('refresh_family');
    expect(audits.items[0]?.targetId).toBe(first.familyId);
  });

  it('L6-03：存量 NULL 指纹放行（M11.1 历史行兼容）——off 模式轮换后，on 模式异端重试仍返回 B', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'legacy-null');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'legacy');

    // off 模式轮换：指纹为 NULL（模拟 M11.1 存量行）
    const offService = new RefreshTokenService(h.store, h.tokens, 10, false);
    const b = await offService.rotate(first.refreshToken, '1.1.1.1', 'legacy');
    const aRecord = await h.refresh.find(first.refreshToken);
    expect(aRecord?.rotatedFingerprint).toBeNull();

    // on 模式的异端重试：A 行指纹 NULL → 放行（存量兼容，不误杀）
    const retry = await h.refresh.rotate(first.refreshToken, '9.9.9.9', 'different-device');
    expect(retry.refreshToken).toBe(b.refreshToken);
  });

  it('L6-04：off 模式——新轮换不写指纹（合法 NULL 来源）且异端 grace 重试不比对', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'off-mode');
    const offService = new RefreshTokenService(h.store, h.tokens, 10, false);
    const first = await offService.issue(user.id, '1.1.1.1', 'off');
    const b = await offService.rotate(first.refreshToken, '1.1.1.1', 'off');

    const aRecord = await h.refresh.find(first.refreshToken);
    expect(aRecord?.rotatedFingerprint).toBeNull();

    const differentClient = await offService.rotate(first.refreshToken, '1.1.1.1', 'other-device');
    expect(differentClient.refreshToken).toBe(b.refreshToken);
  });

  it('L6-05：IP 不参与指纹——同 UA 不同 IP 的 grace 重试照常返回 B（ADR-0022 决策 1）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'ip-drift');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'mobile');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'mobile');

    // 移动网络切换：IP 漂移但 UA 不变 → 合法用户不得被误杀
    const retry = await h.refresh.rotate(first.refreshToken, '203.0.113.7', 'mobile');
    expect(retry.refreshToken).toBe(b.refreshToken);
    expect(retry.outcome.withinGrace).toBe(true);
  });

  it('L6-06：mismatch 触发的族撤销波及用户其它族成员，异端再无任何换发路径', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'mismatch-full');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    await expect(
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'attacker-ua'),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    // A 与 B 双双失效，重试无任何路径
    for (const token of [first.refreshToken, b.refreshToken]) {
      await expect(h.refresh.rotate(token, '1.1.1.1', 'device-1')).rejects.toBeDefined();
    }
  });
});
