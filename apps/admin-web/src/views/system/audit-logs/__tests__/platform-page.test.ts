/*
 * @file 平台审计视图（P2）前端护栏
 * @description 钉住「普通审计 / 平台审计」两条链路的分离，防回退：
 *   ① 普通页只调 `/audit-logs*`，平台页只调 `/audit-logs/platform*`——同一份视图不得靠开关
 *      把普通端点「升级」成跨租户端点（服务端边界不同，前端混用会造成误读与越权尝试）；
 *   ② 查询范围必须显式可辨（单租户 / 跨租户横幅），平台页必须有租户列与租户筛选；
 *   ③ 平台入口仅向 `system:tenant:ignore` + `audit:read` 持有者渲染数据区，缺权限时不发请求；
 *   ④ 详情与导出同样按模式分流（不是只有列表分流）。
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
// CrudTable 换成可观测桩：列表请求不经过真实请求层，测试只关心「用了哪个 api 端点」与插槽事件
vi.mock('@/components/CrudTable/index.vue', async () => {
  const { defineComponent } = await import('vue');
  return {
    default: defineComponent({
      name: 'CrudTable',
      props: {
        api: { type: String, default: '' },
        columns: { type: Array, default: () => [] },
        searchForm: { type: Array, default: () => [] },
        transformSearch: { type: Function, default: undefined },
        permission: { type: String, default: '' },
        exportable: { type: Boolean, default: false },
      },
      emits: ['export'],
      template: `
        <div class="crud-stub">
          <button class="stub-export" @click="$emit('export', { search: {}, sort: null })">导出</button>
          <slot name="actions-extra" :row="{ id: 'a-1' }" />
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

/** 找到导出按钮（桩内的按钮） */
function exportButton(wrapper: ReturnType<typeof mount>) {
  return wrapper.findAll('button').find((button) => button.text().includes('导出'));
}

describe('平台审计视图（P2：单租户 / 跨租户分入口）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(fetchUsers).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, hasMore: false });
    vi.mocked(fetchTenants).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, hasMore: false });
    vi.mocked(auditApi.exportAuditLogs).mockResolvedValue({} as never);
    vi.mocked(auditApi.exportPlatformAuditLogs).mockResolvedValue({} as never);
    vi.mocked(auditApi.fetchAuditLog).mockResolvedValue({ id: 'a-1' } as never);
    vi.mocked(auditApi.fetchPlatformAuditLog).mockResolvedValue({ id: 'a-1' } as never);
  });

  it('普通模式：数据源仍是 /audit-logs，横幅明确「单租户」，不出现租户列/租户筛选', async () => {
    setPermissions(['audit:read']);
    const wrapper = mountPage(AuditLogPage);
    await flushPromises();

    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-logs');
    expect(wrapper.text()).toContain('查询范围：单租户（当前租户）');
    const columns = wrapper.findComponent(CrudTable).props('columns') as Array<{ prop: string }>;
    expect(columns.some((column) => column.prop === 'tenantId')).toBe(false);
    const fields = wrapper.findComponent(CrudTable).props('searchForm') as Array<{ prop: string }>;
    expect(fields.some((field) => field.prop === 'tenant_id')).toBe(false);
    // 普通模式不需要租户下拉（服务端强制当前租户，列全量选项会误导）
    expect(fetchTenants).not.toHaveBeenCalled();
  });

  it('普通模式：详情与导出都走普通端点（不是只有列表分流）', async () => {
    setPermissions(['audit:read', 'audit:export']);
    const wrapper = mountPage(AuditLogPage);
    await flushPromises();

    await exportButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(auditApi.exportAuditLogs).toHaveBeenCalledTimes(1);
    expect(auditApi.exportPlatformAuditLogs).not.toHaveBeenCalled();

    const detailButton = wrapper.findAll('button').find((button) => button.text().includes('详情'))!;
    await detailButton.trigger('click');
    await flushPromises();
    expect(auditApi.fetchAuditLog).toHaveBeenCalledWith('a-1');
    expect(auditApi.fetchPlatformAuditLog).not.toHaveBeenCalled();
  });

  it('平台模式：数据源切到 /audit-logs/platform，横幅明确「跨租户」，保留租户列与租户筛选', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage);
    await flushPromises();

    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-logs/platform');
    expect(wrapper.text()).toContain('查询范围：跨租户（平台维护入口）');
    const columns = wrapper.findComponent(CrudTable).props('columns') as Array<{ prop: string }>;
    expect(columns.some((column) => column.prop === 'tenantId')).toBe(true);
    const fields = wrapper.findComponent(CrudTable).props('searchForm') as Array<{ prop: string }>;
    expect(fields.some((field) => field.prop === 'tenant_id')).toBe(true);
    expect(fetchTenants).toHaveBeenCalledTimes(1);
  });

  it('平台模式：详情与导出走 /audit-logs/platform*，不会回落到普通端点', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage);
    await flushPromises();

    await exportButton(wrapper)!.trigger('click');
    await flushPromises();
    expect(auditApi.exportPlatformAuditLogs).toHaveBeenCalledTimes(1);
    expect(auditApi.exportAuditLogs).not.toHaveBeenCalled();

    const detailButton = wrapper.findAll('button').find((button) => button.text().includes('详情'))!;
    await detailButton.trigger('click');
    await flushPromises();
    expect(auditApi.fetchPlatformAuditLog).toHaveBeenCalledWith('a-1');
    expect(auditApi.fetchAuditLog).not.toHaveBeenCalled();
  });

  it('平台模式缺 system:tenant:ignore：不渲染数据区、不发列表/租户请求，并说明原因', async () => {
    setPermissions(['audit:read', 'audit:export']);
    const wrapper = mountPage(PlatformAuditLogPage);
    await flushPromises();

    expect(wrapper.text()).toContain('无权访问平台审计');
    expect(wrapper.findComponent(CrudTable).exists()).toBe(false);
    expect(fetchTenants).not.toHaveBeenCalled();
    expect(auditApi.fetchAuditLog).not.toHaveBeenCalled();
  });

  it('平台模式缺 audit:read：同样不渲染数据区（两码与关系，不是二选一）', async () => {
    setPermissions(['system:tenant:ignore']);
    const wrapper = mountPage(PlatformAuditLogPage);
    await flushPromises();

    expect(wrapper.text()).toContain('无权访问平台审计');
    expect(wrapper.findComponent(CrudTable).exists()).toBe(false);
  });
});
