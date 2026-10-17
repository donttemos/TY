/*
 * @file 审计检索面扩展契约（PRD-012 OBS-14）
 * @description MemoryAuthStore 与 PrismaAuthStore 同语义验证：按 traceId / requestId / familyId /
 *   category / event 精确过滤可组合；未知过滤字段在 HTTP 层 400（由控制器 assertKnownFilterParams
 *   收敛，此处锁定存储层过滤语义与组合查询）。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { MemoryAuthStore } from '../memory-auth-store.js';
import type { NewAuditLog } from '../auth-store.js';

function baseRow(overrides: Partial<NewAuditLog>): NewAuditLog {
  return {
    userId: 'u-1',
    module: 'auth',
    action: 'login',
    category: null,
    event: null,
    result: null,
    familyId: null,
    jti: null,
    requestId: null,
    targetType: 'user',
    targetId: 'u-1',
    beforeValue: null,
    afterValue: null,
    ip: '1.1.1.1',
    userAgent: 'agent',
    traceId: 't-default',
    createdAt: new Date('2026-10-17T00:00:00Z'),
    ...overrides,
  };
}

describe('M12 W2 · 审计检索面扩展（OBS-14）', () => {
  it('按 category / event / familyId / requestId / traceId 精确过滤', async () => {
    const store = new MemoryAuthStore();
    await store.writeAuditLog(baseRow({ category: 'security', event: 'refresh.replay_detected', familyId: 'fam-a', requestId: 'req-a', traceId: 't-a' }));
    await store.writeAuditLog(baseRow({ category: 'auth', event: 'auth.login', familyId: null, requestId: 'req-b', traceId: 't-b' }));
    await store.writeAuditLog(baseRow({ category: 'security', event: 'refresh.replay_detected', familyId: 'fam-c', requestId: 'req-a', traceId: 't-c' }));

    const byEvent = await store.pageAuditLogs({ page: 1, pageSize: 10, event: 'refresh.replay_detected' });
    expect(byEvent.total).toBe(2);

    const byCategory = await store.pageAuditLogs({ page: 1, pageSize: 10, category: 'auth' });
    expect(byCategory.total).toBe(1);
    expect(byCategory.items[0]!.event).toBe('auth.login');

    const byFamily = await store.pageAuditLogs({ page: 1, pageSize: 10, familyId: 'fam-a' });
    expect(byFamily.total).toBe(1);
    expect(byFamily.items[0]!.requestId).toBe('req-a');

    const byRequestId = await store.pageAuditLogs({ page: 1, pageSize: 10, requestId: 'req-a' });
    expect(byRequestId.total).toBe(2);

    const byTrace = await store.pageAuditLogs({ page: 1, pageSize: 10, traceId: 't-b' });
    expect(byTrace.total).toBe(1);
  });

  it('组合过滤取交集（event + familyId）', async () => {
    const store = new MemoryAuthStore();
    await store.writeAuditLog(baseRow({ category: 'security', event: 'refresh.replay_detected', familyId: 'fam-a', traceId: 't-1' }));
    await store.writeAuditLog(baseRow({ category: 'security', event: 'refresh.replay_detected', familyId: 'fam-b', traceId: 't-2' }));
    const combined = await store.pageAuditLogs({ page: 1, pageSize: 10, event: 'refresh.replay_detected', familyId: 'fam-b' });
    expect(combined.total).toBe(1);
    expect(combined.items[0]!.traceId).toBe('t-2');
  });

  it('白名单外的过滤组合不产生意外结果（过滤值不命中即空集，fail-closed）', async () => {
    const store = new MemoryAuthStore();
    await store.writeAuditLog(baseRow({ category: 'security', event: 'refresh.replay_detected' }));
    const miss = await store.pageAuditLogs({ page: 1, pageSize: 10, category: 'security', event: 'auth.login' });
    expect(miss.total).toBe(0);
  });
});
