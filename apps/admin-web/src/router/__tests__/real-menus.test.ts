/*
 * @file 真机菜单数据 × 真实路由管线 集成护栏
 * @description 夹具 `./fixtures/real-menus.json` 是 2026-10-14 从真机 `106.55.32.251`
 *   （后端 `/api/v1/auth/menus`，admin 账号）**原样转储**的响应 data 段，不是手写的 mock。
 *   用真机数据跑真实管线（`generateRoutes()` → `injectDynamicRoutes()`）可覆盖
 *   「mock 形状 ≠ 真机形状」这一类只在部署后才暴露的缺陷：
 *     ① 生成器写库的 `views/<model>/index` 写法能否解析 —— 解析不了会被**静默跳过**、页面不可达；
 *     ② 目录节点 `layout/blank` 的子菜单是否真的嵌在全局布局内 —— 否则点进去侧边栏整块消失（BUG-16）；
 *     ③ 真机实际下发的菜单集合是否都注册成功 —— 任何「静默跳过」都会在这里暴露成数量不符。
 *   夹具只断言**结构关系**（谁嵌在谁下面），断言不依赖具体菜单条数，故种子调整不会使其变脆。
 * @author donttemo
 * @created 2026-10-14
 * @module admin-web/router
 */

import { createPinia, setActivePinia } from 'pinia';
import { beforeEach, describe, expect, it } from 'vitest';
import { createMemoryHistory, createRouter } from 'vue-router';
import realMenus from './fixtures/real-menus.json';
import { CATCH_ALL_NAME, LAYOUT_ROUTE_NAME, constantRoutes, notFoundRoute } from '../routes';
import { injectDynamicRoutes } from '../inject';
import { usePermissionStore } from '@/store/permission';
import { useUserStore } from '@/store/user';
import type { MeResult, MenuNode } from '@/api/types';

const MENUS = realMenus as unknown as MenuNode[];

/** 真机菜单里所有带 path 的节点（完整路径，含目录节点） */
function collectPaths(nodes: MenuNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.path) acc.push(node.path);
    if (node.children?.length) collectPaths(node.children, acc);
  }
  return acc;
}

/** 菜单里出现的全部权限码（用于把当前账号配成「真机 admin」的权限面） */
function collectCodes(nodes: MenuNode[], acc: string[] = []): string[] {
  for (const node of nodes) {
    if (node.permissionCode) acc.push(node.permissionCode);
    if (node.children?.length) collectCodes(node.children, acc);
  }
  return acc;
}

/** 复刻 guard.ts 的装配顺序：静态路由 → 动态注入 → 兜底 */
function buildRouter() {
  const permission = usePermissionStore();
  useUserStore().permissions = collectCodes(MENUS) as MeResult['permissions'];
  permission.menus = MENUS;
  const router = createRouter({ history: createMemoryHistory(), routes: constantRoutes });
  const added = injectDynamicRoutes(router, permission.generateRoutes());
  router.addRoute(notFoundRoute);
  return { router, added };
}

function matchNames(router: ReturnType<typeof buildRouter>['router'], path: string): (string | undefined)[] {
  return router.resolve(path).matched.map((record) => record.name as string | undefined);
}

describe('真机菜单数据（夹具取自 106.55.32.251 实际响应）', () => {
  beforeEach(() => {
    setActivePinia(createPinia());
  });

  it('夹具确为真机形状：含生成器写法 component 与 layout/blank 目录节点', () => {
    expect(collectPaths(MENUS)).toContain('/system/queue');
    const raw = JSON.stringify(MENUS);
    expect(raw).toContain('views/demo-item/index');
    expect(raw).toContain('layout/blank');
  });

  it('菜单里每一个页面都命中了自身的路由记录（无静默跳过，生成器写法也能解析）', () => {
    const { router, added } = buildRouter();
    // injectDynamicRoutes 返回的是**顶层**记录（目录节点的子页嵌在该记录内部，不会单列），
    // 故这里对顶层做集合断言；子页则由下面「逐个路径必须命中自身」来覆盖。
    // /dashboard 与静态路由同路径，按设计保留静态记录、不由动态注入重复注册。
    const topLevel = MENUS.map((node) => node.path).filter((path): path is string => Boolean(path) && path !== '/dashboard');
    expect([...added].sort()).toEqual([...topLevel].sort());
    expect(added).toContain('/system'); // 目录节点（子页嵌在它内部）
    expect(added).toContain('/demo-items'); // 生成器写法 component，必须能解析

    for (const path of collectPaths(MENUS).filter((p) => p !== '/dashboard')) {
      const names = matchNames(router, path);
      expect(names, `路径 ${path} 被静默跳过（落到了兜底路由）`).not.toContain(CATCH_ALL_NAME);
      expect(names.at(-1), `路径 ${path} 未命中自身记录：${JSON.stringify(names)}`).toBe(path);
    }
  });

  it('每个菜单页的匹配链都以布局路由开头（点进去侧边栏不消失）', () => {
    const { router } = buildRouter();
    for (const path of collectPaths(MENUS)) {
      const names = matchNames(router, path);
      expect(names[0], `路径 ${path} 的匹配链为 ${JSON.stringify(names)}`).toBe(LAYOUT_ROUTE_NAME);
      expect(names, `路径 ${path} 命中了兜底路由`).not.toContain(CATCH_ALL_NAME);
    }
  });

  it('目录类节点的子页三层嵌套：Layout → /system → 子页', () => {
    const { router } = buildRouter();
    expect(matchNames(router, '/system/users')).toEqual([LAYOUT_ROUTE_NAME, '/system', '/system/users']);
    expect(matchNames(router, '/system/queue')).toEqual([LAYOUT_ROUTE_NAME, '/system', '/system/queue']);
  });

  it('单层页（生成器落库的 views/<model>/index）两层嵌套：Layout → 页面', () => {
    const { router } = buildRouter();
    expect(matchNames(router, '/demo-items')).toEqual([LAYOUT_ROUTE_NAME, '/demo-items']);
  });

  it('与静态路由重名的 /dashboard 只保留一条记录且仍在布局内', () => {
    const { router } = buildRouter();
    expect(router.getRoutes().filter((record) => record.path === '/dashboard')).toHaveLength(1);
    expect(matchNames(router, '/dashboard')).toEqual([LAYOUT_ROUTE_NAME, 'Dashboard']);
  });
});
