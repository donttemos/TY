/*
 * @file 内存鉴权存储单测（驱动审查修复配套）
 * @description 覆盖 MemoryAuthStore 与 Prisma 实现的一致性修复：nextId 与 seedXxx 显式 id 不撞号、
 *   用户建模真实 createdAt、updateUser 业务列白名单、replaceUserRoles / replaceRolePermissions
 *   悬空引用拒绝（对齐 DB 外键）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/auth
 */

import { describe, expect, it } from 'vitest';
import { MemoryAuthStore } from '../memory-auth-store.js';

/** 构造用户种子入参 */
function makeUserInput(overrides: Record<string, unknown> = {}): Parameters<MemoryAuthStore['seedUser']>[0] {
  return { username: 'alice', passwordHash: 'hash', ...overrides };
}

describe('MemoryAuthStore · nextId 防撞号', () => {
  it('seedXxx 显式 id 后，createUser 发号绝不与既有记录撞号（此前会静默覆盖种子用户）', async () => {
    const store = new MemoryAuthStore();
    const seeded = store.seedUser(makeUserInput({ id: 'mem-1' }));
    const created = await store.createUser({ username: 'bob', passwordHash: 'hash' });

    expect(created.id).not.toBe(seeded.id);
    // 种子用户未被覆盖：两条记录都可按 id 找到
    expect((await store.findUserById(seeded.id))?.username).toBe('alice');
    expect((await store.findUserById(created.id))?.username).toBe('bob');
    expect(await store.findUserByAccount('alice')).not.toBeNull();
  });

  it('`mem-N` 形态的种子 id 推进计数器，后续发号从 N+1 起', async () => {
    const store = new MemoryAuthStore();
    store.seedRole({ id: 'mem-5', code: 'r', name: 'r', dataScope: 'self', isSystem: false });
    const user = await store.createUser({ username: 'bob', passwordHash: 'hash' });
    expect(user.id).toBe('mem-6');
  });
});

describe('MemoryAuthStore · createdAt 建模', () => {
  it('seedUser / createUser 均携带真实 createdAt，列表投影非 null（对齐 Prisma）', async () => {
    const store = new MemoryAuthStore();
    const at = new Date('2026-01-01T00:00:00Z');
    store.seedUser(makeUserInput({ id: 'u-1', createdAt: at }));
    await store.createUser({ username: 'bob', passwordHash: 'hash' });

    const page = await store.pageUsers({ page: 1, pageSize: 10 });
    expect(page.items).toHaveLength(2);
    for (const item of page.items) expect(item.createdAt).toBeInstanceOf(Date);
    // 默认排序 createdAt desc：种子（显式 2026-01-01）在后，createUser（当前时刻）在前
    expect(page.items[0].username).toBe('bob');
    expect(page.items[1].createdAt!.getTime()).toBe(at.getTime());
  });
});

describe('MemoryAuthStore · updateUser patch 语义', () => {
  it('仅接受业务列白名单；未知列报错而非静默写入（对齐 Prisma 未知列抛错）', async () => {
    const store = new MemoryAuthStore();
    const user = store.seedUser(makeUserInput({ id: 'u-1' }));

    await expect(store.updateUser(user.id, { evilField: 'x' } as never)).rejects.toThrow(/不支持的字段/);

    // 白名单内的敏感列（改密流程）与租户列（数据范围）合法
    const updated = await store.updateUser(user.id, { passwordHash: 'new-hash', tenantId: '18' });
    expect(updated.passwordHash).toBe('new-hash');
    expect(updated.tenantId).toBe('18');
    expect(updated.id).toBe(user.id);
  });

  it('用户不存在时报错', async () => {
    const store = new MemoryAuthStore();
    await expect(store.updateUser('no-such', { status: 0 })).rejects.toThrow(/用户不存在/);
  });
});

describe('MemoryAuthStore · 关联写入外键校验', () => {
  it('replaceUserRoles 拒绝悬空角色与未知用户；合法写入不受影响', async () => {
    const store = new MemoryAuthStore();
    const role = store.seedRole({ code: 'r', name: 'r', dataScope: 'self', isSystem: false });
    const user = store.seedUser(makeUserInput({ id: 'u-1' }));

    await expect(store.replaceUserRoles('no-such-user', [role.id])).rejects.toThrow(/用户不存在/);
    await expect(store.replaceUserRoles(user.id, ['no-such-role'])).rejects.toThrow(/角色不存在/);
    await expect(store.replaceUserRoles(user.id, [role.id])).resolves.toBeUndefined();
    expect((await store.listRolesByUserId(user.id)).map((r) => r.code)).toEqual(['r']);
  });

  it('replaceRolePermissions 拒绝悬空权限点；合法写入不受影响', async () => {
    const store = new MemoryAuthStore();
    const role = store.seedRole({ code: 'r', name: 'r', dataScope: 'self', isSystem: false });
    const perm = store.seedPermission({ code: 'a:read', name: 'a', type: 'api', module: 'a' });

    await expect(store.replaceRolePermissions('no-such-role', [perm.id])).rejects.toThrow(/角色不存在/);
    await expect(store.replaceRolePermissions(role.id, ['no-such-perm'])).rejects.toThrow(/权限点不存在/);
    await expect(store.replaceRolePermissions(role.id, [perm.id])).resolves.toBeUndefined();
    expect(await store.listPermissionIdsByRoleId(role.id)).toEqual([perm.id]);
  });
});
