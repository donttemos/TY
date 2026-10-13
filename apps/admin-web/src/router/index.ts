/*
 * @file 路由实例
 * @description history 模式 + 静态路由 + 守卫；404 兜底路由在守卫注入动态路由后追加注册，
 *   保证「未授权 URL 被拦截」时优先命中 403 而非兜底 404（顺序：静态 → 动态 → 兜底）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/router
 */

import { createRouter, createWebHistory } from 'vue-router';
import { constantRoutes } from './routes';
import { setupRouterGuard } from './guard';

const router = createRouter({
  history: createWebHistory(),
  routes: constantRoutes,
  scrollBehavior: () => ({ top: 0 }),
});

setupRouterGuard(router);

export { router };
export default router;
