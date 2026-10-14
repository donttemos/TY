/*
 * @file 动态路由注入（挂载到全局布局之下）
 * @description 修复「点进具体功能页后侧边栏消失」：权限菜单生成的路由记录原先以顶层记录注册，
 *   匹配链里不含布局路由 → 渲染的是 views/layout/blank.vue（只有 router-view），
 *   全局布局（侧边栏 / 顶栏 / 标签页）根本没被挂载，功能页只剩一块裸内容区。
 *   本模块统一以「布局路由的子路由」注册，并跳过与静态路由同路径的记录（如 /dashboard），
 *   避免同一路径出现两条记录导致匹配歧义。
 *   子路由 path 保留绝对路径写法（以 / 开头）：vue-router 会按绝对路径解析 url，
 *   但渲染层级仍嵌套在父路由的 router-view 内 —— 这正是「URL 不变、外壳不丢」所需。
 *   换号登录时传入上一轮注入的记录名，先移除再重建：动态路由不会随登出自动消失，
 *   否则上一个账号有权限的路径会继续留在路由表里（TC-WEB-001 未授权路径不进路由表）。
 * @author donttemo
 * @created 2026-10-14
 * @module admin-web/router
 */

import type { RouteRecordRaw, Router } from 'vue-router';
import { LAYOUT_ROUTE_NAME } from './routes';

/** 已注册路径集合（router.getRoutes() 返回的 child.path 已是含父级前缀的完整路径） */
function registeredPaths(router: Router): Set<string> {
  return new Set(router.getRoutes().map((record) => record.path));
}

/**
 * 把动态生成的路由记录注入路由表（挂在布局路由之下）
 * @param previouslyInjected 上一轮注入的记录名；会先被移除（换号登录时防止残留）
 * @returns 本轮实际注册的记录名（动态记录以 path 为 name，供下一轮清理使用）
 */
export function injectDynamicRoutes(
  router: Router,
  records: RouteRecordRaw[],
  previouslyInjected: readonly string[] = [],
): string[] {
  for (const name of previouslyInjected) {
    if (router.hasRoute(name)) router.removeRoute(name);
  }
  const existing = registeredPaths(router);
  const added: string[] = [];
  for (const record of records) {
    const path = record.path;
    // 静态路由已占位（工作台 / 个人中心）：跳过，保留静态记录（含 meta.affix 等标签页语义）
    if (existing.has(path)) continue;
    router.addRoute(LAYOUT_ROUTE_NAME, record);
    existing.add(path);
    added.push(typeof record.name === 'string' ? record.name : path);
  }
  return added;
}
