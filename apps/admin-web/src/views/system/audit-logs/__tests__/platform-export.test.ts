/*
 * @file 平台审计导出范围一致性（P1 回归，真实 CrudTable + 真实审计页）
 * @description 钉住「列表筛选条件 == 导出条件」这条交付口径：
 *   平台维护人员在 TenantPicker 选中租户后，列表按 `tenant_id` 收窄；导出请求必须带**同一个**
 *   `tenant_id`，且在线导出（`/audit-logs/platform/export`）与归档导出
 *   （`/audit-archives/platform/export`）两条路径都要成立。
 *   历史缺陷：CrudTable.handleExport 只发查询区、不合并 props.filters，而审计页又直接使用
 *   `payload.search` → 列表显示某个租户的记录、导出却是更大范围。
 *   本文件刻意**不 mock** CrudTable（同目录 platform-page.test.ts 用的是桩，只覆盖端点分流）：
 *   合并逻辑就在 CrudTable 里，用桩验证不到这层回归。
 * @author donttemo
 * @created 2026-10-21
 * @module admin-web/views
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// 请求层 mock：CrudTable 的列表拉取走 request.get（导出走 @/api/audit，单独 mock）
vi.mock('@/utils/request', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/request')>();
  return {
    ...actual,
    request: { get: vi.fn(), post: vi.fn(), put: vi.fn(), delete: vi.fn() },
  };
});

// CrudTable 用 useRoute 生成「查询条件 / 列设置」的本地存储键
vi.mock('vue-router', () => ({
  useRoute: () => ({ path: '/system/audit-logs/platform' }),
  useRouter: () => ({ push: vi.fn() }),
}));

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
    useAuditEvents: () => ({ load: vi.fn(), eventOptions: ref([]), find: () => undefined, codesByRisk: () => [] }),
  };
});
vi.mock('@/composables/useJobCenter', () => ({ useJobCenterStore: () => ({ track: vi.fn() }) }));

import ElementPlus from 'element-plus';
import * as auditApi from '@/api/audit';
import { fetchUsers } from '@/api/user';
import { request } from '@/utils/request';
import { useUserStore } from '@/store/user';
import { permission } from '@/directives/permission';
import AuditLogPage from '@/views/system/audit-logs/index.vue';
import PlatformAuditLogPage from '@/views/system/audit-logs/platform/index.vue';
import CrudTable from '@/components/CrudTable/index.vue';
import TenantPicker from '@/components/TenantPicker/index.vue';
import type { MeResult } from '@/api/types';

const mockedGet = vi.mocked(request.get);

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

function mountPage(crossTenant: boolean) {
  return mount(crossTenant ? PlatformAuditLogPage : AuditLogPage, {
    props: crossTenant ? { crossTenant: true } : {},
    global: { plugins: [ElementPlus], directives: { permission } },
  });
}

/** 工具栏「导出」按钮 */
function findExportButton(wrapper: ReturnType<typeof mount>) {
  const button = wrapper.findAll('button').find((item) => item.text().trim() === '导出');
  expect(button).toBeTruthy();
  return button!;
}

/** 在租户选择器上选中租户（Element Plus 组件的 v-model 走 update:modelValue） */
async function pickTenant(wrapper: ReturnType<typeof mount>, tenantId: string): Promise<void> {
  wrapper.findComponent(TenantPicker).vm.$emit('update:modelValue', tenantId);
  await flushPromises();
}

/** 切换 在线 / 归档 */
async function switchSource(wrapper: ReturnType<typeof mount>, source: 'online' | 'archive'): Promise<void> {
  wrapper.findComponent({ name: 'ElRadioGroup' }).vm.$emit('update:modelValue', source);
  await flushPromises();
}

describe('平台审计导出：租户筛选必须进入导出请求（列表与导出同口径）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    localStorage.clear();
    mockedGet.mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    vi.mocked(fetchUsers).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 100, hasMore: false });
    vi.mocked(auditApi.fetchAuditTenantOptions).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20, hasMore: false });
    for (const fn of [
      auditApi.exportAuditLogs,
      auditApi.exportPlatformAuditLogs,
      auditApi.exportArchiveAuditLogs,
      auditApi.exportPlatformArchiveAuditLogs,
    ]) {
      vi.mocked(fn).mockResolvedValue({ id: 'job-1' } as never);
    }
  });

  it('在线导出：选中租户后请求参数带 tenant_id（与列表筛选一致）', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(true);
    await flushPromises();

    await pickTenant(wrapper, '3');
    // 列表侧已按租户收窄（filters 经 CrudTable 合并进列表请求）
    expect(mockedGet).toHaveBeenLastCalledWith('/audit-logs/platform', { params: { page: 1, pageSize: 20, tenant_id: '3' } });

    await findExportButton(wrapper).trigger('click');
    await flushPromises();

    expect(auditApi.exportPlatformAuditLogs).toHaveBeenCalledTimes(1);
    expect(auditApi.exportPlatformAuditLogs).toHaveBeenCalledWith({ tenant_id: '3' });
    expect(auditApi.exportPlatformArchiveAuditLogs).not.toHaveBeenCalled();
  });

  it('归档导出：切换来源后仍带 tenant_id（归档路径同样受同一份合并逻辑保护）', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(true);
    await flushPromises();

    await pickTenant(wrapper, '3');
    await switchSource(wrapper, 'archive');
    // 换源会重建 CrudTable（key = 端点），租户筛选是页面级状态，必须继续生效
    expect(wrapper.findComponent(CrudTable).props('api')).toBe('/audit-archives/platform');
    expect(mockedGet).toHaveBeenLastCalledWith('/audit-archives/platform', { params: { page: 1, pageSize: 20, tenant_id: '3' } });

    await findExportButton(wrapper).trigger('click');
    await flushPromises();

    expect(auditApi.exportPlatformArchiveAuditLogs).toHaveBeenCalledTimes(1);
    expect(auditApi.exportPlatformArchiveAuditLogs).toHaveBeenCalledWith({ tenant_id: '3' });
    expect(auditApi.exportPlatformAuditLogs).not.toHaveBeenCalled();
  });

  it('未选租户：在线 / 归档导出都不带 tenant_id（不得凭空加筛选）', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(true);
    await flushPromises();

    await findExportButton(wrapper).trigger('click');
    await flushPromises();
    expect(auditApi.exportPlatformAuditLogs).toHaveBeenCalledWith({});

    await switchSource(wrapper, 'archive');
    await findExportButton(wrapper).trigger('click');
    await flushPromises();
    expect(auditApi.exportPlatformArchiveAuditLogs).toHaveBeenCalledWith({});
  });

  it('清空租户：导出撤销 tenant_id（与列表同步撤销过滤）', async () => {
    setPermissions(['audit:read', 'audit:export', 'system:tenant:ignore']);
    const wrapper = mountPage(true);
    await flushPromises();

    await pickTenant(wrapper, '3');
    await pickTenant(wrapper, '');
    await findExportButton(wrapper).trigger('click');
    await flushPromises();

    expect(auditApi.exportPlatformAuditLogs).toHaveBeenCalledWith({});
  });

  it('普通单租户页：导出不带 tenant_id（租户边界由服务端强制，前端不自行加条件）', async () => {
    setPermissions(['audit:read', 'audit:export']);
    const wrapper = mountPage(false);
    await flushPromises();

    await findExportButton(wrapper).trigger('click');
    await flushPromises();

    expect(auditApi.exportAuditLogs).toHaveBeenCalledWith({});
    expect(auditApi.exportPlatformAuditLogs).not.toHaveBeenCalled();
  });
});
