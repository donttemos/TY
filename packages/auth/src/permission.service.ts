/*
 * @file 权限解析、缓存与菜单树
 * @description PRD-003 FR-04/FR-09/NFR：按 user_role → role_permission 聚合权限码并缓存（默认 60s），
 *   角色/权限变更后按 `user:<id>` 标签主动失效（PRD-003 §8 风险缓解），保证「接口权限变更即时生效」；
 *   菜单树按用户权限码过滤后组装，前后端权限同源（TC-AUTH-009）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import type { AuthCachePort } from './auth-cache.js';
import type { AuthStore } from './auth-store.js';
import { DEFAULT_PERMISSION_CACHE_TTL_SECONDS } from './constants.js';
import type { AuthMenu, DataScope, ID, MenuNode } from './types.js';

/** 权限缓存键前缀 */
const PERM_CACHE_PREFIX = 'auth:perm:';

/** 数据范围宽度排序（越靠前越宽） */
const SCOPE_ORDER: DataScope[] = ['all', 'org_below', 'org', 'self'];

/** 用户鉴权上下文（守卫使用） */
export interface UserAuthContext {
  /** 角色编码列表 */
  roles: string[];
  /** 权限码列表 */
  permissions: string[];
  /** 生效数据范围（多角色取最宽） */
  dataScope: DataScope;
}

/**
 * 权限服务：解析 + 缓存 + 菜单树
 */
export class PermissionService {
  /**
   * @param store 鉴权存储
   * @param cache 缓存端口
   * @param ttlSeconds 权限缓存 TTL（秒）
   */
  constructor(
    private readonly store: AuthStore,
    private readonly cache: AuthCachePort,
    private readonly ttlSeconds: number = DEFAULT_PERMISSION_CACHE_TTL_SECONDS,
  ) {}

  /**
   * 取用户鉴权上下文：缓存优先，未命中回源并写入（标签 `user:<id>`）
   * @param userId 用户 ID
   * @returns 角色、权限码与数据范围
   */
  async getUserContext(userId: ID): Promise<UserAuthContext> {
    const key = `${PERM_CACHE_PREFIX}${userId}`;
    const cached = await this.cache.get<UserAuthContext>(key);
    if (cached) return cached;

    const [roles, permissions] = await Promise.all([
      this.store.listRolesByUserId(userId),
      this.store.listPermissionsByUserId(userId),
    ]);
    const context: UserAuthContext = {
      roles: roles.map((r) => r.code),
      permissions: permissions.map((p) => p.code),
      dataScope: PermissionService.widestDataScope(roles.map((r) => r.dataScope)),
    };
    await this.cache.set(key, context, this.ttlSeconds, [`user:${userId}`]);
    return context;
  }

  /**
   * 失效单个用户的权限缓存（角色/权限变更后调用）
   * @param userId 用户 ID
   */
  async invalidateUser(userId: ID): Promise<void> {
    await this.cache.invalidateTag(`user:${userId}`);
  }

  /**
   * 失效多个用户（例如某角色被改权限后，所有持有该角色的用户）
   * @param userIds 用户 ID 列表
   */
  async invalidateUsers(userIds: ID[]): Promise<void> {
    for (const id of userIds) await this.invalidateUser(id);
  }

  /**
   * 取用户可见菜单树
   * @param userId 用户 ID（用于取权限码）
   * @param permissions 已解析权限码（守卫已加载时可直接传入，避免二次回源）
   * @returns 菜单树（含 children）
   */
  async getMenuTree(userId: ID, permissions?: string[]): Promise<MenuNode[]> {
    const codes = permissions ?? (await this.getUserContext(userId)).permissions;
    const all = await this.store.listMenus();
    const visible = all.filter((menu) => !menu.permissionCode || codes.includes(menu.permissionCode));
    return PermissionService.buildTree(visible);
  }

  /**
   * 判断权限是否满足（全部命中才算通过）
   * @param owned 已持有权限码
   * @param required 接口要求的权限码
   */
  static hasAll(owned: string[], required: string[]): boolean {
    if (required.length === 0) return true;
    const set = new Set(owned);
    return required.every((code) => set.has(code));
  }

  /**
   * 多角色数据范围取最宽（all > org_below > org > self）
   * @param scopes 各角色数据范围
   * @returns 生效范围；空数组返回 self（最小权限，默认安全）
   */
  static widestDataScope(scopes: DataScope[]): DataScope {
    if (scopes.length === 0) return 'self';
    let best = scopes[0];
    for (const scope of scopes) {
      if (SCOPE_ORDER.indexOf(scope) < SCOPE_ORDER.indexOf(best)) best = scope;
    }
    return best;
  }

  /**
   * 扁平菜单 → 树（parentId='0' 为根；父节点缺失时按根处理，保证不丢菜单）
   * @param menus 扁平菜单列表
   * @returns 菜单树
   */
  static buildTree(menus: AuthMenu[]): MenuNode[] {
    const nodes = new Map<string, MenuNode>();
    for (const menu of menus) {
      const { parentId: _parentId, ...rest } = menu;
      nodes.set(menu.id, { ...rest, children: [] });
    }
    const roots: MenuNode[] = [];
    for (const menu of menus) {
      const node = nodes.get(menu.id) as MenuNode;
      const parent = menu.parentId && menu.parentId !== '0' ? nodes.get(menu.parentId) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    }
    const sortRecursive = (list: MenuNode[]): void => {
      list.sort((a, b) => a.sort - b.sort || (a.id < b.id ? -1 : 1));
      for (const item of list) sortRecursive(item.children);
    };
    sortRecursive(roots);
    return roots;
  }
}
