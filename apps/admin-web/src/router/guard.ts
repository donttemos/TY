/*
 * @file 路由守卫
 * @description 全局前置守卫（PRD-005 FR-04 / TC-WEB-001）：
 *   1. 公开页（login/403/404）直接放行；
 *   2. 白名单外页面：先恢复会话（refresh token 无感换 access，TC-WEB-003）；
 *   3. 首次进入拉取用户资料与菜单树，动态注入路由后 replace 重解析；
 *   4. 目标路径已注册 → 放行；未注册且属已知系统路径 → 403；完全未知 → 404。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/router
 */

import type { Router } from 'vue-router';
import { usePermissionStore, KNOWN_SYSTEM_PATHS } from '@/store/permission';
import { useUserStore } from '@/store/user';
import { ElMessage } from 'element-plus';
import { notFoundRoute } from './routes';

/** 无需登录的页面 */
function isPublicPath(path: string): boolean {
  return path === '/login' || path === '/403' || path === '/404';
}

/** 注册全局前置守卫 */
export function setupRouterGuard(router: Router): void {
  router.beforeEach(async (to) => {
    const user = useUserStore();
    const permission = usePermissionStore();

    if (isPublicPath(to.path)) {
      // 已登录用户访问登录页 → 回工作台
      if (to.path === '/login' && user.isLoggedIn) return '/dashboard';
      return true;
    }

    // 1) 恢复会话（内存令牌丢失时用 refresh 无感恢复）
    if (!user.isLoggedIn) {
      const restored = await user.restoreSession();
      if (!restored) {
        return { path: '/login', query: { redirect: to.fullPath } };
      }
    }

    // 2) 动态路由只注入一次
    if (!permission.routesAdded) {
      try {
        await permission.loadMenus();
      } catch {
        // 菜单拉取失败：保持已登录态跳 403，避免白屏
        return '/403';
      }
      for (const route of permission.generateRoutes()) {
        router.addRoute(route);
      }
      // 兜底 404 必须最后注册，否则会抢先匹配动态路由
      router.addRoute(notFoundRoute);
      permission.routesAdded = true;
      // 重新解析目标（此时动态路由已就绪）
      return { ...to, replace: true };
    }

    // 3) 权限判定：已注册路由 → 放行；已知系统路径未注册 → 403；否则 404
    const resolved = router.resolve(to.fullPath);
    if (resolved.matched.length > 0) return true;
    if (KNOWN_SYSTEM_PATHS.includes(to.path)) {
      return '/403';
    }
    return '/404';
  });

  // 动态路由解析失败（replace 后仍无匹配）兜底到 404，避免控制台报错
  router.onError((error) => {
    ElMessage.error(`路由加载失败：${error.message}`);
  });
}
