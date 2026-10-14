/*
 * @file 权限路由 store 单元测试
 * @description 覆盖动态路由生成（PRD-005 FR-04 / TC-WEB-001）：
 *   菜单树 → 路由记录转换、component 字符串解析（目录/index.vue 与单文件两种落盘）、
 *   子路由相对路径拼接（防 /system/system/users）、权限码过滤（无权限菜单不进路由表）、
 *   视图未实现的菜单跳过（防死链）、visible 过滤与 reset。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 补 2 个回归护栏：visible 递归剪枝（隐藏子菜单不进侧边栏）、
 *   component 归一化（生成器落库的 views/<model>/index 必须能解析到视图）
 * @module admin-web/store
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { usePermissionStore } from '../permission';
import { useUserStore } from '../user';
import type { MenuNode } from '@/api/types';

/** 构造菜单节点（path 为全路径，与后端 /auth/menus 下发结构一致） */
function menu(partial: Partial<MenuNode> & { id: string; name: string }): MenuNode {
  return {
    path: null,
    component: null,
    icon: null,
    permissionCode: null,
    visible: true,
    sort: 1,
    children: [],
    ...partial,
  };
}

const MENU_TREE: MenuNode[] = [
  menu({ id: 'm-dashboard', name: '控制台', path: '/dashboard', component: 'dashboard/index', sort: 1 }),
  menu({
    id: 'm-system',
    name: '系统管理',
    path: '/system',
    component: 'layout/blank',
    sort: 2,
    children: [
      menu({ id: 'm-users', name: '用户管理', path: '/system/users', component: 'system/users', permissionCode: 'user:read', sort: 1 }),
      menu({ id: 'm-roles', name: '角色权限', path: '/system/roles', component: 'system/roles', permissionCode: 'role:read', sort: 2 }),
      // 视图未实现：必须跳过，避免死链
      menu({ id: 'm-ghost', name: '幽灵菜单', path: '/system/ghost', component: 'system/not-exist', sort: 3 }),
      // 隐藏菜单：侧边栏与路由都不生成
      menu({ id: 'm-hidden', name: '隐藏菜单', path: '/system/hidden', component: 'system/users', visible: false, sort: 4 }),
    ],
  }),
];

describe('权限路由生成', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('目录菜单生成父路由 + 子路由，component 解析为加载器', () => {
    const permission = usePermissionStore();
    const user = useUserStore();
    permission.menus = MENU_TREE;
    user.permissions = ['user:read'];

    const routes = permission.generateRoutes();
    const dashboard = routes.find((r) => r.path === '/dashboard');
    expect(dashboard).toBeDefined();
    expect(typeof dashboard?.component).toBe('function');

    const system = routes.find((r) => r.path === '/system');
    expect(system).toBeDefined();
    // 用户有权限的 users 进路由；roles 无权限、ghost 无视图、hidden 不可见 —— 均被剔除
    expect(system?.children).toHaveLength(1);
    expect(system?.children?.[0]?.name).toBe('/system/users');
    expect(typeof system?.children?.[0]?.component).toBe('function');
  });

  it('子路由使用相对路径：/system 下的 /system/users 拼成 users（而非 system/users）', () => {
    const permission = usePermissionStore();
    const user = useUserStore();
    permission.menus = MENU_TREE;
    user.permissions = ['user:read', 'role:read'];

    const system = permission.generateRoutes().find((r) => r.path === '/system');
    const childPaths = system?.children?.map((c) => c.path) ?? [];
    expect(childPaths).toEqual(['users', 'roles']);
    // 回归护栏：曾出现把全路径当相对路径导致 /system/system/users 的问题
    expect(childPaths).not.toContain('system/users');
  });

  it('无任何权限时系统管理目录整体消失（children 空则跳过父路由）', () => {
    const permission = usePermissionStore();
    permission.menus = MENU_TREE;
    // 默认 permissions 为空数组

    const routes = permission.generateRoutes();
    expect(routes.find((r) => r.path === '/system')).toBeUndefined();
    // 无权限码的 dashboard 仍可访问（登录即可见）
    expect(routes.find((r) => r.path === '/dashboard')).toBeDefined();
  });

  it('visibleMenus 过滤不可见菜单，reset 清空状态', () => {
    const permission = usePermissionStore();
    permission.menus = MENU_TREE;
    expect(permission.visibleMenus().map((m) => m.id)).toEqual(['m-dashboard', 'm-system']);

    permission.reset();
    expect(permission.menus).toHaveLength(0);
    expect(permission.routesAdded).toBe(false);
  });

  it('visibleMenus 递归剪枝：不可见子菜单不出现在侧边栏', () => {
    const permission = usePermissionStore();
    permission.menus = MENU_TREE;
    const system = permission.visibleMenus().find((m) => m.id === 'm-system');
    // m-hidden 为 visible=false，必须从侧边栏数据里剔除（否则点击落 404）
    expect(system?.children.map((c) => c.id)).not.toContain('m-hidden');
    expect(system?.children.map((c) => c.id)).toEqual(['m-users', 'm-roles', 'm-ghost']);
  });

  it('component 归一化：生成器写库的 views/<model>/index 也能解析到视图（M6 回归护栏）', () => {
    const permission = usePermissionStore();
    permission.menus = [
      // prisma/seed/demo-item.seed.ts 实际落库值（相对 web/src，而非相对 views）
      menu({ id: 'm-demo-items', name: 'DemoItem管理', path: '/demo-items', component: 'views/demo-item/index', permissionCode: 'demo-item:read' }),
      // 单文件落盘（views/layout/blank.vue）
      menu({ id: 'm-blank', name: '空布局', path: '/blank', component: 'layout/blank' }),
    ];
    useUserStore().permissions = ['demo-item:read'];

    const routes = permission.generateRoutes();
    const generated = routes.find((r) => r.path === '/demo-items');
    expect(generated).toBeDefined();
    expect(typeof generated?.component).toBe('function');
    expect(routes.find((r) => r.path === '/blank')).toBeDefined();
  });
});
