/*
 * @file M12 W1 统一审计事件契约回归（PRD-012 OBS-06/OBS-07，ADR-0025）
 * @description 验证 replay 安全事件按统一 AuditEvent 契约落库：
 *   ① CAS replay（no_replacement）与 grace 过期 / 指纹不匹配三条路径的审计行
 *      均携带 category='security' / event='refresh.replay_detected' / result='denied'
 *      / familyId / jti / ip / userAgent / traceId（取自请求上下文——修复硬编码 null 断链）；
 *   ② reason 为结构化低基数原因（afterValue.reason）；
 *   ③ AuditService 对新契约字段的全量落位（缺省 null，字段完整——OBS-08 前置）。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { runWithRequestContext } from '@fw/logger';
import { AuditService } from '../audit.service.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import type { AuthUser } from '../types.js';
import { createHarness, type Harness } from './test-helpers.js';

function seedUser(h: Harness, username: string): AuthUser {
  return h.store.seedUser({
    username,
    phone: null,
    email: null,
    passwordHash: 'unit-test-hash',
    nickname: username,
    avatar: null,
    status: 1,
    lastLoginAt: null,
    lastLoginIp: null,
  });
}

/** 读取最近一条 security 审计行 */
async function lastSecurityRow(h: Harness) {
  const audits = await h.store.pageAuditLogs({ page: 1, pageSize: 10, action: 'security' });
  expect(audits.total).toBe(1);
  return audits.items[0]!;
}

describe('M12 W1 · replay 安全事件统一审计契约（OBS-07）', () => {
  it('CAS replay（no_replacement）：审计行九要素齐全，traceId 取自请求上下文（断链修复）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'contract-cas');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    // 登出语义：族撤销且从未成功轮换 ⇒ CAS 判定 no_replacement
    await h.refresh.revokeFamily(first.familyId);

    await expect(
      runWithRequestContext({ traceId: 'trace-contract-1', spanId: '' }, () =>
        h.refresh.rotate(first.refreshToken, '9.9.9.9', 'evil-agent'),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const row = await lastSecurityRow(h);
    expect(row.module).toBe('auth');
    expect(row.category).toBe('security');
    expect(row.event).toBe('refresh.replay_detected');
    expect(row.result).toBe('denied');
    expect(row.familyId).toBe(first.familyId);
    expect(row.jti).toBe(first.jti);
    expect(row.userId).toBe(user.id);
    expect(row.traceId).toBe('trace-contract-1');
    expect(row.ip).toBe('9.9.9.9');
    expect(row.userAgent).toBe('evil-agent');
    expect((row.afterValue as { reason: string }).reason).toBe('no_replacement');
    expect(row.requestId).toBeNull(); // OBS-09（W2）起由统一上下文填充
  });

  it('指纹不匹配路径：reason=fingerprint_mismatch，ip/ua 为重试方请求值（主路径不再丢失）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'contract-fp');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    await expect(
      runWithRequestContext({ traceId: 'trace-contract-2', spanId: '' }, () =>
        h.refresh.rotate(first.refreshToken, '3.3.3.3', 'device-2'),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const row = await lastSecurityRow(h);
    expect(row.category).toBe('security');
    expect(row.event).toBe('refresh.replay_detected');
    expect(row.result).toBe('denied');
    expect(row.familyId).toBe(first.familyId);
    expect(row.jti).toBe(first.jti);
    expect(row.traceId).toBe('trace-contract-2');
    expect(row.ip).toBe('3.3.3.3');
    expect(row.userAgent).toBe('device-2');
    expect((row.afterValue as { reason: string }).reason).toBe('fingerprint_mismatch');
  });

  it('grace 过期路径：reason=grace_expired，恢复失败 / replacement 失效同走统一契约', async () => {
    const h = createHarness({ refreshGraceSeconds: 0 });
    const user = seedUser(h, 'contract-grace');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const b = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');
    // 越过 grace 窗口（recoverableUntil = 轮换时刻）
    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      runWithRequestContext({ traceId: 'trace-contract-3', spanId: '' }, () =>
        h.refresh.rotate(first.refreshToken, '5.5.5.5', 'device-1'),
      ),
    ).rejects.toMatchObject({ code: ErrorCode.UNAUTHORIZED });

    const row = await lastSecurityRow(h);
    expect((row.afterValue as { reason: string }).reason).toBe('grace_expired');
    expect(row.event).toBe('refresh.replay_detected');
    expect(row.result).toBe('denied');
    expect(row.traceId).toBe('trace-contract-3');
    expect(row.ip).toBe('5.5.5.5');
    expect(row.jti).toBe(first.jti);
    expect(b.refreshToken.length).toBeGreaterThan(0);
  });

  it('无请求上下文（进程内调用）时 traceId 落 null，不抛错、不阻塞主流程', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h, 'contract-noctx');
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    await h.refresh.revokeFamily(first.familyId);

    await expect(h.refresh.rotate(first.refreshToken, '7.7.7.7', 'cli')).rejects.toMatchObject({
      code: ErrorCode.UNAUTHORIZED,
    });
    const row = await lastSecurityRow(h);
    expect(row.traceId).toBeNull();
    expect(row.ip).toBe('7.7.7.7');
    expect(row.userAgent).toBe('cli');
  });
});

describe('M12 W1 · AuditService 统一事件契约（OBS-06）', () => {
  it('显式传入事件契约字段 → 全量落库', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordSync({
      userId: 'u-1',
      module: 'auth',
      action: 'security',
      category: 'security',
      event: 'refresh.replay_detected',
      result: 'denied',
      familyId: 'fam-1',
      jti: 'jti-1',
      requestId: 'req-1',
      targetType: 'refresh_family',
      targetId: 'fam-1',
      after: { detail: 'x' },
    });
    const row = (await audit.page({ page: 1, pageSize: 10, action: 'security' })).items[0]!;
    expect(row.category).toBe('security');
    expect(row.event).toBe('refresh.replay_detected');
    expect(row.result).toBe('denied');
    expect(row.familyId).toBe('fam-1');
    expect(row.jti).toBe('jti-1');
    expect(row.requestId).toBe('req-1');
  });

  it('旧调用方不传事件契约字段 → 字段完整但为 null（形状不漂移，零回归）', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordSync({ module: 'order', action: 'create' });
    const row = (await audit.page({ page: 1, pageSize: 10 })).items[0]!;
    expect(row.category).toBeNull();
    expect(row.event).toBeNull();
    expect(row.result).toBeNull();
    expect(row.familyId).toBeNull();
    expect(row.jti).toBeNull();
    expect(row.requestId).toBeNull();
  });
});
