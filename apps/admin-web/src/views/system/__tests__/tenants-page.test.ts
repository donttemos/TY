/*
 * @file 租户管理页五态链路回归（ADR-0029 §2.4 / ADR-0031 §2.3）
 * @description 钉住管理端不再把非 1 折叠成「停用」、状态写权唯一走生命周期命令：
 *   ① 操作列按迁移表渲染——停用仅 active(1)/grace(2)，启用仅 frozen(3)，terminated(4)/pending(5) 无入口；
 *   ② 停用 → DELETE（freeze，规范码 3）；启用 → PUT status=1（resume/activate）；
 *   ③ 编辑弹窗不含状态字段（状态是命令不是可编辑属性）。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/views
 */
import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/tenant', () => ({
  fetchTenants: vi.fn(),
  createTenant: vi.fn(),
  updateTenant: vi.fn(),
  disableTenant: vi.fn(),
  migrateTenant: vi.fn(),
}));
// CrudTable 走通用 request 层（api="/tenants"），useDict 同样经它取字典
vi.mock('@/utils/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/request')>();
  return {
    ...actual,
    request: {
      get: vi.fn(async (url: string) => (url.startsWith('/dicts') ? { items: [], total: 0 } : { items: ROWS, total: ROWS.length, page: 1, pageSize: 20, hasMore: false })),
      post: vi.fn(async () => ({})),
      put: vi.fn(async () => ({})),
      delete: vi.fn(async () => ({})),
    },
  };
});

import ElementPlus, { ElMessageBox } from 'element-plus';
import * as tenantApi from '@/api/tenant';
import { permission } from '@/directives/permission';
import { useUserStore } from '@/store/user';
import type { MeResult, TenantView } from '@/api/types';
import Tenants from '@/views/system/tenants/index.vue';

const row = (over: Partial<TenantView>): TenantView => ({
  id: '1',
  code: 'acme',
  name: 'ACME',
  isolation: 'shared',
  plan: null,
  status: 1,
  expireAt: null,
  dedicatedDbConfigured: false,
  createdAt: '2026-10-13T00:00:00.000Z',
  updatedAt: '2026-10-13T00:00:00.000Z',
  ...over,
});

const ROWS: TenantView[] = [
  row({ id: '1', code: 'acme', status: 1 }),
  row({ id: '2', code: 'grace-demo', name: '宽限期', status: 2 }),
  row({ id: '3', code: 'frozen-demo', name: '已冻结', status: 3 }),
  row({ id: '4', code: 'term-demo', name: '已终止', status: 4 }),
  row({ id: '5', code: 'pending-demo', name: '待开通', status: 5 }),
  row({ id: '0', code: 'legacy', name: '存量单租户', status: 1 }),
];

/** 行内按钮文本（actions-extra 列） */
function actionButtons(wrapper: ReturnType<typeof mount>, rowName: string): string[] {
  const tr = wrapper.findAll('tr').find((r) => r.text().includes(rowName));
  expect(tr, `行 ${rowName} 应渲染`).toBeTruthy();
  return tr!.findAll('button').map((b) => b.text().trim());
}

describe('租户管理页五态链路（ADR-0031 §2.3 写权唯一）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    useUserStore().permissions = ['tenant:read', 'tenant:update', 'tenant:delete', 'tenant:manage'] as MeResult['permissions'];
    vi.spyOn(ElMessageBox, 'confirm').mockResolvedValue('confirm' as never);
  });

  it('操作列按迁移表渲染：停用仅 active/grace，启用仅 frozen，terminated/pending 无入口', async () => {
    const wrapper = mount(Tenants, { global: { plugins: [ElementPlus], directives: { permission } } });
    await flushPromises();
    expect(actionButtons(wrapper, 'ACME')).toContain('停用');
    expect(actionButtons(wrapper, '宽限期')).toContain('停用');
    expect(actionButtons(wrapper, '已冻结')).toContain('启用');
    expect(actionButtons(wrapper, '已冻结')).not.toContain('停用');
    expect(actionButtons(wrapper, '已终止')).not.toContain('停用');
    expect(actionButtons(wrapper, '已终止')).not.toContain('启用');
    expect(actionButtons(wrapper, '待开通')).not.toContain('停用');
    expect(actionButtons(wrapper, '待开通')).not.toContain('启用');
  });

  it('停用 → DELETE（freeze）；启用 → PUT status=1（resume/activate）', async () => {
    vi.mocked(tenantApi.disableTenant).mockResolvedValue(row({ id: '1', status: 3 }));
    vi.mocked(tenantApi.updateTenant).mockResolvedValue(row({ id: '3', status: 1 }));
    const wrapper = mount(Tenants, { global: { plugins: [ElementPlus], directives: { permission } } });
    await flushPromises();

    const acmeTr = wrapper.findAll('tr').find((r) => r.text().includes('ACME'))!;
    await acmeTr.findAll('button').find((b) => b.text().includes('停用'))!.trigger('click');
    await flushPromises();
    expect(tenantApi.disableTenant).toHaveBeenCalledWith('1');

    const frozenTr = wrapper.findAll('tr').find((r) => r.text().includes('已冻结'))!;
    await frozenTr.findAll('button').find((b) => b.text().includes('启用'))!.trigger('click');
    await flushPromises();
    expect(tenantApi.updateTenant).toHaveBeenCalledWith('3', { status: 1 });
  });

  it('编辑弹窗不含状态字段（状态是生命周期命令，非可编辑属性）', async () => {
    const wrapper = mount(Tenants, { global: { plugins: [ElementPlus], directives: { permission } } });
    await flushPromises();
    // 打开编辑弹窗（每行「编辑」按钮）
    const acmeTr = wrapper.findAll('tr').find((r) => r.text().includes('ACME'))!;
    await acmeTr.findAll('button').find((b) => b.text().includes('编辑'))!.trigger('click');
    await flushPromises();
    const dialog = wrapper.find('.el-dialog');
    expect(dialog.exists()).toBe(true);
    expect(dialog.text()).not.toContain('状态');
  });
});
