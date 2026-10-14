/*
 * @file 多标签页 回归护栏
 * @description 覆盖换号登录后的标签残留：标签持久化键必须按用户隔离，
 *   否则登出换号后仍会列出上一个账号开过的标签（点进去落 403）。
 * @author donttemo
 * @created 2026-10-14
 * @module admin-web/layout
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { flushPromises, mount } from '@vue/test-utils';
import { createMemoryHistory, createRouter } from 'vue-router';
import TagsView from '../TagsView.vue';
import { useUserStore } from '@/store/user';
import type { MeResult } from '@/api/types';

function me(id: string): MeResult {
  return { id, username: id, nickname: id, avatar: null, roles: [], permissions: [], dataScope: 'all' };
}

const Page = { template: '<div />' };

function buildRouter() {
  return createRouter({
    history: createMemoryHistory(),
    routes: [
      { path: '/system/users', name: 'Users', component: Page, meta: { title: '用户管理' } },
      { path: '/system/roles', name: 'Roles', component: Page, meta: { title: '角色权限' } },
    ],
  });
}

describe('标签页按用户隔离（换号不留上一个账号的标签）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
    localStorage.clear();
  });

  it('新账号看不到上一个账号的标签；切回原账号时其标签恢复', async () => {
    // admin 之前在本地留下的标签
    localStorage.setItem(
      'fw_admin_tags:u-admin',
      JSON.stringify([{ path: '/system/users', title: '用户管理', affix: false }]),
    );

    const router = buildRouter();
    await router.push('/system/roles');
    await router.isReady();

    const user = useUserStore();
    user.profile = me('u-alice');
    const wrapper = mount(TagsView, { global: { plugins: [router] } });
    await flushPromises();

    const titles = (): string[] => wrapper.findAll('.fw-tag').map((node) => node.text().replace('×', '').trim());
    // alice 只应有当前页，不得出现 admin 遗留的标签
    expect(titles()).toEqual(['角色权限']);

    // 切回 admin：标签换成 admin 自己的集合（当前页入签 + 恢复的标签）
    user.profile = me('u-admin');
    await flushPromises();
    expect(titles()).toContain('用户管理');
    expect(titles()).toContain('角色权限');

    // 两个账号各自的存储键互不污染
    expect(JSON.parse(localStorage.getItem('fw_admin_tags:u-alice') ?? '[]')).toEqual([
      { path: '/system/roles', title: '角色权限', affix: false },
    ]);
  });
});
