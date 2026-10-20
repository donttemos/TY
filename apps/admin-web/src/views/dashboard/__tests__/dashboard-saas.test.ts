/*
 * @file 工作台 SaaS 运营卡区回归（M14/PRD-014 FR-14-14）
 * @description 钉住：① 无 ops:saas:read → 不发请求、卡区不渲染（不刷 403 范式）；② 有权限 →
 *   五态计数/即将到期/配额风险/最近迁移四块渲染且可点跳转；③ 取数失败 → 降级文案而非 0。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/views
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/user', () => ({ fetchUsers: vi.fn() }));
vi.mock('@/api/role', () => ({ fetchRoles: vi.fn(), fetchPermissionGroups: vi.fn() }));
vi.mock('@/api/audit', () => ({ fetchAuditLogs: vi.fn() }));
vi.mock('@/api/saas', () => ({ fetchOpsOverview: vi.fn() }));

import ElementPlus from 'element-plus';
import { fetchOpsOverview } from '@/api/saas';
import type { OpsOverview } from '@/api/saas';
import { useUserStore } from '@/store/user';
import type { MeResult } from '@/api/types';
import Dashboard from '@/views/dashboard/index.vue';

const overview: OpsOverview = {
  quotaRisks: [{ tenantId: 't1', quotaKey: 'api_calls', windowType: 'day', windowStart: '2026-10-20T00:00:00.000Z', used: '95', limitValue: '100', ratio: 95 }],
  expiringSubscriptions: [{ subscriptionId: 's1', tenantId: 't9', expireAt: new Date(Date.now() + 3 * 86_400_000).toISOString() }],
  tenantCounts: { pending: 0, active: 5, grace: 1, frozen: 2, terminated: 3 },
  recentTransitions: [{ tenantId: 't1', fromStatus: 'active', toStatus: 'frozen', action: 'freeze', actorType: 'user', actorId: 'u1', reason: '测试冻结', ip: null, userAgent: null, traceId: null, requestId: null, createdAt: new Date().toISOString() }],
};

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

describe('工作台 SaaS 运营卡区（FR-14-14）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchOpsOverview).mockResolvedValue(overview);
  });

  it('无 ops:saas:read：不发请求、不渲染卡区（403 范式）', async () => {
    setPermissions(['user:read']);
    const wrapper = mount(Dashboard, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(fetchOpsOverview).not.toHaveBeenCalled();
    expect(wrapper.text()).not.toContain('SaaS 运营');
  });

  it('有 ops:saas:read：五态计数/到期/风险/迁移渲染 + 请求一次', async () => {
    setPermissions(['ops:saas:read']);
    const wrapper = mount(Dashboard, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(fetchOpsOverview).toHaveBeenCalledTimes(1);
    const text = wrapper.text();
    expect(text).toContain('SaaS 运营');
    expect(text).toContain('即将到期订阅');
    expect(text).toContain('配额风险');
    expect(text).toContain('最近生命周期变更');
    expect(text).toContain('t9'); // 到期租户
    expect(text).toContain('3 天'); // 剩余天数
    expect(text).toContain('api_calls'); // 风险指标
  });

  it('取数失败：降级文案，不用 0 冒充状态', async () => {
    vi.mocked(fetchOpsOverview).mockRejectedValue(new Error('boom'));
    setPermissions(['ops:saas:read']);
    const wrapper = mount(Dashboard, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper.text()).toContain('运营总览取数失败');
    expect(wrapper.text()).not.toContain('即将到期订阅');
  });

  it('常用入口：SaaS 三项按权限过滤（无权限不出现死入口）', async () => {
    setPermissions(['user:read']);
    const wrapper = mount(Dashboard, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper.text()).toContain('用户管理');
    expect(wrapper.text()).not.toContain('套餐管理');

    setPermissions(['user:read', 'ops:saas:read']);
    const wrapper2 = mount(Dashboard, { global: { plugins: [ElementPlus] } });
    await flushPromises();
    expect(wrapper2.text()).toContain('套餐管理');
    expect(wrapper2.text()).toContain('租户生命周期');
  });
});
