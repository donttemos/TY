/*
 * @file 审计事件零敏感材料契约（PRD-012 OBS-08，ADR-0025 §2.4 / ADR-0024 口径延伸）
 * @description 反向验证：replay 安全事件的审计行序列化后不含 token 明文 / secret / cipher 密文段——
 *   审计行可承载 jti（令牌标识，非令牌本体，ADR-0025 安全论证），但任何令牌本体材料不得落入
 *   audit_logs（日志/审计/响应永不含 token 明文、secret、cipher 段）。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '@fw/logger';
import { createHarness } from './test-helpers.js';

describe('M12 W1 · 审计事件零敏感材料（OBS-08 反向验证）', () => {
  it('replay 审计行序列化不含 refresh token 明文 / replacement 令牌 / cipher 段', async () => {
    const h = createHarness({ refreshGraceSeconds: 10 });
    const user = h.store.seedUser({
      username: 'no-secrets',
      phone: null,
      email: null,
      passwordHash: 'unit-test-hash',
      nickname: 'no-secrets',
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const first = await h.refresh.issue(user.id, '1.1.1.1', 'device-1');
    const second = await h.refresh.rotate(first.refreshToken, '1.1.1.1', 'device-1');

    // 重放旧令牌（指纹不匹配路径，携带最丰富的上下文）
    await expect(
      runWithRequestContext({ traceId: 'trace-no-secrets', spanId: '' }, () =>
        h.refresh.rotate(first.refreshToken, '3.3.3.3', 'device-2'),
      ),
    ).rejects.toMatchObject({ code: 3001 });

    const audits = await h.store.pageAuditLogs({ page: 1, pageSize: 10, action: 'security' });
    expect(audits.total).toBe(1);
    const row = audits.items[0]!;
    const serialized = JSON.stringify(row);

    // 令牌本体（旧 refresh token 与轮换后的 replacement）绝不上审计行
    expect(serialized, '旧 refresh token 明文不得出现在审计行').not.toContain(first.refreshToken);
    expect(serialized, 'replacement 令牌明文不得出现在审计行').not.toContain(second.refreshToken);
    // cipher 密文段格式（replacement 密文 v1:<keyId>:<iv>:<data>:<tag>）不得出现
    expect(serialized).not.toMatch(/v1:[A-Za-z0-9_-]+:/);
    // jti（令牌标识）按契约允许出现——显式断言防止未来误把「jti 可记」升级成「token 可记」
    expect(row.jti).toBeTruthy();
  });
});
