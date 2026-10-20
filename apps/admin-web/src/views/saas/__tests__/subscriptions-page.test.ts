/*
 * @file 订阅页产品化回归（M14/PRD-014 FR-14-10）
 * @description 钉住：① 全局列表加载与 planCode/planVersion 补全展示；② TenantPicker 联动筛选；
 *   ③ 取消走 confirmWithReason 统一入口——原因端到端透传（null 取消不执行）；
 *   ④ 租户上下文路由初始化（`?tenantId=` 直达即按该租户筛选 + 选择器回填，前进/后退跟随）。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 M14 跨页闭环：mount 挂 memory router，补路由参数初始化与前进/后退用例。
 * @module admin-web/views
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/saas', () => ({
  fetchSubscriptions: vi.fn(),
  fetchTenantSubscriptionHistory: vi.fn(),
  cancelSubscription: vi.fn(),
  createSubscription: vi.fn(),
  fetchPlans: vi.fn(),
  fetchTenantLifecycleStatus: vi.fn(),
  fetchLifecycleLogs: vi.fn(),
}));
vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));
vi.mock('@/components/ConfirmWithReason', () => ({ confirmWithReason: vi.fn() }));

import ElementPlus from 'element-plus';
import * as saasApi from '@/api/saas';
import { fetchTenants } from '@/api/tenant';
import { confirmWithReason } from '@/components/ConfirmWithReason';
import TenantPicker from '@/components/TenantPicker/index.vue';
import { permission } from '@/directives/permission';
import { useUserStore } from '@/store/user';
import type { MeResult } from '@/api/types';
import Subscriptions from '@/views/saas/subscriptions/index.vue';

const row = {
  id: 'sub-1', tenantId: 't1', planId: 'plan-1', planVersionId: 'pv-1', status: 'active' as const,
  effectiveAt: '2026-10-19T00:00:00.000Z', expireAt: null, closedAt: null, reason: null,
  planCode: 'default', planName: '基础版', planVersion: 2,
};

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

/** 页面依赖 useRoute（useTenantQuery）：挂 memory router，push 即模拟深链/前进后退 */
function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/saas/subscriptions', name: 'SaasSubscriptions', component: { template: '<div />' } }],
  });
}

async function mountPage(codes = ['ops:saas:read', 'ops:saas:write'], query: Record<string, string> = {}) {
  setPermissions(codes);
  const router = buildRouter();
  await router.push({ path: '/saas/subscriptions', query });
  await router.isReady();
  const wrapper = mount(Subscriptions, { global: { plugins: [ElementPlus, router], directives: { permission } } });
  await flushPromises();
  return { wrapper, router };
}

describe('订阅页（M14 B3 全局列表优先视图）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchTenants).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    vi.mocked(saasApi.fetchSubscriptions).mockResolvedValue({ items: [row], total: 1, page: 1, pageSize: 20 });
    vi.mocked(saasApi.fetchPlans).mockResolvedValue([{ id: 'plan-1', code: 'default', name: '基础版', description: null }]);
    vi.mocked(saasApi.fetchTenantSubscriptionHistory).mockResolvedValue([row]);
  });

  it('列表加载 + planCode/planVersion 补全展示', async () => {
    const { wrapper } = await mountPage();
    expect(saasApi.fetchSubscriptions).toHaveBeenCalledWith({ page: 1, pageSize: 20, tenantId: undefined, planCode: undefined, status: undefined });
    expect(wrapper.text()).toContain('default');
    expect(wrapper.text()).toContain('v2');
  });

  it('深链 ?tenantId=：首屏即按该租户筛选，选择器同步回填', async () => {
    const { wrapper } = await mountPage(undefined, { tenantId: 't1' });
    // 只发一次（不叠加默认全局列表请求）
    expect(saasApi.fetchSubscriptions).toHaveBeenCalledTimes(1);
    expect(saasApi.fetchSubscriptions).toHaveBeenCalledWith({ page: 1, pageSize: 20, tenantId: 't1', planCode: undefined, status: undefined });
    expect(wrapper.findComponent(TenantPicker).props('modelValue')).toBe('t1');
  });

  it('浏览器前进/后退改变 tenantId：同实例跟随重查', async () => {
    const { router } = await mountPage(undefined, { tenantId: 't1' });
    await router.push({ path: '/saas/subscriptions', query: { tenantId: 't2' } });
    await flushPromises();
    expect(saasApi.fetchSubscriptions).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, tenantId: 't2', planCode: undefined, status: undefined });

    await router.go(-1);
    await flushPromises();
    expect(saasApi.fetchSubscriptions).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, tenantId: 't1', planCode: undefined, status: undefined });
  });

  it('TenantPicker 联动：选中租户即带 tenantId 重新查询', async () => {
    const { wrapper } = await mountPage();
    wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', 't1');
    await flushPromises();
    expect(saasApi.fetchSubscriptions).toHaveBeenLastCalledWith({ page: 1, pageSize: 20, tenantId: 't1', planCode: undefined, status: undefined });
  });

  it('取消订阅：confirmWithReason 原因透传 API（AC-14-01 前端断言）', async () => {
    vi.mocked(confirmWithReason).mockResolvedValue('客户要求解约'); // 统一入口已 trim
    vi.mocked(saasApi.cancelSubscription).mockResolvedValue({ id: 'sub-1', cancelled: true });
    const { wrapper } = await mountPage();
    const cancelBtn = wrapper.findAll('button').find((b) => b.text().includes('取消'));
    await cancelBtn!.trigger('click');
    await flushPromises();
    expect(confirmWithReason).toHaveBeenCalledTimes(1);
    expect(saasApi.cancelSubscription).toHaveBeenCalledWith('sub-1', '客户要求解约');
  });

  it('取消订阅：用户取消（confirmWithReason 返回 null）不调 API', async () => {
    vi.mocked(confirmWithReason).mockResolvedValue(null);
    const { wrapper } = await mountPage();
    const cancelBtn = wrapper.findAll('button').find((b) => b.text().includes('取消'));
    await cancelBtn!.trigger('click');
    await flushPromises();
    expect(saasApi.cancelSubscription).not.toHaveBeenCalled();
  });

  it('只读角色：取消按钮不渲染（v-permission）', async () => {
    const { wrapper } = await mountPage(['ops:saas:read']);
    expect(wrapper.findAll('button').some((b) => b.text().includes('取消'))).toBe(false);
  });
});
