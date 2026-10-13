/*
 * @file 静态路由表
 * @description 仅登记公开页与框架页（PRD-005 §8 风险对策：业务路由一律由权限树动态生成，静态路由只限
 *   登录 / 403 / 404 / 工作台 / 个人中心）。404 兜底路由必须最后注册。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/router
 */

import type { RouteRecordRaw } from 'vue-router';

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
    path: '/redirect/:pathMatch(.*)*',
    name: 'Redirect',
    component: () => import('@/views/redirect/index.vue'),
    meta: { title: '刷新', public: true, hiddenInTabs: true },
  },
  {
    path: '/',
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
    ],
  },
];

/** 404 兜底：必须在动态路由之后注册（见 router/index.ts） */
export const notFoundRoute: RouteRecordRaw = {
  path: '/:pathMatch(.*)*',
  name: 'CatchAll',
  component: () => import('@/views/error/404.vue'),
  meta: { title: '页面不存在', public: true, hiddenInTabs: true },
};
