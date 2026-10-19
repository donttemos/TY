/*
 * @file TenantPicker 单测（M14/PRD-014 FR-14-08）
 * @description 钉住远程搜索语义：① 搜索透传 keyword（空关键词 → undefined 取第一页候选）；
 *   ② 查询失败不抛出（选择器不阻断页面）；③ 选中选项 emit update:modelValue（租户 ID）。
 *   真实请求 mock；选项渲染由 Element Plus 提供，不重复断言。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/components
 */
import { mount } from '@vue/test-utils';
import { describe, expect, it, vi, beforeEach } from 'vitest';

vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));

import ElementPlus from 'element-plus';
import { fetchTenants } from '@/api/tenant';
import type { TenantView } from '@/api/types';
import TenantPicker from '@/components/TenantPicker/index.vue';

const tenants: TenantView[] = [
  { id: 't1', code: 'acme', name: 'Acme 公司', isolation: 'shared', plan: null, status: 1, expireAt: null, dedicatedDbConfigured: false, createdAt: '', updatedAt: '' },
  { id: 't2', code: 'globex', name: 'Globex', isolation: 'shared', plan: null, status: 1, expireAt: null, dedicatedDbConfigured: false, createdAt: '', updatedAt: '' },
];

function mountPicker(modelValue = '') {
  return mount(TenantPicker, { global: { plugins: [ElementPlus] }, props: { modelValue } });
}

/** 取传给 ElSelect 的 remote-method（搜索逻辑本体） */
function remoteMethodOf(wrapper: ReturnType<typeof mountPicker>): (kw: string) => Promise<void> {
  const select = wrapper.findComponent({ name: 'ElSelect' });
  expect(select.exists()).toBe(true);
  return select.props('remoteMethod') as (kw: string) => Promise<void>;
}

describe('TenantPicker（可搜索租户选择器）', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fetchTenants).mockResolvedValue({ items: tenants, total: 2, page: 1, pageSize: 20, hasMore: false });
  });

  it('远程搜索透传 keyword', async () => {
    const wrapper = mountPicker();
    await remoteMethodOf(wrapper)('acme');
    expect(fetchTenants).toHaveBeenCalledWith({ keyword: 'acme', page: 1, pageSize: 20 });
  });

  it('空关键词取第一页候选（keyword 归一为 undefined）', async () => {
    const wrapper = mountPicker();
    await remoteMethodOf(wrapper)('');
    expect(fetchTenants).toHaveBeenCalledWith({ keyword: undefined, page: 1, pageSize: 20 });
  });

  it('查询失败不抛出（选择器不阻断页面）', async () => {
    vi.mocked(fetchTenants).mockRejectedValue(new Error('boom'));
    const wrapper = mountPicker();
    await expect(remoteMethodOf(wrapper)('x')).resolves.toBeUndefined();
  });

  it('选中选项：change → emit update:modelValue（租户 ID）', async () => {
    const wrapper = mountPicker();
    wrapper.findComponent({ name: 'ElSelect' }).vm.$emit('change', 't1');
    expect(wrapper.emitted('update:modelValue')?.[0]).toEqual(['t1']);
  });
});
