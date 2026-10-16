/*
 * @file M11.1 L2 内存并发回归：N × A ⇒ exactly 1 × B（ADR-0020 Rule 5）
 * @description 对 @fw/auth 的 MemoryAuthStore CAS 路径做并发容量回归。
 *   与 M11.0a baseline 的区别：baseline 冻结「修复前」现状（5 failed），本文件锁定「修复后」不变量——
 *   并发/重试的每一个请求都必须拿回同一个已持久化 replacement，且 replacement 总数恰好为 1
 *   （是 exactly 而非 <=：不存在「零 replacement」的成功路径）。
 *   跨进程/跨实例的分布式 CAS 由 Prisma 集成测试（example-api）与双实例验证承担，此处为单进程语义。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import { createHarness } from './test-helpers.js';

function seedUser(h: ReturnType<typeof createHarness>) {
  return h.store.seedUser({
    username: `m11-conc-${Date.now()}-${Math.random()}`,
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

/** 并发轮换的公共断言：N 个请求 ⇒ 唯一 replacement + 全部 withinGrace + 族归属一致 */
async function assertConcurrentRotation(concurrency: number) {
  const h = createHarness({ refreshGraceSeconds: 10 });
  const user = seedUser(h);
  const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-conc');

  const results = await Promise.all(
    Array.from({ length: concurrency }, () =>
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-conc'),
    ),
  );

  const uniqueTokens = [...new Set(results.map((r) => r.refreshToken))];
  expect(uniqueTokens, `${concurrency} 并发必须恰好产生 1 个 replacement`).toHaveLength(1);

  // 赢家路径 withinGrace=false，输家路径 already_rotated ⇒ withinGrace=true；
  // 对调用方而言语义统一为「拿到唯一 B」，reuseDetected 恒为 false（非泄漏）
  expect(results.every((r) => r.outcome.reuseDetected === false)).toBe(true);
  expect(results.every((r) => r.outcome.familyId === first.familyId)).toBe(true);

  // 唯一 replacement 必须已持久化、未撤销、族归属一致（Rule 5）
  const record = await h.refresh.find(uniqueTokens[0]!);
  expect(record).not.toBeNull();
  expect(record?.revokedAt).toBeNull();
  expect(record?.familyId).toBe(first.familyId);
  expect(record?.tokenHash).not.toBe(uniqueTokens[0]);

  // 旧 token A 已撤销且密文指向唯一 replacement（hash-only 不变量保持）
  const oldRecord = await h.refresh.find(first.refreshToken);
  expect(oldRecord?.revokedAt).not.toBeNull();
  expect(oldRecord?.replacementCipher).not.toBeNull();
  expect(oldRecord?.replacedById).not.toBeNull();

  return { h, first, uniqueTokens };
}

describe('M11.1 L2 内存并发（ADR-0020 Rule 5：exactly 1 replacement）', () => {
  it('2 并发 rotation ⇒ exactly 1 replacement（CAS 赢家 + already_rotated 各一）', async () => {
    const { uniqueTokens } = await assertConcurrentRotation(2);
    expect(uniqueTokens).toHaveLength(1);
  });

  it('10 并发 rotation ⇒ exactly 1 replacement', async () => {
    await assertConcurrentRotation(10);
  });

  it('100 并发 rotation ⇒ exactly 1 replacement（DoD 容量线）', async () => {
    await assertConcurrentRotation(100);
  });

  it('并发之后 grace 内重试仍返回同一个 B（Case B：CAS 输家路径的确定性形态）', async () => {
    const { h, first, uniqueTokens } = await assertConcurrentRotation(10);
    const retry = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-conc');
    expect(retry.refreshToken).toBe(uniqueTokens[0]);
    expect(retry.outcome.withinGrace).toBe(true);
    expect(retry.outcome.reuseDetected).toBe(false);
  });
});
