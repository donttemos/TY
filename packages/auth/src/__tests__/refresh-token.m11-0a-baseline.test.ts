/*
 * @file M11.0a Refresh Token Rotation baseline
 * @description
 *   在不修改生产代码的前提下，冻结当前 RefreshTokenService 的并发/宽限行为。
 *
 *   M11.0a 目的：
 *   1. 建立当前实现的 baseline，而不是提前实现 M11；
 *   2. 验证多个并发 refresh 是否会产生多个 replacement；
 *   3. 验证 grace 内重复使用旧 token 当前到底返回什么；
 *   4. 为后续 CAS + transaction + encrypted replacement 改造提供可重复的回归基线。
 *
 *   重要：
 *   - 本文件刻意不修改任何生产代码；
 *   - 本文件中的部分断言描述的是 M11 目标 invariant，因此在当前实现上
 *     可能 FAIL；这属于预期，目的是先把问题钉死；
 *   - 当前 MemoryAuthStore 是单进程内存实现，因此本文件不能证明跨进程/
 *     跨实例数据库 CAS。双实例测试应在 M11.0a 的 integration/e2e 层补充。
 *
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import { createHarness } from './test-helpers.js';
import { hashToken } from '../refresh-token.service.js';

function seedUser(h: ReturnType<typeof createHarness>) {
  return h.store.seedUser({
    username: `m11-baseline-${Date.now()}-${Math.random()}`,
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

describe('M11.0a RefreshToken rotation baseline', () => {
  it('BASELINE-001：单次 rotation 建立 A → B 基线', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const rotated = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    expect(rotated.outcome.reuseDetected).toBe(false);
    expect(rotated.outcome.familyId).toBe(first.familyId);
    expect(rotated.refreshToken).not.toBe(first.refreshToken);

    const oldRecord = await h.refresh.find(first.refreshToken);
    const replacementRecord = await h.refresh.find(rotated.refreshToken);

    expect(oldRecord).not.toBeNull();
    expect(replacementRecord).not.toBeNull();

    expect(oldRecord?.revokedAt).not.toBeNull();
    expect(replacementRecord?.revokedAt).toBeNull();

    expect(oldRecord?.familyId).toBe(first.familyId);
    expect(replacementRecord?.familyId).toBe(first.familyId);

    // 当前项目已有的 hash-only invariant。
    expect(replacementRecord?.tokenHash).toBe(
      hashToken(rotated.refreshToken),
    );
    expect(replacementRecord?.tokenHash).not.toBe(rotated.refreshToken);
  });

  it('BASELINE-002：2 个并发 refresh 的当前实现 baseline', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const results = await Promise.all([
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
    ]);

    const refreshTokens = results.map((result) => result.refreshToken);

    /*
     * M11 目标：
     *
     *   A
     *   └── B
     *
     * 两个合法并发请求最终应拿到同一个 B。
     *
     * 当前实现的 grace 分支会重新 issue，因此这里用于冻结
     * 当前行为并作为后续 M11 修复的回归断言。
     */
    expect(new Set(refreshTokens).size).toBe(1);
  });

  it('BASELINE-003：10 个并发 refresh 必须只有一个 replacement（M11 target invariant）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const results = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
      ),
    );

    const refreshTokens = results.map((result) => result.refreshToken);
    const uniqueTokens = [...new Set(refreshTokens)];

    /*
     * 目标 invariant：
     *
     *   N concurrent(A) => exactly one B
     *
     * 也就是说：
     *
     *   unique replacement count === 1
     */
    expect(uniqueTokens).toHaveLength(1);

    /*
     * 当前 MemoryAuthStore 没有直接暴露 refreshTokens Map，
     * 因此通过 find() 验证所有返回 token 都是同一个持久化记录。
     */
    const records = await Promise.all(
      uniqueTokens.map((token) => h.refresh.find(token)),
    );

    expect(records).toHaveLength(1);
    expect(records[0]?.familyId).toBe(first.familyId);
    expect(records[0]?.revokedAt).toBeNull();
  });

  it('BASELINE-004：100 个并发 refresh 必须只有一个 replacement（M11 target invariant）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const results = await Promise.all(
      Array.from({ length: 100 }, () =>
        h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
      ),
    );

    const refreshTokens = results.map((result) => result.refreshToken);
    const uniqueTokens = [...new Set(refreshTokens)];

    /*
     * 这是 M11 最重要的 invariant：
     *
     *   100 concurrent requests using A
     *       =>
     *   exactly one B
     *
     * 如果当前实现产生 B/C/D/...，
     * 这个测试应该在 M11.0a 阶段失败。
     */
    expect(uniqueTokens).toHaveLength(1);
  });

  it('BASELINE-005：同一旧 token 在 grace 内重复使用不得持续产生新 token（M11 target invariant）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const firstRotation = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    const retry1 = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    const retry2 = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    const retry3 = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    /*
     * M11 正确语义：
     *
     *   A → B
     *   A(grace) → B
     *   A(grace) → B
     *   A(grace) → B
     *
     * grace 不是“旧 A 继续拥有签发权”，
     * 而是“同一客户端重新拿回已经签发的 B”。
     */
    expect(retry1.refreshToken).toBe(firstRotation.refreshToken);
    expect(retry2.refreshToken).toBe(firstRotation.refreshToken);
    expect(retry3.refreshToken).toBe(firstRotation.refreshToken);
  });

  it('BASELINE-006：grace 内所有合法 retry 都应指向同一个 family replacement', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const firstRotation = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    const retries = await Promise.all(
      Array.from({ length: 10 }, () =>
        h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
      ),
    );

    expect(
      retries.every(
        (result) =>
          result.outcome.familyId === first.familyId &&
          result.outcome.reuseDetected === false &&
          result.outcome.withinGrace === true,
      ),
    ).toBe(true);

    /*
     * M11 target：
     * 所有 retry 必须返回第一次 rotation 已经创建的 B。
     */
    expect(
      new Set(retries.map((result) => result.refreshToken)),
    ).toEqual(new Set([firstRotation.refreshToken]));
  });

  it('BASELINE-007：grace 过期后旧 token 必须进入 replay 路径', async () => {
    const h = createHarness({ refreshGraceSeconds: 0 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const rotated = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    await new Promise((resolve) => setTimeout(resolve, 20));

    await expect(
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
    ).rejects.toBeDefined();

    /*
     * 新 replacement 不应因为旧 token replay 而继续保持有效。
     */
    const replacement = await h.refresh.find(rotated.refreshToken);

    expect(replacement?.revokedAt).not.toBeNull();
  });

  it('BASELINE-008：family revoke 后旧 token 不能借 grace 返回 replacement', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const rotated = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    /*
     * 前置确认：
     * 正常情况下当前实现允许 A 在 grace 内再次 refresh。
     */
    const beforeRevoke = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    expect(beforeRevoke.outcome.withinGrace).toBe(true);

    await h.refresh.revokeFamily(first.familyId);

    await expect(
      h.refresh.rotate(first.refreshToken, '1.1.1.1', 'm11-baseline'),
    ).rejects.toBeDefined();

    await expect(
      h.refresh.rotate(rotated.refreshToken, '1.1.1.1', 'm11-baseline'),
    ).rejects.toBeDefined();
  });

  it('BASELINE-009：不同客户端上下文不能被当前 grace 机制误认为同一客户端（M11 target invariant）', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'client-A');

    await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'client-A');

    /*
     * 当前 RefreshTokenService 的公开接口只有 ip + userAgent，
     * 还没有真正的 clientId/deviceId fingerprint contract。
     *
     * 因此这里明确记录 M11 目标：
     * 不同客户端身份不能共享 A 的 grace replacement。
     *
     * 当前版本暂不把这个断言写成可通过的 production contract，
     * 避免 baseline 在 fingerprint contract 尚不存在时伪造成功。
     */
    const differentClient = await h.refresh.rotate(
      first.refreshToken,
      '2.2.2.2',
      'client-B',
    );

    /*
     * 这是一个 baseline observation：
     * 当前实现很可能仍然走 grace，而不是 replay。
     *
     * M11 完成后这里应该改成：
     *
     *   expect(...).rejects.toMatchObject({
     *     code: ErrorCode.UNAUTHORIZED,
     *   })
     *
     * 并触发 family/session revoke。
     */
    expect(differentClient.outcome.withinGrace).toBe(true);
  });

  it('BASELINE-010：refresh record 必须保持 hash-only，baseline 不允许明文 token 字段', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = seedUser(h);

    const first = await h.refresh.issue(user.id, '1.1.1.1', 'm11-baseline');

    const rotated = await h.refresh.rotate(
      first.refreshToken,
      '1.1.1.1',
      'm11-baseline',
    );

    const firstRecord = await h.refresh.find(first.refreshToken);
    const rotatedRecord = await h.refresh.find(rotated.refreshToken);

    expect(firstRecord).not.toBeNull();
    expect(rotatedRecord).not.toBeNull();

    expect(firstRecord?.tokenHash).toBe(hashToken(first.refreshToken));
    expect(rotatedRecord?.tokenHash).toBe(hashToken(rotated.refreshToken));

    expect(firstRecord?.tokenHash).not.toBe(first.refreshToken);
    expect(rotatedRecord?.tokenHash).not.toBe(rotated.refreshToken);

    /*
     * 这是对当前 hash-only 设计的保护。
     *
     * M11 增加 replacementCipher 后：
     *
     *   A.tokenHash
     *   B.tokenHash
     *   A.replacementCipher
     *
     * 仍然不能出现：
     *
     *   B.token
     */
    expect(
      Object.keys(firstRecord ?? {}).some(
        (key) =>
          key.toLowerCase().includes('plaintext') ||
          key === 'token' ||
          key === 'refreshToken',
      ),
    ).toBe(false);

    expect(
      Object.keys(rotatedRecord ?? {}).some(
        (key) =>
          key.toLowerCase().includes('plaintext') ||
          key === 'token' ||
          key === 'refreshToken',
      ),
    ).toBe(false);
  });
});