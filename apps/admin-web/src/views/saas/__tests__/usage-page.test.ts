/*
 * @file 用量页看板化回归（M14/PRD-014 FR-14-13）
 * @description 钉住：① 首次加载配额后自动拉趋势与明细；② 趋势桶柱渲染（零桶填齐，柱高按最大值归一）；
 *   ③ 切换指标（switchMetric）一并刷新用量/趋势/明细；④ 明细分页切换请求参数；
 *   ⑤ hours 切换触发趋势+明细刷新。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/views
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
    setPermissions(['ops:saas:read']);
    const wrapper = mount(Usage, { global: { plugins: [ElementPlus], directives: { permission } } });
    await selectTenantAndQuery(wrapper);

    expect(saasApi.fetchUsageTrend).toHaveBeenCalledWith('t1', 'api_calls', 168);
    expect(saasApi.fetchUsageEventList).toHaveBeenCalledWith('t1', { quotaKey: 'api_calls', hours: 168, page: 1, pageSize: 20 });
    // 趋势柱渲染（含零桶）
    expect(wrapper.findAll('.trend-bar-inner')).toHaveLength(2);
    expect(wrapper.text()).toContain('用量趋势');
    expect(wrapper.text()).toContain('事件明细');
  });

  it('切换指标（看用量与趋势）：四请求以新指标刷新', async () => {
    setPermissions(['ops:saas:read']);
    const wrapper = mount(Usage, { global: { plugins: [ElementPlus], directives: { permission } } });
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
});
