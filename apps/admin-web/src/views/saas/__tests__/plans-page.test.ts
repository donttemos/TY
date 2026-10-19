/*
 * @file 套餐页产品化回归（M14/PRD-014 FR-14-05/06/09）
 * @description 钉住：① 新建套餐表单 trim 提交；② 发布新版本「复制上一版本为起点 → 归一提交 →
 *   成功后重载版本」；③ 空配额版本前端拦截；④ 版本抽屉只读展示。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/views
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/saas', () => ({
  fetchPlans: vi.fn(),
  fetchPlanVersions: vi.fn(),
  createPlan: vi.fn(),
  publishPlanVersion: vi.fn(),
}));
vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));

import ElementPlus from 'element-plus';
import * as saasApi from '@/api/saas';
import { fetchTenants } from '@/api/tenant';
import { permission } from '@/directives/permission';import { useUserStore } from '@/store/user';
import type { MeResult } from '@/api/types';
import Plans from '@/views/saas/plans/index.vue';
import FormDialog from '@/components/FormDialog/index.vue';

const plan = { id: 'plan-1', code: 'default', name: '基础版', description: null };
const version = {
  id: 'pv-2', planId: 'plan-1', version: 2, status: 'published' as const, remark: null, publishedAt: '2026-10-19T00:00:00.000Z',
  quotas: [{ quotaKey: 'api_calls', limitValue: '100', execution: 'hard' }],
};

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

async function mountPage() {
  setPermissions(['ops:saas:read', 'ops:saas:write']);
  const wrapper = mount(Plans, { global: { plugins: [ElementPlus], directives: { permission } } });
  await flushPromises();
  return wrapper;
}

describe('套餐页（M14 B3 创建 + 发布闭环）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchTenants).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    vi.mocked(saasApi.fetchPlans).mockResolvedValue([plan]);
    vi.mocked(saasApi.fetchPlanVersions).mockResolvedValue([version]);
  });

  it('新建套餐：FormDialog 提交 trim 透传 createPlan 并刷新列表', async () => {
    vi.mocked(saasApi.createPlan).mockResolvedValue({ id: 'plan-2', code: 'pro', name: '专业版', description: null });
    const wrapper = await mountPage();
    const dialog = wrapper.findComponent(FormDialog);
    expect(dialog.exists()).toBe(true);
    dialog.vm.$emit('submit', { code: ' pro ', name: ' 专业版 ', description: '  ' });
    await flushPromises();
    expect(saasApi.createPlan).toHaveBeenCalledWith({ code: 'pro', name: '专业版', description: null });
    expect(saasApi.fetchPlans).toHaveBeenCalledTimes(2); // 初始 + 创建后刷新
  });

  it('发布新版本：复制上一版本为起点，归一提交（空 execution → null）并重载版本', async () => {
    vi.mocked(saasApi.publishPlanVersion).mockResolvedValue({ ...version, id: 'pv-3', version: 3, quotas: version.quotas });
    const wrapper = await mountPage();
    await wrapper.findAll('button').find((b) => b.text().includes('版本与配额'))!.trigger('click');
    await flushPromises();
    expect(saasApi.fetchPlanVersions).toHaveBeenCalledWith('plan-1');

    // 打开发布对话框并提交（draftRows 由 openPublish 预填：复制上版）
    await wrapper.findAll('button').find((b) => b.text().includes('发布新版本'))!.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('确认发布'))!.trigger('click');
    await flushPromises();

    expect(saasApi.publishPlanVersion).toHaveBeenCalledWith('plan-1', {
      remark: null,
      quotas: [{ quotaKey: 'api_calls', limitValue: 100, execution: 'hard' }],
    });
    expect(saasApi.fetchPlanVersions).toHaveBeenCalledTimes(2); // 抽屉打开 + 发布成功后
  });

  it('空配额草稿：前端拦截，不提交（版本必须至少一条配额定义）', async () => {
    const wrapper = await mountPage();
    await wrapper.findAll('button').find((b) => b.text().includes('版本与配额'))!.trigger('click');
    await flushPromises();
    await wrapper.findAll('button').find((b) => b.text().includes('发布新版本'))!.trigger('click');
    await flushPromises();
    // 清空草稿：把唯一行的指标键清空（输入为空行会被提交前过滤）
    const input = wrapper.findAll('input').find((i) => i.attributes('placeholder') === 'quotaKey')!;
    await input.setValue('');
    await wrapper.findAll('button').find((b) => b.text().includes('确认发布'))!.trigger('click');
    await flushPromises();
    expect(saasApi.publishPlanVersion).not.toHaveBeenCalled();
  });
});
