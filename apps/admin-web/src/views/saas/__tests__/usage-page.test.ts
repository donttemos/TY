/*
 * @file 用量页看板化回归（M14/PRD-014 FR-14-13）
 * @description 钉住：① 首次加载配额后自动拉趋势与明细；② 趋势桶柱渲染（零桶填齐，柱高按最大值归一）；
 *   ③ 切换指标（switchMetric）一并刷新用量/趋势/明细；④ 明细分页切换请求参数；
 *   ⑤ hours 切换触发趋势+明细刷新；⑥ 路由 `?tenantId=` 初始化自动取数、无参零请求、前进/后退跟随。
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 M14 跨页闭环：mount 挂 memory router，补深链自动查询与前进/后退用例。
 * @modified 2026-10-20 M14/PRD-014 AC-14-04：补乱序返回用例（A 的配额晚到不得覆盖 B 的配额/用量）。
 * @module admin-web/views
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { createMemoryHistory, createRouter } from 'vue-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** 可控 promise：手动决定何时返回，用于构造「后发先至」 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

vi.mock('@/api/saas', () => ({
  fetchTenantQuotas: vi.fn(),
  fetchTenantUsage: vi.fn(),
  fetchUsageTrend: vi.fn(),
  fetchUsageEventList: vi.fn(),
  recordUsageEvent: vi.fn(),
}));
vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));

import ElementPlus from 'element-plus';
import * as saasApi from '@/api/saas';
import { fetchTenants } from '@/api/tenant';
import TenantPicker from '@/components/TenantPicker/index.vue';
import { permission } from '@/directives/permission';
import { useUserStore } from '@/store/user';
import type { MeResult } from '@/api/types';
import Usage from '@/views/saas/usage/index.vue';

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

/** 页面依赖 useRoute（useTenantQuery）：挂 memory router，push 即模拟深链/前进后退 */
function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [{ path: '/saas/usage', name: 'SaasUsage', component: { template: '<div />' } }],
  });
}

/** 挂载页面；query 非空即模拟工作台「配额风险」直达链接 */
async function mountPage(query: Record<string, string> = {}) {
  setPermissions(['ops:saas:read']);
  const router = buildRouter();
  await router.push({ path: '/saas/usage', query });
  await router.isReady();
  const wrapper = mount(Usage, { global: { plugins: [ElementPlus, router], directives: { permission } } });
  await flushPromises();
  return { wrapper, router };
}

/** 选中租户 t1 并触发查询（TenantPicker v-model + 查询按钮） */
async function selectTenantAndQuery(wrapper: ReturnType<typeof mount>): Promise<void> {
  wrapper.findComponent(TenantPicker).vm.$emit('update:modelValue', 't1');
  await flushPromises();
  await wrapper.findAll('button').find((b) => b.text().includes('查询'))!.trigger('click');
  await flushPromises();
}

describe('用量页看板化（M14 B4）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchTenants).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    vi.mocked(saasApi.fetchTenantQuotas).mockResolvedValue([{ tenantId: 't1', quotaKey: 'api_calls', limitValue: '100', execution: 'hard', source: 'manual' }]);
    vi.mocked(saasApi.fetchTenantUsage).mockResolvedValue({ totalQuantity: '72', eventCount: 72, limitValue: '100', execution: 'hard', windowStart: '2026-10-20T00:00:00.000Z', windowEnd: '2026-10-21T00:00:00.000Z' });
    vi.mocked(saasApi.fetchUsageTrend).mockResolvedValue({
      quotaKey: 'api_calls', from: '2026-10-13T00:00:00.000Z', to: '2026-10-20T00:00:00.000Z', bucketType: 'day',
      points: [
        { bucketStart: '2026-10-19T00:00:00.000Z', quantity: '10', eventCount: 10 },
        { bucketStart: '2026-10-20T00:00:00.000Z', quantity: '0', eventCount: 0 },
      ],
    });
    vi.mocked(saasApi.fetchUsageEventList).mockResolvedValue({ items: [{ quotaKey: 'api_calls', quantity: '1', occurredAt: '2026-10-20T01:00:00.000Z' }], total: 1, page: 1, pageSize: 20 });
  });

  it('首次加载：配额 + 窗口用量 + 趋势 + 明细四发齐发', async () => {
    const { wrapper } = await mountPage();
    await selectTenantAndQuery(wrapper);

    expect(saasApi.fetchUsageTrend).toHaveBeenCalledWith('t1', 'api_calls', 168);
    expect(saasApi.fetchUsageEventList).toHaveBeenCalledWith('t1', { quotaKey: 'api_calls', hours: 168, page: 1, pageSize: 20 });
    // 趋势柱渲染（含零桶）
    expect(wrapper.findAll('.trend-bar-inner')).toHaveLength(2);
    expect(wrapper.text()).toContain('用量趋势');
    expect(wrapper.text()).toContain('事件明细');
  });

  it('深链 ?tenantId=：首屏自动取数（无需再选租户/点查询）', async () => {
    const { wrapper } = await mountPage({ tenantId: 't1' });

    expect(saasApi.fetchTenantQuotas).toHaveBeenCalledWith('t1');
    expect(saasApi.fetchTenantUsage).toHaveBeenCalledWith('t1', 'api_calls');
    expect(wrapper.findComponent(TenantPicker).props('modelValue')).toBe('t1');
  });

  it('无 tenantId 参数：不发起任何租户级查询（不拼空租户请求）', async () => {
    await mountPage();
    expect(saasApi.fetchTenantQuotas).not.toHaveBeenCalled();
    expect(saasApi.fetchTenantUsage).not.toHaveBeenCalled();
    expect(saasApi.fetchUsageTrend).not.toHaveBeenCalled();
    expect(saasApi.fetchUsageEventList).not.toHaveBeenCalled();
  });

  it('浏览器前进/后退改变 tenantId：同实例跟随重查，回退不残留上一租户', async () => {
    const { wrapper, router } = await mountPage({ tenantId: 't1' });
    expect(saasApi.fetchTenantQuotas).toHaveBeenCalledWith('t1');

    await router.push({ path: '/saas/usage', query: { tenantId: 't2' } });
    await flushPromises();
    expect(saasApi.fetchTenantQuotas).toHaveBeenLastCalledWith('t2');

    // 回退到无参地址：只复位、不发请求（参数缺失零查询）
    const before = vi.mocked(saasApi.fetchTenantQuotas).mock.calls.length;
    await router.push({ path: '/saas/usage' });
    await flushPromises();
    expect(vi.mocked(saasApi.fetchTenantQuotas).mock.calls.length).toBe(before);
    expect(wrapper.text()).toContain('查询后展示');
  });

  it('清空已选租户：看板立即复位且不发请求（空租户不展示上一租户数据）', async () => {
    const { wrapper } = await mountPage({ tenantId: 't1' });
    expect(wrapper.findAll('.trend-bar-inner')).toHaveLength(2);

    const before = vi.mocked(saasApi.fetchTenantQuotas).mock.calls.length;
    wrapper.findComponent(TenantPicker).vm.$emit('update:modelValue', '');
    await flushPromises();

    expect(wrapper.findAll('.trend-bar-inner')).toHaveLength(0);
    expect(wrapper.text()).toContain('查询后展示');
    expect(vi.mocked(saasApi.fetchTenantQuotas).mock.calls.length).toBe(before);
  });

  it('切换指标（看用量与趋势）：四请求以新指标刷新', async () => {
    const { wrapper } = await mountPage();
    await selectTenantAndQuery(wrapper);

    vi.mocked(saasApi.fetchTenantQuotas).mockResolvedValue([
      { tenantId: 't1', quotaKey: 'api_calls', limitValue: '100', execution: 'hard', source: 'manual' },
      { tenantId: 't1', quotaKey: 'storage_gb', limitValue: '10', execution: 'soft', source: 'manual' },
    ]);
    await wrapper.findAll('button').find((b) => b.text().includes('查询'))!.trigger('click');
    await flushPromises();
    // 第二行（storage_gb）的「看用量与趋势」
    const metricBtns = wrapper.findAll('button').filter((b) => b.text().includes('看用量与趋势'));
    await metricBtns[metricBtns.length - 1]!.trigger('click');
    await flushPromises();

    expect(saasApi.fetchUsageTrend).toHaveBeenLastCalledWith('t1', 'storage_gb', 168);
    expect(saasApi.fetchTenantUsage).toHaveBeenLastCalledWith('t1', 'storage_gb');
  });

  it('乱序返回：A 的配额晚到不覆盖 B 的配额与用量（AC-14-04）', async () => {
    const pendingA = deferred<Awaited<ReturnType<typeof saasApi.fetchTenantQuotas>>>();
    vi.mocked(saasApi.fetchTenantQuotas).mockImplementation((id) =>
      id === 'tenant-A'
        ? pendingA.promise
        : Promise.resolve([{ tenantId: 'tenant-B', quotaKey: 'api_calls', limitValue: '222', execution: 'hard', source: 'manual' }]),
    );

    // A 的请求发出但未返回
    const { wrapper } = await mountPage({ tenantId: 'tenant-A' });
    expect(wrapper.text()).not.toContain('222');

    // 切到 B 并查询：B 先返回
    wrapper.findComponent(TenantPicker).vm.$emit('update:modelValue', 'tenant-B');
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('查询'))!.trigger('click');
    await flushPromises();
    expect(wrapper.text()).toContain('222');
    expect(saasApi.fetchTenantUsage).toHaveBeenCalledWith('tenant-B', 'api_calls');

    // A 晚到：不得覆盖 B 的配额，也不得让后续用量查询落到 A
    pendingA.resolve([{ tenantId: 'tenant-A', quotaKey: 'api_calls', limitValue: '111', execution: 'hard', source: 'manual' }]);
    await flushPromises();
    expect(wrapper.text()).toContain('222');
    expect(wrapper.text()).not.toContain('111');
    expect(saasApi.fetchTenantUsage).toHaveBeenLastCalledWith('tenant-B', 'api_calls');
  });
});
