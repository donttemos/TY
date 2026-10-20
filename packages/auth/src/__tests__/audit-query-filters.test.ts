/*
 * @file 审计检索面扩展契约（PRD-012 OBS-14）
 * @description MemoryAuthStore 与 PrismaAuthStore 同语义验证：按 traceId / requestId / familyId /
 *   category / event 精确过滤可组合；未知过滤字段在 HTTP 层 400（由控制器 assertKnownFilterParams
 *   收敛，此处锁定存储层过滤语义与组合查询）。
 *   P1 越权修复配套：数据范围注入的 userIds（org / org_below 部门成员）必须收敛而非被忽略。
 * @author donttemo
 * @created 2026-10-17
 * @modified 2026-10-21 donttemo P1：补 userIds 归属人集合收敛用例（此前内存实现只认单个 userId）
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

  it('userIds 归属人集合收敛（org / org_below 注入）：空集合 fail-closed，与 userId 取交集', async () => {
    const store = new MemoryAuthStore();
    await store.writeAuditLog(baseRow({ userId: 'u-1' }));
    await store.writeAuditLog(baseRow({ userId: 'u-2' }));
    await store.writeAuditLog(baseRow({ userId: 'u-3' }));
    // 系统任务记录（userId = null）在任何按人收敛的集合之外
    await store.writeAuditLog(baseRow({ userId: null }));

    const scoped = await store.pageAuditLogs({ page: 1, pageSize: 10, userIds: ['u-1', 'u-2'] });
    expect(scoped.items.map((row) => row.userId).sort()).toEqual(['u-1', 'u-2']);

    // 空集合 = 无任何可见归属人（绝不退化为全量）
    expect((await store.pageAuditLogs({ page: 1, pageSize: 10, userIds: [] })).total).toBe(0);

    // userId 与 userIds 同时传入取交集
    const intersected = await store.pageAuditLogs({ page: 1, pageSize: 10, userId: 'u-2', userIds: ['u-1', 'u-2'] });
    expect(intersected.items.map((row) => row.userId)).toEqual(['u-2']);
    expect((await store.pageAuditLogs({ page: 1, pageSize: 10, userId: 'u-3', userIds: ['u-1', 'u-2'] })).total).toBe(0);
  });
});
