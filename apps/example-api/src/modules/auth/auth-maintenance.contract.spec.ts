/*
 * @file M11.5-final-01：/auth-maintenance/key-ring HTTP 契约测试（ADR-0024 决策 3）
 * @description 锁定运维端点响应契约（不依赖起服务）：
 *   - 响应形状与 source 枚举（KeySource 四值，禁止自由字符串）；
 *   - retirable 判据（基于「仍存在可恢复密文」计数，与 ADR-0021/0023 衔接）；
 *   - **零敏感材料**：响应整体不含 secret / cipher 密文段 / JWT / 原始配置值；
 *   - HTTP 契约：路由映射 key-ring + Cache-Control: no-store（Nest 装饰器元数据断言）。
 *   200 状态由 Nest GET 语义保证（方法不抛错即 200）；真实三方言行为由集成矩阵覆盖。
 * @author donttemo
 * @created 2026-10-16
 * @module example-api/auth
 */

import { describe, expect, it } from 'vitest';
import { JWT_CURRENT_KID, JWT_PREVIOUS_KID, MemoryAuthStore } from '@fw/auth';
import { MaintenanceController } from './maintenance.controller.js';
import { RefreshTokenService, TokenService } from '@fw/auth';

const SECRET = 'contract-secret-0123456789abcdef0123456789abcdef';

function makeController() {
  const store = new MemoryAuthStore();
  const tokens = new TokenService({
    secret: SECRET,
    accessTtlSeconds: 900,
    refreshTtlSeconds: 7 * 24 * 3600,
  });
  const refresh = new RefreshTokenService(store, tokens, 10, true);
  const user = store.seedUser({
    username: `contract-${Date.now()}`,
    phone: null,
    email: null,
    passwordHash: 'x',
    nickname: null,
    avatar: null,
    status: 1,
    lastLoginAt: null,
    lastLoginIp: null,
  });
  const jobs = {
    snapshot: () =>
      ({
        name: 'auth.refresh-cleanup',
        expression: '0 3 * * *',
        runs: 0,
        lastRunAt: null,
        lastCutoff: null,
        lastRemoved: null,
        lastCiphersCleared: null,
        lastDurationMs: null,
        lastError: null,
      }) as never,
  };
  const archiveJobs = { snapshot: () => ({}) as never };
  const controller = new MaintenanceController(
    jobs as never,
    archiveJobs as never,
    tokens,
    store,
  );
  return { controller, store, refresh, user };
}

describe('M11.5-final-01：/auth-maintenance/key-ring 契约（ADR-0024 决策 3）', () => {
  it('响应形状：jwt 稳定 kid + replacement.keys（source 枚举）+ 计数与 retirable', async () => {
    const { controller, refresh, user } = makeController();
    const first = await refresh.issue(user.id, '1.1.1.1', 'contract');
    await refresh.rotate(first.refreshToken, '1.1.1.1', 'contract');

    const snapshot = await controller.keyRing();

    // jwt 域：稳定 kid（64 bit 指纹，ADR-0024 决策 1）
    expect(snapshot.jwt.currentKid).toMatch(/^jwt-[0-9a-f]{16}$/);

    // replacement 域：legacy 模式 + keyId 齐全 + 计数与 retirable
    expect(snapshot.replacement.mode).toBe('legacy-hkdf');
    expect(snapshot.replacement.currentKeyId).toBe('replacement-v1');
    const legacyEntry = snapshot.replacement.keys.find((k) => k.keyId === 'replacement-v1');
    expect(legacyEntry?.activeReplacementCipherCount).toBe(1);
    expect(legacyEntry?.retirable).toBe(false);

    // source 枚举化（KeySource 四值，禁止自由字符串）
    const validSources = ['explicit', 'legacy-hkdf', 'jwt-secret', 'jwt-secret-prev'];
    expect(validSources).toContain(snapshot.jwt.source);
    for (const key of snapshot.replacement.keys) {
      expect(validSources).toContain(key.source);
    }
  });

  it('retirable 判据：cipher 清理（ADR-0021）后该 keyId 计数归零 → retirable=true', async () => {
    const { controller, store, refresh, user } = makeController();
    const first = await refresh.issue(user.id, '1.1.1.1', 'contract');
    await refresh.rotate(first.refreshToken, '1.1.1.1', 'contract');
    const before = await controller.keyRing();
    const entryBefore = before.replacement.keys.find((k) => k.keyId === 'replacement-v1');
    expect(entryBefore?.activeReplacementCipherCount).toBe(1);
    expect(entryBefore?.retirable).toBe(false);

    // grace 级清空（ADR-0021）：cipher 三列置 NULL → 判据归零 → retirable 翻转
    await refresh.cleanupReplacements(new Date(Date.now() + 60_000));
    const after = await controller.keyRing();
    const entryAfter = after.replacement.keys.find((k) => k.keyId === 'replacement-v1');
    expect(entryAfter?.activeReplacementCipherCount).toBe(0);
    expect(entryAfter?.retirable).toBe(true);
  });

  it('零敏感材料：响应序列化后不含 secret / cipher 密文段 / JWT / 原始配置值', async () => {
    const { controller, refresh, user } = makeController();
    const first = await refresh.issue(user.id, '1.1.1.1', 'contract');
    await refresh.rotate(first.refreshToken, '1.1.1.1', 'contract');

    const snapshot = await controller.keyRing();
    const serialized = JSON.stringify(snapshot);

    expect(serialized).not.toContain(SECRET); // secret 本体
    expect(serialized).not.toMatch(/v1:replacement/); // cipher 密文段格式
    expect(serialized).not.toContain('eyJ'); // JWT 前缀（无 token 泄露）
    expect(serialized).not.toContain('tokenHash'); // 令牌哈希字段
  });

  it('HTTP 契约元数据：路由映射 key-ring + GET + Cache-Control: no-store（装饰器元数据断言）', () => {
    const methodMeta = MaintenanceController.prototype.keyRing;
    // Nest 装饰器元数据实际形态（path/method/自研 __headers__ 封装）
    expect(Reflect.getMetadata('path', methodMeta)).toBe('key-ring');
    expect(Reflect.getMetadata('method', methodMeta)).toBe(0); // RequestMethod.GET
    const headers = Reflect.getMetadata('__headers__', methodMeta) as Array<{ name: string; value: string }>;
    expect(headers).toContainEqual({ name: 'Cache-Control', value: 'no-store' });
    // @Public() 在类级（与 refresh-cleanup/audit-archive 先例一致），无需重复断言权限面
    void JWT_CURRENT_KID;
    void JWT_PREVIOUS_KID;
  });
});
