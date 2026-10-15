/*
 * @file 工作台按权限取数 回归护栏
 * @description 真机实测发现：工作台（v0.1.0 起未改动）无条件并发请求 /users、/roles、/permissions、/audit-logs，
 *   低权限账号（alice：仅 user:read + dict:read）登录后必然吃 3 条 403，并把**无权读取的指标显示成 0**
 *   —— 0 与「真实为 0」无法区分，属误导；「常用入口」还会列出无权进入的页面。
 *   本组断言把修复钉住：① 无权端点**不发请求**；② 卡片按权限裁剪；③ 取数失败显示「—」而非 0；
 *   ④ 一个指标都不可读时给明确说明、不渲染空卡片；⑤ 高权限账号四张卡齐全。
 * @modified 2026-10-15 donttemo R4-05：新增口径标注断言——self/org_below 档范围敏感卡带「（限…）」，
 *   all 档不标注（反向验证）、全局目录卡（角色数/权限点）不标注、失败项标注仍在。
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

describe('R4-05：统计口径与 dataScope 对齐标注', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    vi.clearAllMocks();
    vi.mocked(userApi.fetchUsers).mockResolvedValue({ items: [], total: 7, page: 1, pageSize: 1, hasMore: false });
    vi.mocked(roleApi.fetchRoles).mockResolvedValue([]);
    vi.mocked(roleApi.fetchPermissionGroups).mockResolvedValue([]);
    vi.mocked(auditApi.fetchAuditLogs).mockResolvedValue({ items: [], total: 3, page: 1, pageSize: 1, hasMore: false });
  });

  function setProfile(dataScope: MeResult['dataScope']): void {
    useUserStore().profile = {
      id: 'u1',
      username: 'alice',
      nickname: 'Alice',
      avatar: null,
      roles: ['user'],
      permissions: [],
      dataScope,
    } as MeResult;
  }

  it('self 档：范围敏感卡（用户数 / 审计记录）标注「（限本人）」，与后端 dataScope 收敛语义一致', async () => {
    setPermissions(['user:read', 'audit:read']);
    setProfile('self');
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('限本人');
    // 数字本身是范围内数量（后端已收敛），标注防止「用户数 1」被误读为全站规模
    expect(wrapper.text()).toContain('7');
  });

  it('org_below 档：标注「（限本部门及下级）」', async () => {
    setPermissions(['user:read', 'audit:read']);
    setProfile('org_below');
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('限本部门及下级');
    expect(wrapper.text()).not.toContain('限本人');
  });

  it('反向验证：all 档不产生口径标注（全部数据不需要提示）', async () => {
    setPermissions(['user:read', 'audit:read']);
    setProfile('all');
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('用户数');
    expect(wrapper.text()).not.toContain('（限');
  });

  it('反向验证：全局目录卡（角色数 / 权限点）不随档位标注（无范围概念）', async () => {
    setPermissions(['user:read', 'role:read', 'permission:read', 'audit:read']);
    setProfile('self');
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    // 角色数 / 权限点行的 label 不带「限」——标注只出现在范围敏感卡上
    const text = wrapper.text();
    expect(text).toContain('角色数');
    expect(text).toContain('权限点');
    expect(text).not.toContain('角色数（限');
    expect(text).not.toContain('权限点（限');
  });

  it('取数失败时标注仍在（失败项显示「—（限本人）」语义完整）', async () => {
    setPermissions(['user:read', 'audit:read']);
    setProfile('self');
    vi.mocked(userApi.fetchUsers).mockRejectedValueOnce(new Error('boom'));
    const wrapper = mount(Dashboard, mountOpts);
    await flushPromises();

    expect(wrapper.text()).toContain('限本人');
    expect(wrapper.text()).toContain('—');
  });
});
