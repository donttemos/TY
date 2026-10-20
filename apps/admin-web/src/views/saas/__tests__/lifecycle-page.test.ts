/*
 * @file 生命周期页 M14 正确性修复回归护栏（PRD-014 FR-14-01/02/03，AC-14-01/02/03 前端侧）
 * @description 钉住三处修复，防回退：① 操作原因必须从确认框接收并透传 API（U-14-1：prompt 返回值
 *   曾被丢弃、原因从未落库）；② 只读角色不渲染动作行（U-14-2：写按钮曾无 v-permission）；
 *   ③ 按钮按后端 allowedActions 真实状态禁用 + 无状态空态（U-14-3：曾从日志推导、六按钮全可点）；
 *   ④ 路由 `?tenantId=` 初始化（深链自动加载状态与历史、无参零请求、前进/后退跟随）。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 M14 跨页闭环：mount 挂 memory router，补深链自动加载与前进/后退用例。
 * @module admin-web/views
*/

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/saas', () => ({
  fetchTenantLifecycleStatus: vi.fn(),
  fetchLifecycleLogs: vi.fn(),
  transitionLifecycle: vi.fn(),
}));
vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));
vi.mock('element-plus', async (importOriginal) => {
  const actual = await importOriginal<typeof import('element-plus')>();
  return { ...actual, default: actual.default, ElMessageBox: { ...actual.ElMessageBox, prompt: vi.fn() } };
});

import ElementPlus from 'element-plus';
import * as saasApi from '@/api/saas';
import { fetchTenants } from '@/api/tenant';
import { ElMessageBox } from 'element-plus';
import { useUserStore } from '@/store/user';
import { permission } from '@/directives/permission';
import TenantPicker from '@/components/TenantPicker/index.vue';
import type { MeResult } from '@/api/types';
import Lifecycle from '@/views/saas/lifecycle/index.vue';

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

/** 找文本匹配的操作按钮 */
function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((b) => b.text().trim() === text);
}

/** 页面依赖 useRoute（useTenantQuery）：挂 memory router，push 即模拟深链/前进后退 */
function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/saas/lifecycle', name: 'SaasLifecycle', component: { template: '<div />' } }],
  });
}

describe('生命周期页（M14 B1 正确性护栏）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(saasApi.fetchTenantLifecycleStatus).mockResolvedValue({ status: 'active', allowedActions: ['expire', 'freeze', 'terminate'] });
    vi.mocked(saasApi.fetchLifecycleLogs).mockResolvedValue([]);
    vi.mocked(saasApi.transitionLifecycle).mockResolvedValue({ from: 'active', to: 'frozen', alreadyApplied: false });
    vi.mocked(fetchTenants).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
  });

  async function mountAndLoad(codes: string[], query: Record<string, string> = {}) {
    setPermissions(codes);
    const router = buildRouter();
    await router.push({ path: '/saas/lifecycle', query });
    await router.isReady();
    const wrapper = mount(Lifecycle, {
      global: { plugins: [ElementPlus, router], directives: { permission } },
    });
    await flushPromises();
    // B3：租户输入换 TenantPicker —— 通过 v-model emit 选中租户
    wrapper.findComponent(TenantPicker).vm.$emit('update:modelValue', 't1');
    await flushPromises();
    await findButton(wrapper, '加载状态与历史')!.trigger('click');
    await flushPromises();
    return { wrapper, router };
  }

  it('真实状态驱动：active 租户允许按钮可点、非法动作禁用并显示状态（FR-14-03）', async () => {
    const { wrapper } = await mountAndLoad(['ops:saas:read', 'ops:saas:write']);

    expect(saasApi.fetchTenantLifecycleStatus).toHaveBeenCalledWith('t1');
    expect(wrapper.text()).toContain('当前状态：active');

    const freeze = findButton(wrapper, '冻结')!;
    expect(freeze.attributes('disabled')).toBeUndefined();

    const activate = findButton(wrapper, '开通')!;
    expect(activate.attributes('disabled')).toBeDefined();
    expect(activate.attributes('title')).toContain('不允许该动作');
  });

  it('深链 ?tenantId=：首屏自动加载状态与历史（无需点「加载」）', async () => {
    setPermissions(['ops:saas:read', 'ops:saas:write']);
    const router = buildRouter();
    await router.push({ path: '/saas/lifecycle', query: { tenantId: 't1' } });
    await router.isReady();
    const wrapper = mount(Lifecycle, { global: { plugins: [ElementPlus, router], directives: { permission } } });
    await flushPromises();

    expect(saasApi.fetchTenantLifecycleStatus).toHaveBeenCalledWith('t1');
    expect(saasApi.fetchLifecycleLogs).toHaveBeenCalledWith('t1');
    expect(wrapper.findComponent(TenantPicker).props('modelValue')).toBe('t1');
    expect(wrapper.text()).toContain('当前状态：active');
  });

  it('无 tenantId 参数：不发起租户级请求；前进/后退跟随', async () => {
    setPermissions(['ops:saas:read']);
    const router = buildRouter();
    await router.push({ path: '/saas/lifecycle' });
    await router.isReady();
    const wrapper = mount(Lifecycle, { global: { plugins: [ElementPlus, router], directives: { permission } } });
    await flushPromises();
    expect(saasApi.fetchTenantLifecycleStatus).not.toHaveBeenCalled();

    await router.push({ path: '/saas/lifecycle', query: { tenantId: 't9' } });
    await flushPromises();
    expect(saasApi.fetchTenantLifecycleStatus).toHaveBeenCalledWith('t9');
    expect(wrapper.text()).toContain('当前状态：active');

    // 回退到无参：只复位、不再发请求（页面回到「无租户」空态）
    const before = vi.mocked(saasApi.fetchTenantLifecycleStatus).mock.calls.length;
    await router.go(-1);
    await flushPromises();
    expect(vi.mocked(saasApi.fetchTenantLifecycleStatus).mock.calls.length).toBe(before);
    expect(wrapper.text()).toContain('无迁移历史');
  });

  it('清空已选租户：状态与历史立即复位且不发请求', async () => {
    const { wrapper } = await mountAndLoad(['ops:saas:read', 'ops:saas:write']);
    expect(wrapper.text()).toContain('当前状态：active');

    const before = vi.mocked(saasApi.fetchTenantLifecycleStatus).mock.calls.length;
    wrapper.findComponent(TenantPicker).vm.$emit('update:modelValue', '');
    await flushPromises();

    expect(wrapper.text()).not.toContain('当前状态：active');
    expect(wrapper.text()).toContain('无迁移历史');
    expect(vi.mocked(saasApi.fetchTenantLifecycleStatus).mock.calls.length).toBe(before);
  });

  it('操作原因端到端：确认框输入的原因 trim 后传给 API（FR-14-01，AC-14-01 前端断言）', async () => {
    vi.mocked(ElMessageBox.prompt).mockResolvedValue({ value: '  违规操作  ' } as never);
    const { wrapper } = await mountAndLoad(['ops:saas:read', 'ops:saas:write']);

    await findButton(wrapper, '冻结')!.trigger('click');
    await flushPromises();

    expect(ElMessageBox.prompt).toHaveBeenCalledTimes(1);
    expect(saasApi.transitionLifecycle).toHaveBeenCalledWith('t1', 'freeze', '违规操作');
    // 成功后重载状态与历史
    expect(saasApi.fetchTenantLifecycleStatus).toHaveBeenCalledTimes(2);
  });

  it('只读角色不渲染动作行（FR-14-02，AC-14-02 前端断言）', async () => {
    const { wrapper } = await mountAndLoad(['ops:saas:read']);

    expect(wrapper.text()).toContain('当前状态：active');
    expect(findButton(wrapper, '冻结')).toBeUndefined();
    expect(findButton(wrapper, '终止')).toBeUndefined();
  });

  it('无状态租户：空态提示且全部动作禁用（FR-14-03/04）', async () => {
    vi.mocked(saasApi.fetchTenantLifecycleStatus).mockResolvedValue({ status: null, allowedActions: [] });
    const { wrapper } = await mountAndLoad(['ops:saas:read', 'ops:saas:write']);

    expect(wrapper.text()).toContain('未查询到租户生命周期状态');
    expect(findButton(wrapper, '开通')!.attributes('disabled')).toBeDefined();
    expect(findButton(wrapper, '恢复')!.attributes('disabled')).toBeDefined();
  });
});
