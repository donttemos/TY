/*
 * @file 路由守卫
 * @description 全局前置守卫（PRD-005 FR-04 / TC-WEB-001）：
 *   1. 公开页（login/403/404）直接放行；
 *   2. 白名单外页面：先恢复会话（refresh token 无感换 access，TC-WEB-003）；
 *   3. 首次进入拉取用户资料与菜单树，动态注入路由后 replace 重解析；
 *   4. 目标路径已注册 → 放行；未注册且属已知系统路径 → 403；完全未知 → 404。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 修复 2 项缺陷：① 动态路由改为经 injectDynamicRoutes 挂到布局路由之下
 *   （原顶层 addRoute 导致功能页脱离全局布局、侧边栏消失）；② 403 分支是死代码 —— 兜底 404 路由
 *   已注册后 router.resolve 对任何路径都有 matched，判定改为「匹配链是否命中兜底路由」
 * @modified 2026-10-14 donttemo 修复换号登录残留：原判据 `!routesAdded` 在登出后换号时仍为 true，
 *   导致菜单与路由表停留在上一个账号（侧边栏显示别人的菜单、别人的页面仍可路由）；
 *   改为按「菜单所属用户 id」判定并重建（重建时移除上一轮注入的记录）
 * @module admin-web/router
 */

import type { Router } from 'vue-router';
import { usePermissionStore, KNOWN_SYSTEM_PATHS } from '@/store/permission';
import { useUserStore } from '@/store/user';
import { ElMessage } from 'element-plus';
import { CATCH_ALL_NAME, notFoundRoute } from './routes';
import { injectDynamicRoutes } from './inject';

/** 无需登录的页面 */
function isPublicPath(path: string): boolean {
  return path === '/login' || path === '/403' || path === '/404';
}

/**
 * 目标路径未被真实路由匹配时的去向判定（纯函数，便于单测）
 * @param path 目标路径
 * @param matchedNames 路由解析出的匹配链上的记录名
 * @returns null 表示命中真实路由（放行）；否则返回要跳转的公开页
 */
export function resolveFallback(
  path: string,
  matchedNames: readonly (string | null | undefined)[],
): null | '/403' | '/404' {
  // 兜底 404 路由已注册 → 任何路径都有 matched，只能靠「是否命中兜底记录」区分
  const hitCatchAll = matchedNames.some((name) => name === CATCH_ALL_NAME);
  if (!hitCatchAll) return null;
  return KNOWN_SYSTEM_PATHS.includes(path) ? '/403' : '/404';
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

    // 2) 菜单 + 动态路由：首次进入，或登录用户已变化（登出后换号登录）时重新加载并重建路由表。
    //    仅判 routesAdded 是不够的 —— 登出换号时它仍为 true，会导致侧边栏与路由表停留在上一个账号
    //    （菜单、权限、可达页面全是别人的）。改按「菜单所属用户」判定，登出与换号都能自愈。
    const ownerId = user.profile?.id ?? null;
    if (!permission.routesAdded || permission.menusOwnerId !== ownerId) {
      try {
        await permission.loadMenus();
      } catch {
        // 菜单拉取失败：保持已登录态跳 403，避免白屏
        return '/403';
      }
      permission.injectedRouteNames = injectDynamicRoutes(
        router,
        permission.generateRoutes(),
        permission.injectedRouteNames,
      );
      // 兜底 404 必须最后注册，否则会抢先匹配动态路由
      if (!router.hasRoute(CATCH_ALL_NAME)) {
        router.addRoute(notFoundRoute);
      }
      permission.menusOwnerId = ownerId;
      permission.routesAdded = true;
      // 重新解析目标（此时动态路由已就绪）
      return { ...to, replace: true };
    }

    // 3) 权限判定：命中真实路由 → 放行；已知系统路径 → 403；其余 → 404
    const resolved = router.resolve(to.fullPath);
    const fallback = resolveFallback(
      to.path,
      resolved.matched.map((record) => record.name as string | undefined),
    );
    return fallback === null ? true : fallback;
  });

  // 动态路由解析失败（replace 后仍无匹配）兜底到 404，避免控制台报错
  router.onError((error) => {
    ElMessage.error(`路由加载失败：${error.message}`);
  });
}
