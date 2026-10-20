/*
 * @file 审计事件注册表消费单测（PRD-015 FR-15-01/16，ADR-0032 R1）
 * @description 锁定前端只消费服务端下发的注册表：
 *   ① 并发/重复 load 只发一次请求（模块级缓存）；
 *   ② 按风险取事件集合（用于 `event=a,b` 展开筛选）；
 *   ③ 注册表不可用时降级——不抛错、保留页面可用，且下次 load 会重试。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/composables
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAuditEvents } from '@/api/audit';
import { resetAuditEventsCache, useAuditEvents } from '../useAuditEvents';

vi.mock('@/api/audit', () => ({ fetchAuditEvents: vi.fn() }));

const registry = {
  version: 'v1',
  items: [
    { code: 'auth.login', name: '登录成功', category: 'auth', risk: 'low' as const },
    { code: 'saas.lifecycle.freeze', name: '冻结租户', category: 'tenant', risk: 'high' as const },
    { code: 'authz.denied', name: '权限不足被拒绝', category: 'security', risk: 'notice' as const },
    { code: 'legacy.retired.event', name: '已废弃事件', category: 'system', risk: 'low' as const, deprecated: { since: '2026-10-01' } },
  ],
};

describe('useAuditEvents', () => {
  beforeEach(() => {
    resetAuditEventsCache();
    vi.mocked(fetchAuditEvents).mockReset();
  });

  it('首次 load 拉取并缓存；并发与重复 load 不重复请求', async () => {
    vi.mocked(fetchAuditEvents).mockResolvedValue(structuredClone(registry));
    const api = useAuditEvents();

    await Promise.all([api.load(), api.load()]);
    await api.load();

    expect(fetchAuditEvents).toHaveBeenCalledTimes(1);
    expect(api.version.value).toBe('v1');
    expect(api.items.value).toHaveLength(4);
  });

  it('find 命中/未命中；codesByRisk 排除 deprecated；eventOptions 不含废弃项', async () => {
    vi.mocked(fetchAuditEvents).mockResolvedValue(structuredClone(registry));
    const api = useAuditEvents();
    await api.load();

    expect(api.find('saas.lifecycle.freeze')?.name).toBe('冻结租户');
    expect(api.find('not.exists') ).toBeUndefined();
    expect(api.find(null)).toBeUndefined();

    expect(api.codesByRisk('high')).toEqual(['saas.lifecycle.freeze']);
    expect(api.codesByRisk('low')).toEqual(['auth.login']); // 废弃项不计入
    expect(api.eventOptions.value.map((option) => option.value)).not.toContain('legacy.retired.event');
    expect(api.eventOptions.value.find((option) => option.value === 'auth.login')?.label).toBe('登录成功');
  });

  it('注册表不可用：不抛错、标记 failed，下次 load 重试', async () => {
    vi.mocked(fetchAuditEvents).mockRejectedValueOnce(new Error('network down'));
    const api = useAuditEvents();

    await expect(api.load()).resolves.toBeUndefined();
    expect(api.failed.value).toBe(true);
    expect(api.items.value).toHaveLength(0);

    vi.mocked(fetchAuditEvents).mockResolvedValueOnce(structuredClone(registry));
    await api.load();
    expect(api.items.value).toHaveLength(4);
    expect(api.failed.value).toBe(false);
  });
});
