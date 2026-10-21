/*
 * @file 审计视图（在线 / 归档 × 单租户 / 跨租户）前端护栏
 * @description 钉住四条边界，防回退：
 *   ① 四种「模式 × 来源」组合各走独立端点，绝不把普通端点「升级」成跨租户端点
 *      （普通在线 `/audit-logs`、普通归档 `/audit-archives`、平台在线 `/audit-logs/platform`、
 *      平台归档 `/audit-archives/platform`），详情与导出同样按组合分流；
 *   ② 归档表无独立详情端点：归档详情必须直接用列表行快照，不得回落到在线详情端点；
 *   ③ 平台模式租户筛选走受控租户选项查询（`fetchAuditTenantOptions`）——不依赖 `tenant:read`、
 *      不一次性拉管理面第一页 100 条；行内 tenantId 经 `loaded` 事件批量解析名称（去重、过滤 legacy 0）；
 *   ④ 查询范围提示同时标注「租户范围 + 数据来源」；缺 `system:tenant:ignore` / `audit:read`
 *      时不渲染数据区。
 * @author donttemo
 * @created 2026-10-21
 * @module admin-web/views
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/audit', () => ({
  fetchAuditLogs: vi.fn(),
  fetchPlatformAuditLogs: vi.fn(),
  fetchAuditLog: vi.fn(),
  fetchPlatformAuditLog: vi.fn(),
  exportAuditLogs: vi.fn(),
  exportPlatformAuditLogs: vi.fn(),
  fetchArchiveAuditLogs: vi.fn(),
  fetchPlatformArchiveAuditLogs: vi.fn(),
  exportArchiveAuditLogs: vi.fn(),
  exportPlatformArchiveAuditLogs: vi.fn(),
  fetchAuditTenantOptions: vi.fn(),
  fetchAuditEvents: vi.fn(),
}));
vi.mock('@/api/user', () => ({ fetchUsers: vi.fn() }));
vi.mock('@/api/tenant', () => ({ fetchTenants: vi.fn() }));
vi.mock('@/composables/useAuditEvents', async () => {
  const { ref } = await import('vue');
  return {
    useAuditEvents: () => ({
      load: vi.fn(),
      eventOptions: ref([]),
      find: () => undefined,
      codesByRisk: () => [],
    }),
  };
});
vi.mock('@/composables/useJobCenter', () => ({ useJobCenterStore: () => ({ track: vi.fn() }) }));
// CrudTable 换成可观测桩：列表请求不经过真实请求层，测试只关心「用了哪个 api 端点 / filters」与事件
vi.mock('@/components/CrudTable/index.vue', async () => {
  const { defineComponent } = await import('vue');
  return {
    default: defineComponent({
      name: 'CrudTable',
      props: {
        api: { type: String, default: '' },
        columns: { type: Array, default: () => [] },
        searchForm: { type: Array, default: () => [] },
        filters: { type: Object, default: () => ({}) },
        transformSearch: { type: Function, default: undefined },
        permission: { type: String, default: '' },
        exportable: { type: Boolean, default: false },
        /** 测试注入：详情按钮所在行的快照 */
        row: { type: Object, default: () => ({ id: 'a-1', tenantId: '1' }) },
        /** 测试注入：loaded 事件携带的行（覆盖去重 / legacy 0 过滤；由桩固定提供） */
        loadedRows: { type: Array, default: () => [] },
      },
      emits: ['export', 'loaded'],
      data() {
        return {
          shipped: [
            { id: 'x', tenantId: '3' },
            { id: 'y', tenantId: '0' },
            { id: 'z', tenantId: '3' },
          ],
        };
      },
      template: `
        <div class="crud-stub">
          <button class="stub-export" @click="$emit('export', { search: {}, sort: null })">导出</button>
          <button class="stub-loaded" @click="$emit('loaded', { items: shipped, total: shipped.length })">loaded</button>
          <slot name="actions-extra" :row="row" />
        </div>
      `,
    }),
  };
});

import ElementPlus from 'element-plus';
import * as auditApi from '@/api/audit';
import { fetchTenants } from '@/api/tenant';
import { fetchUsers } from '@/api/user';
import { useUserStore } from '@/store/user';
import { permission } from '@/directives/permission';
import AuditLogPage from '@/views/system/audit-logs/index.vue';
import PlatformAuditLogPage from '@/views/system/audit-logs/platform/index.vue';
import CrudTable from '@/components/CrudTable/index.vue';
import TenantPicker from '@/components/TenantPicker/index.vue';
import type { MeResult } from '@/api/types';

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

function mountPage(component: typeof AuditLogPage | typeof PlatformAuditLogPage, crossTenant = false) {
  return mount(component, {
    props: crossTenant ? { crossTenant: true } : {},
    global: { plugins: [ElementPlus], directives: { permission } },
  });
}

/** 找到按钮（桩内按钮 / 页面插槽按钮统一按文案找） */
function findButton(wrapper: ReturnType<typeof mount>, text: string) {
  return wrapper.findAll('button').find((button) => button.text().trim() === text);
}

/** 切换在线 / 归档来源（Element Plus radio-group 的 v-model） */
async function switchSource(wrapper: ReturnType<typeof mount>, label: '在线审计' | '归档审计') {
  const group = wrapper.findComponent({ name: 'ElRadioGroup' });
  expect(group.exists()).toBe(true);
  group.vm.$emit('update:modelValue', label === '在线审计' ? 'online' : 'archive');
  await flushPromises();
}

describe('审计视图：在线 / 归档 × 单租户 / 跨租户', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchUsers).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, hasMore: false });
    vi.mocked(fetchTenants).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, hasMore: false });
    for (const fn of [
      auditApi.exportAuditLogs,
      auditApi.exportPlatformAuditLogs,
      auditApi.exportArchiveAuditLogs,
      auditApi.exportPlatformArchiveAuditLogs,
    ]) {
      vi.mocked(fn).mockResolvedValue({} as never);
    }
    vi.mocked(auditApi.fetchAuditLog).mockResolvedValue({ id: 'a-1' } as never);
    vi.mocked(auditApi.fetchPlatformAuditLog).mockResolvedValue({ id: 'a-1' } as never);
    vi.mocked(auditApi.fetchAuditTenantOptions).mockResolvedValue({
      items: [
        { id: '3', code: 'dedicated', name: '独立库租户', status: 1 },
        { id: '1', code: 'acme', name: 'ACME 公司', status: 1 },
      ],
      total: 2,
      page: 1,
      pageSize: 20,
      hasMore: false,
    });
  });

  it('普通在线：数据源 /audit-logs，范围提示标注单租户 + 在线，不渲染租户列/筛选', async () => {
    setPermissions(['audit:read']);
    const wrapper = mountPage(AuditLogPage);
    await flushPromises();

    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-logs');
    expect(wrapper.text()).toContain('查询范围：单租户（当前租户） · 数据来源：在线审计');
    const columns = wrapper.findComponent(CrudTable).props('columns') as Array<{ prop: string }>;
    expect(columns.some((column) => column.prop === 'tenantId')).toBe(false);
    expect(wrapper.findComponent(TenantPicker).exists()).toBe(false);
    // 普通模式没有任何跨租户/租户管理面调用
    expect(auditApi.fetchAuditTenantOptions).not.toHaveBeenCalled();
    expect(fetchTenants).not.toHaveBeenCalled();
  });

  it('普通归档：切到 /audit-archives，范围提示标注归档；详情直接用行快照、不回落在线的详情端点', async () => {
    setPermissions(['audit:read', 'audit:export']);
    const wrapper = mountPage(AuditLogPage);
    await flushPromises();
    await switchSource(wrapper, '归档审计');

    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-archives');
    expect(wrapper.text()).toContain('数据来源：归档审计');
    expect(wrapper.text()).toContain('归档记录不可变，详情取自列表快照');

    await findButton(wrapper, '导出')!.trigger('click');
    await flushPromises();
    expect(auditApi.exportArchiveAuditLogs).toHaveBeenCalledTimes(1);
    expect(auditApi.exportAuditLogs).not.toHaveBeenCalled();

    await findButton(wrapper, '详情')!.trigger('click');
    await flushPromises();
    expect(auditApi.fetchAuditLog).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('归档记录（只读快照）');
  });

  it('平台在线：数据源 /audit-logs/platform，租户列与受控租户筛选可见，不调用管理面 /tenants', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();

    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-logs/platform');
    expect(wrapper.text()).toContain('查询范围：跨租户（平台维护入口） · 数据来源：在线审计');
    const columns = wrapper.findComponent(CrudTable).props('columns') as Array<{ prop: string }>;
    expect(columns.some((column) => column.prop === 'tenantId')).toBe(true);
    expect(wrapper.findComponent(TenantPicker).exists()).toBe(true);
    // 租户筛选不再依赖租户管理面（tenant:read）
    expect(fetchTenants).not.toHaveBeenCalled();

    await findButton(wrapper, '导出')!.trigger('click');
    await flushPromises();
    expect(auditApi.exportPlatformAuditLogs).toHaveBeenCalledTimes(1);

    await findButton(wrapper, '详情')!.trigger('click');
    await flushPromises();
    expect(auditApi.fetchPlatformAuditLog).toHaveBeenCalledWith('a-1');
  });

  it('平台归档：数据源 /audit-archives/platform，导出走平台归档端点；详情直接用行快照', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();
    await switchSource(wrapper, '归档审计');

    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-archives/platform');
    expect(wrapper.text()).toContain('数据来源：归档审计');

    await findButton(wrapper, '导出')!.trigger('click');
    await flushPromises();
    expect(auditApi.exportPlatformArchiveAuditLogs).toHaveBeenCalledTimes(1);
    expect(auditApi.exportPlatformAuditLogs).not.toHaveBeenCalled();

    await findButton(wrapper, '详情')!.trigger('click');
    await flushPromises();
    expect(auditApi.fetchPlatformAuditLog).not.toHaveBeenCalled();
    expect(wrapper.text()).toContain('归档记录（只读快照）');
  });

  it('租户筛选：选择租户 → filters 注入 tenant_id；清空 → 撤销过滤（同一来源内原地重查）', async () => {
    setPermissions(['audit:read', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();

    const picker = wrapper.findComponent(TenantPicker);
    picker.vm.$emit('update:modelValue', '3');
    await flushPromises();
    expect((wrapper.findComponent(CrudTable).props('filters') as Record<string, unknown>).tenant_id).toBe('3');

    picker.vm.$emit('update:modelValue', '');
    await flushPromises();
    expect(wrapper.findComponent(CrudTable).props('filters')).toEqual({});
  });

  it('租户名称解析：列表加载后按行 ID 批量解析（去重、过滤 legacy 0、不拉管理面）', async () => {
    setPermissions(['audit:read', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();
    // 测试桩固定发出当前页行：3 / 0 / 3
    await findButton(wrapper, 'loaded')!.trigger('click');
    await flushPromises();

    expect(auditApi.fetchAuditTenantOptions).toHaveBeenCalledTimes(1);
    expect(auditApi.fetchAuditTenantOptions).toHaveBeenCalledWith({ ids: '3', page: 1, pageSize: 100 });
    expect(fetchTenants).not.toHaveBeenCalled();
  });

  it('租户筛选远程搜索：走受控 tenant-options（keyword）而不是管理面 /tenants', async () => {
    setPermissions(['audit:read', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();

    const fetcher = wrapper.findComponent(TenantPicker).props('fetcher') as (keyword: string) => Promise<unknown[]>;
    const options = await fetcher('acme');
    expect(auditApi.fetchAuditTenantOptions).toHaveBeenCalledWith({ keyword: 'acme', page: 1, pageSize: 20 });
    expect(options).toHaveLength(2);
    expect(fetchTenants).not.toHaveBeenCalled();
  });

  it('平台模式缺 system:tenant:ignore：不渲染数据区与租户筛选，且不发租户选项请求', async () => {
    setPermissions(['audit:read', 'audit:export']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();

    expect(wrapper.text()).toContain('无权访问平台审计');
    expect(wrapper.findComponent(CrudTable).exists()).toBe(false);
    expect(wrapper.findComponent(TenantPicker).exists()).toBe(false);
    expect(auditApi.fetchAuditTenantOptions).not.toHaveBeenCalled();
  });

  it('平台模式缺 audit:read：同样不渲染数据区（两码与关系，不是二选一）', async () => {
    setPermissions(['system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage, true);
    await flushPromises();

    expect(wrapper.text()).toContain('无权访问平台审计');
    expect(wrapper.findComponent(CrudTable).exists()).toBe(false);
  });
});
