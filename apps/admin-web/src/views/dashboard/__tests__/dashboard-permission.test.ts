/*
 * @file 工作台按权限取数 回归护栏
 * @description 真机实测发现：工作台（v0.1.0 起未改动）无条件并发请求 /users、/roles、/permissions、/audit-logs，
 *   低权限账号（alice：仅 user:read + dict:read）登录后必然吃 3 条 403，并把**无权读取的指标显示成 0**
 *   —— 0 与「真实为 0」无法区分，属误导；「常用入口」还会列出无权进入的页面。
 *   本组断言把修复钉住：① 无权端点**不发请求**；② 卡片按权限裁剪；③ 取数失败显示「—」而非 0；
 *   ④ 一个指标都不可读时给明确说明、不渲染空卡片；⑤ 高权限账号四张卡齐全。
 * @author donttemo
 * @created 2026-10-14
 * @module admin-web/views
 */

import { flushPromises, mount } from '@vue/test-utils';
import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/api/user', () => ({ fetchUsers: vi.fn() }));
vi.mock('@/api/role', () => ({ fetchRoles: vi.fn(), fetchPermissionGroups: vi.fn() }));
vi.mock('@/api/audit', () => ({ fetchAuditLogs: vi.fn() }));
vi.mock('vue-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('vue-router')>()),
  useRouter: () => ({ push: vi.fn() }),
}));

import * as userApi from '@/api/user';
import * as roleApi from '@/api/role';
import * as auditApi from '@/api/audit';
import { useUserStore } from '@/store/user';
import type { MeResult } from '@/api/types';
import Dashboard from '@/views/dashboard/index.vue';

/** v-loading 由 Element Plus 提供，单测里给个空指令占位 */
const mountOpts = { global: { directives: { loading: {} } } };

function setPermissions(codes: string[]): void {
  useUserStore().permissions = codes as MeResult['permissions'];
}

describe('工作台按权限取数（真机 403 / 误导性 0 的修复护栏）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(userApi.fetchUsers).mockResolvedValue({ items: [], total: 7, page: 1, pageSize: 1, hasMore: false });
    vi.mocked(roleApi.fetchRoles).mockResolvedValue([]);
    vi.mocked(roleApi.fetchPermissionGroups).mockResolvedValue([]);
    vi.mocked(auditApi.fetchAuditLogs).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 1, hasMore: false });
  });

  it('低权限账号（仅 user:read）只请求 /users，绝不请求 /roles、/permissions、/audit-logs', async () => {
    setPermissions(['user:read']);
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(userApi.fetchUsers).toHaveBeenCalledTimes(1);
    expect(roleApi.fetchRoles).not.toHaveBeenCalled();
    expect(roleApi.fetchPermissionGroups).not.toHaveBeenCalled();
    expect(auditApi.fetchAuditLogs).not.toHaveBeenCalled();

    // 卡片只留有权限的那一张
    expect(wrapper.text()).toContain('用户数');
    expect(wrapper.text()).not.toContain('角色数');
    expect(wrapper.text()).not.toContain('权限点');
    expect(wrapper.text()).not.toContain('审计记录');
  });

  it('常用入口按权限过滤（不出现点了就 403 的死入口）', async () => {
    setPermissions(['user:read']);
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('常用入口');
    expect(wrapper.text()).toContain('用户管理');
    expect(wrapper.text()).not.toContain('角色权限');
    expect(wrapper.text()).not.toContain('审计日志');
  });

  it('一个指标都不可读时不渲染空卡片，给出明确说明', async () => {
    setPermissions([]);
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('没有可查看的统计指标');
    expect(userApi.fetchUsers).not.toHaveBeenCalled();
    expect(roleApi.fetchRoles).not.toHaveBeenCalled();
    expect(roleApi.fetchPermissionGroups).not.toHaveBeenCalled();
    expect(auditApi.fetchAuditLogs).not.toHaveBeenCalled();
    // 无任何入口时整块隐藏
    expect(wrapper.text()).not.toContain('常用入口');
  });

  it('取数失败显示「—」而不是 0（0 会被读成「真实为 0」）', async () => {
    setPermissions(['user:read', 'audit:read']);
    vi.mocked(userApi.fetchUsers).mockRejectedValueOnce(new Error('403'));

    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('—');
    // 成功的那一项仍显示真实数值，失败项不冒充 0
    expect(wrapper.text()).toContain('0');
  });

  it('高权限账号（四项权限齐全）四张卡齐全且各请求一次', async () => {
    setPermissions(['user:read', 'role:read', 'permission:read', 'audit:read']);
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(userApi.fetchUsers).toHaveBeenCalledTimes(1);
    expect(roleApi.fetchRoles).toHaveBeenCalledTimes(1);
    expect(roleApi.fetchPermissionGroups).toHaveBeenCalledTimes(1);
    expect(auditApi.fetchAuditLogs).toHaveBeenCalledTimes(1);
    for (const label of ['用户数', '角色数', '权限点', '审计记录']) {
      expect(wrapper.text()).toContain(label);
    }
    expect(wrapper.text()).toContain('用户管理');
    expect(wrapper.text()).toContain('角色权限');
    expect(wrapper.text()).toContain('审计日志');
  });
});
