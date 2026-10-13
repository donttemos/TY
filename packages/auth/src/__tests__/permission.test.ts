/*
 * @file 权限解析与菜单树单测
 * @description 覆盖权限上下文缓存与按 user 标签失效（TC-AUTH-009）、多角色数据范围取最宽、
 *   菜单树构建（层级 / 排序 / 孤儿节点）、按权限码过滤菜单
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { MemoryAuthCache } from '../auth-cache.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import { PermissionService } from '../permission.service.js';
import { PERM, ROLE } from '../constants.js';
import type { AuthMenu } from '../types.js';

/** 组装 store + service */
function build(): { store: MemoryAuthStore; service: PermissionService } {
  const store = new MemoryAuthStore();
  const service = new PermissionService(store, new MemoryAuthCache(), 60);
  return { store, service };
}

describe('PermissionService · 上下文与缓存', () => {
  it('按角色聚合权限码，多角色数据范围取最宽', async () => {
    const { store, service } = build();
    const narrow = store.seedRole({ code: 'viewer', name: '查看者', dataScope: 'self', isSystem: false });
    const wide = store.seedRole({ code: ROLE.ADMIN, name: '管理员', dataScope: 'org_below', isSystem: true });
    const read = store.seedPermission({ code: PERM.USER_READ, name: '读用户', type: 'api', module: 'user' });
    const grant = store.seedPermission({ code: PERM.ROLE_GRANT, name: '授权', type: 'api', module: 'role' });
    await store.replaceRolePermissions(narrow.id, [read.id]);
    await store.replaceRolePermissions(wide.id, [grant.id]);
    const user = store.seedUser({
      username: 'u',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await store.replaceUserRoles(user.id, [narrow.id, wide.id]);

    const context = await service.getUserContext(user.id);
    expect(context.permissions.sort()).toEqual([PERM.ROLE_GRANT, PERM.USER_READ].sort());
    expect(context.roles.sort()).toEqual(['admin', 'viewer']);
    // org_below 宽于 self
    expect(context.dataScope).toBe('org_below');
  });

  it('TC-AUTH-009：缓存命中后不回源，按 user 标签失效后立即生效', async () => {
    const { store, service } = build();
    const role = store.seedRole({ code: 'r1', name: 'r1', dataScope: 'self', isSystem: false });
    const p1 = store.seedPermission({ code: 'a:read', name: 'a', type: 'api', module: 'a' });
    const p2 = store.seedPermission({ code: 'b:write', name: 'b', type: 'api', module: 'b' });
    await store.replaceRolePermissions(role.id, [p1.id]);
    const user = store.seedUser({
      username: 'u',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await store.replaceUserRoles(user.id, [role.id]);

    expect((await service.getUserContext(user.id)).permissions).toEqual(['a:read']);

    // 直接改库但不清缓存：仍读到旧值（证明命中缓存）
    await store.replaceRolePermissions(role.id, [p2.id]);
    expect((await service.getUserContext(user.id)).permissions).toEqual(['a:read']);

    // 主动失效后立刻读到新值
    await service.invalidateUser(user.id);
    expect((await service.getUserContext(user.id)).permissions).toEqual(['b:write']);
  });

  it('无角色用户权限为空、数据范围为最小权限 self', async () => {
    const { store, service } = build();
    const user = store.seedUser({
      username: 'nobody',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    const context = await service.getUserContext(user.id);
    expect(context.permissions).toEqual([]);
    expect(context.roles).toEqual([]);
    expect(context.dataScope).toBe('self');
  });

  it('hasAll 语义：全部命中才通过，空要求直接通过', () => {
    expect(PermissionService.hasAll(['a', 'b'], ['a'])).toBe(true);
    expect(PermissionService.hasAll(['a'], ['a', 'b'])).toBe(false);
    expect(PermissionService.hasAll([], [])).toBe(true);
  });

  it('widestDataScope 优先级：all > org_below > org > self，空数组回落 self', () => {
    expect(PermissionService.widestDataScope(['self', 'org'])).toBe('org');
    expect(PermissionService.widestDataScope(['self', 'all'])).toBe('all');
    expect(PermissionService.widestDataScope([])).toBe('self');
  });
});

describe('PermissionService · 菜单树', () => {
  const flat: AuthMenu[] = [
    { id: '1', parentId: '0', name: '系统', path: null, component: null, icon: null, permissionCode: null, visible: true, sort: 2 },
    { id: '2', parentId: '1', name: '用户', path: '/users', component: 'users', icon: null, permissionCode: PERM.USER_READ, visible: true, sort: 1 },
    { id: '3', parentId: '1', name: '角色', path: '/roles', component: 'roles', icon: null, permissionCode: PERM.ROLE_READ, visible: true, sort: 2 },
    { id: '4', parentId: '0', name: '仪表盘', path: '/dash', component: 'dash', icon: null, permissionCode: null, visible: true, sort: 1 },
    { id: '5', parentId: '404', name: '孤儿', path: '/orphan', component: null, icon: null, permissionCode: null, visible: true, sort: 3 },
  ];

  it('buildTree 建层级、按 sort 排序、孤儿节点按根处理', () => {
    const tree = PermissionService.buildTree(flat);
    expect(tree.map((n) => n.name)).toEqual(['仪表盘', '系统', '孤儿']);
    const system = tree.find((n) => n.name === '系统');
    expect(system?.children.map((c) => c.name)).toEqual(['用户', '角色']);
  });

  it('getMenuTree 按用户权限码过滤：无权限的菜单不返回', async () => {
    const { store, service } = build();
    for (const menu of flat) store.seedMenu(menu);
    const role = store.seedRole({ code: 'r', name: 'r', dataScope: 'self', isSystem: false });
    const readUser = store.seedPermission({ code: PERM.USER_READ, name: 'u', type: 'api', module: 'user' });
    await store.replaceRolePermissions(role.id, [readUser.id]);
    const user = store.seedUser({
      username: 'u',
      phone: null,
      email: null,
      passwordHash: 'x',
      nickname: null,
      avatar: null,
      status: 1,
      lastLoginAt: null,
      lastLoginIp: null,
    });
    await store.replaceUserRoles(user.id, [role.id]);

    const tree = await service.getMenuTree(user.id);
    const names = tree.map((n) => n.name);
    expect(names).toEqual(['仪表盘', '系统', '孤儿']);
    const system = tree.find((n) => n.name === '系统');
    // 角色菜单需要 role:read，用户未持有 → 被过滤
    expect(system?.children.map((c) => c.name)).toEqual(['用户']);
  });

  it('显式传入权限码时不再回源（守卫已加载场景）', async () => {
    const { store, service } = build();
    for (const menu of flat) store.seedMenu(menu);
    const tree = await service.getMenuTree('unknown-user', [PERM.USER_READ, PERM.ROLE_READ]);
    const system = tree.find((n) => n.name === '系统');
    expect(system?.children.map((c) => c.name)).toEqual(['用户', '角色']);
  });
});
