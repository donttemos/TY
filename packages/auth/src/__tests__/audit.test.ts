/*
 * @file 审计日志与脱敏单测
 * @description 覆盖 TC-AUTH-011（记录操作人/前后值且敏感字段脱敏）、异步落盘不阻塞主流程、
 *   落盘失败降级为日志兜底不抛错、审计分页查询过滤
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { AuditService, sanitizeForAudit } from '../audit.service.js';
import type { AuthStore } from '../auth-store.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import { MASKED } from '../constants.js';
import { flushAsync } from './test-helpers.js';

describe('sanitizeForAudit', () => {
  it('按字段名遮蔽敏感字段（含嵌套与大小写变体）', () => {
    const result = sanitizeForAudit({
      username: 'alice',
      password: 'plain',
      PasswordHash: 'hash',
      nested: { oldPassword: 'o', refreshToken: 'r', keep: 1 },
      list: [{ token: 't', name: 'n' }],
    }) as Record<string, unknown>;
    expect(result.username).toBe('alice');
    expect(result.password).toBe(MASKED);
    expect(result.PasswordHash).toBe(MASKED);
    const nested = result.nested as Record<string, unknown>;
    expect(nested.oldPassword).toBe(MASKED);
    expect(nested.refreshToken).toBe(MASKED);
    expect(nested.keep).toBe(1);
    expect(((result.list as Record<string, unknown>[])[0]).token).toBe(MASKED);
  });

  it('Date → ISO，bigint / function 转为可序列化值，超深对象截断', () => {
    const date = new Date('2026-10-13T00:00:00.000Z');
    expect(sanitizeForAudit(date)).toBe('2026-10-13T00:00:00.000Z');
    expect(sanitizeForAudit(10n)).toBe('10');
    expect(sanitizeForAudit(() => 1)).toBe('[function]');
    let deep: unknown = 'bottom';
    for (let i = 0; i < 10; i += 1) deep = { next: deep };
    expect(JSON.stringify(sanitizeForAudit(deep))).toContain('[too-deep]');
    expect(sanitizeForAudit(null)).toBeNull();
    expect(sanitizeForAudit(undefined)).toBeUndefined();
  });
});

describe('AuditService', () => {
  it('TC-AUTH-011：完整还原一次「改单」的操作人、动作与前后值（敏感字段脱敏）', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordSync({
      userId: 'u-1',
      module: 'order',
      action: 'update',
      targetType: 'order',
      targetId: 'o-9',
      before: { status: 'pending', password: 'p' },
      after: { status: 'paid', password: 'p' },
      ip: '10.0.0.1',
      userAgent: 'jest',
    });

    const page = await audit.page({ page: 1, pageSize: 10, userId: 'u-1' });
    expect(page.total).toBe(1);
    const record = page.items[0];
    expect(record.module).toBe('order');
    expect(record.action).toBe('update');
    expect(record.targetId).toBe('o-9');
    expect((record.beforeValue as Record<string, unknown>).status).toBe('pending');
    expect((record.afterValue as Record<string, unknown>).status).toBe('paid');
    expect((record.beforeValue as Record<string, unknown>).password).toBe(MASKED);
    expect(record.ip).toBe('10.0.0.1');
    expect(record.createdAt).toBeInstanceOf(Date);
  });

  it('record 为异步落盘：不阻塞调用方，且落盘失败只降级不抛错', async () => {
    const failing = {
      writeAuditLog: async () => {
        throw new Error('db down');
      },
    } as unknown as AuthStore;
    const audit = new AuditService(failing);
    // 不抛错、立即返回
    expect(() => audit.record({ module: 'm', action: 'create' })).not.toThrow();
    await flushAsync();
    // 同步等待版本依然失败（调用方可自行决定是否容忍）
    await expect(audit.recordSync({ module: 'm', action: 'create' })).rejects.toThrow('db down');
  });

  it('分页查询支持按模块 / 动作 / 对象 / 时间过滤，按时间倒序', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    const base = new Date('2026-10-13T10:00:00.000Z');
    await store.writeAuditLog({
      userId: 'u1',
      module: 'auth',
      action: 'login',
      category: 'auth',
      event: 'auth.login',
      result: 'success',
      familyId: null,
      jti: null,
      requestId: null,
      targetType: 'user',
      targetId: 'u1',
      beforeValue: null,
      afterValue: null,
      ip: null,
      userAgent: null,
      traceId: null,
      createdAt: base,
    });
    await store.writeAuditLog({
      userId: 'u1',
      module: 'order',
      action: 'delete',
      category: 'data',
      event: 'order.delete',
      result: 'success',
      familyId: null,
      jti: null,
      requestId: null,
      targetType: 'order',
      targetId: 'o1',
      beforeValue: null,
      afterValue: null,
      ip: null,
      userAgent: null,
      traceId: null,
      createdAt: new Date(base.getTime() + 60_000),
    });

    expect((await audit.page({ page: 1, pageSize: 10, module: 'order' })).total).toBe(1);
    expect((await audit.page({ page: 1, pageSize: 10, action: 'login' })).total).toBe(1);
    expect((await audit.page({ page: 1, pageSize: 10, targetType: 'order', targetId: 'o1' })).total).toBe(1);
    expect((await audit.page({ page: 1, pageSize: 10, from: new Date(base.getTime() + 30_000) })).total).toBe(1);
    const all = await audit.page({ page: 1, pageSize: 10 });
    expect(all.items[0].module).toBe('order');
    expect(all.hasMore).toBe(false);
  });
});
