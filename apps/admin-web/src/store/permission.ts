/*
 * @file 权限路由状态store（Pinia）
 * @description 动态路由（PRD-005 FR-04）：菜单树由 /auth/menus 下发（后端已按权限过滤），
 *   前端再按 permissionCode 二次过滤后生成路由记录，杜绝「前端隐藏即安全」的绕过路径——
 *   未授权路径不进路由表，直接输 URL 落到 403/404（TC-WEB-001）。
 *   静态路由仅限 登录 / 403 / 404 / 工作台 / 个人中心，其余一律动态生成（PRD-005 §8 风险对策）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import type { RouteRecordRaw } from 'vue-router';
import * as authApi from '@/api/auth';
import type { MenuNode, PermissionCode } from '@/api/types';
import { useUserStore } from './user';

/** 已知系统路径（用于区分「无权限 → 403」与「不存在 → 404」） */
export const KNOWN_SYSTEM_PATHS: readonly string[] = [
  '/system/users',
  '/system/roles',
  '/system/menus',
  '/system/dict',
  '/system/audit-logs',
  '/system/queue',
  '/order/list',
];

/** 菜单 component 字段 → 视图模块映射（新增页面在此登记；生成器产出页面由 M6 追加） */
const VIEW_MODULES = import.meta.glob('../views/**/*.vue');

/** 按 component 字符串解析视图加载器（兼容 目录/index.vue 与 单文件.vue 两种落盘方式） */
function resolveComponent(component: string | null): (() => Promise<unknown>) | null {
  if (!component) return null;
  // 菜单 component 约定为 views 下相对路径且不带扩展名：'system/users' 与 'layout/blank' 均合法
  const candidates = [`/views/${component}/index.vue`, `/views/${component}.vue`];
  const key = Object.keys(VIEW_MODULES).find((path) => candidates.some((suffix) => path.endsWith(suffix)));
  if (!key) return null;
  const loader = VIEW_MODULES[key] as () => Promise<unknown>;
  return loader;
}

export const usePermissionStore = defineStore('permission', () => {
  /** 后端下发的菜单树（已按权限过滤） */
  const menus = ref<MenuNode[]>([]);
  /** 动态路由是否已注入（守卫只注入一次） */
  const routesAdded = ref(false);

  /** 拉取菜单树 */
  async function loadMenus(): Promise<MenuNode[]> {
    menus.value = await authApi.fetchMenus();
    return menus.value;
  }

  /** 侧边栏渲染用：仅可见节点 */
  function visibleMenus(): MenuNode[] {
    return menus.value.filter((m) => m.visible);
  }

  /**
   * 由菜单树生成路由记录
   * - 前端按 permissionCode 二次过滤（后端已过滤，双保险）；
   * - 有 path 的目录节点（如 /system）生成 layout/blank 父路由，其子菜单挂为 children；
   * - component 解析失败（视图未实现）的菜单跳过，避免死链。
   */
  function generateRoutes(): RouteRecordRaw[] {
    const user = useUserStore();
    const routes: RouteRecordRaw[] = [];

    const allowed = (node: MenuNode): boolean => {
      if (!node.visible) return false;
      if (node.permissionCode === null) return true;
      return user.hasPermission(node.permissionCode as PermissionCode);
    };

    const buildChildren = (nodes: MenuNode[], parentPath: string): RouteRecordRaw[] => {
      const children: RouteRecordRaw[] = [];
      for (const node of nodes) {
        if (!allowed(node)) continue;
        const loader = resolveComponent(node.component);
        if (!loader) continue;
        // 子路由必须用相对路径（vue-router 拼接规则）：全路径去掉父级前缀，否则 /system 下的 /system/users 会拼成 /system/system/users
        const full = node.path ?? '';
        const relative = (full.startsWith(parentPath) ? full.slice(parentPath.length) : full).replace(/^\/+/, '');
        children.push({
          path: relative,
          name: node.path ?? node.id,
          component: loader,
          meta: { title: node.name, icon: node.icon, permissionCode: node.permissionCode },
        });
      }
      return children;
    };

    for (const node of visibleMenus()) {
      if (!allowed(node)) continue;
      const loader = resolveComponent(node.component);
      if (!loader) continue;

      if (node.children.length > 0) {
        const children = buildChildren(node.children, node.path ?? '/');
        if (children.length === 0) continue;
        routes.push({
          path: node.path ?? '/',
          name: node.path ?? node.id,
          component: loader,
          meta: { title: node.name, icon: node.icon, permissionCode: node.permissionCode },
          children,
        });
      } else {
        routes.push({
          path: node.path ?? '/',
          name: node.path ?? node.id,
          component: loader,
          meta: { title: node.name, icon: node.icon, permissionCode: node.permissionCode },
        });
      }
    }
    return routes;
  }

  /** 重置（登出） */
  function reset(): void {
    menus.value = [];
    routesAdded.value = false;
  }

  return { menus, routesAdded, loadMenus, visibleMenus, generateRoutes, reset };
});
