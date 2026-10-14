/*
 * @file 静态路由表
 * @description 仅登记公开页与框架页（PRD-005 §8 风险对策：业务路由一律由权限树动态生成，静态路由只限
 *   登录 / 403 / 404 / 工作台 / 个人中心）。404 兜底路由必须最后注册。
 *   布局路由具名（LAYOUT_ROUTE_NAME），动态路由以「子路由」方式挂到它下面 —— 见 router/inject.ts。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 修复「点进功能页侧边栏消失」：布局路由补 name 供动态路由挂载；
 *   /redirect 从顶层移入布局内 —— 原先顶层注册会让标签页「刷新」把整个外壳（侧边栏/顶栏）卸载重建
 * @modified 2026-10-14 donttemo 真机验证中清理：上一层改动只做了「新增布局内记录」而**未删除顶层同名记录**，
 *   导致同一 path/name 注册两次（vue-router 静默以后者覆盖前者），与上方注释不符且属隐患 →
 *   移除顶层 /redirect，仅保留布局内那一条；并由 __tests__/layout-nesting.test.ts 锁定「路由表无重名」
 * @module admin-web/router
 */

import type { RouteRecordRaw } from 'vue-router';

/** 全局布局路由名：动态路由必须作为它的子路由注册，否则功能页会脱离侧边栏/顶栏 */
export const LAYOUT_ROUTE_NAME = 'Layout';

/** 404 兜底路由名：守卫用它区分「命中兜底」与「命中真实路由」 */
export const CATCH_ALL_NAME = 'CatchAll';

export const constantRoutes: RouteRecordRaw[] = [
  {
    path: '/login',
    name: 'Login',
    component: () => import('@/views/login/index.vue'),
    meta: { title: '登录', public: true, hiddenInTabs: true },
  },
  {
    path: '/403',
    name: 'Forbidden',
    component: () => import('@/views/error/403.vue'),
    meta: { title: '无权限', public: true, hiddenInTabs: true },
  },
  {
    path: '/404',
    name: 'NotFound',
    component: () => import('@/views/error/404.vue'),
    meta: { title: '页面不存在', public: true, hiddenInTabs: true },
  },
  {
    path: '/',
    name: LAYOUT_ROUTE_NAME,
    component: () => import('@/layout/index.vue'),
    redirect: '/dashboard',
    children: [
      {
        path: 'dashboard',
        name: 'Dashboard',
        component: () => import('@/views/dashboard/index.vue'),
        meta: { title: '工作台', icon: 'home', affix: true },
      },
      {
        path: 'profile',
        name: 'Profile',
        component: () => import('@/views/profile/index.vue'),
        meta: { title: '个人中心', hiddenInMenu: true },
      },
      {
        // 标签页「刷新」用：必须留在布局内，否则整块外壳会被卸载重建（侧边栏闪失）
        path: '/redirect/:pathMatch(.*)*',
        name: 'Redirect',
        component: () => import('@/views/redirect/index.vue'),
        meta: { title: '刷新', public: true, hiddenInTabs: true, hiddenInMenu: true },
      },
    ],
  },
];

/** 404 兜底：必须在动态路由之后注册（见 router/index.ts） */
export const notFoundRoute: RouteRecordRaw = {
  path: '/:pathMatch(.*)*',
  name: CATCH_ALL_NAME,
  component: () => import('@/views/error/404.vue'),
  meta: { title: '页面不存在', public: true, hiddenInTabs: true },
};
