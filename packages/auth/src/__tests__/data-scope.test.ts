/*
 * @file 数据权限四档解析单测（M8 T-M8-04 / PRD-008 FR-04/FR-05 / TC-TNT-004）
 * @description 覆盖：
 *   - resolveDataScope 纯同步判定（all / self / org 无端口收敛 + pendingScopes）；
 *   - resolveDataScopeFilter 四档完整解析（org=本部门、org_below=部门闭包、无端口/无部门按 self 收敛）；
 *   - resolveDataScopeActors / isActorWithinDataScope 归属人集合（列表与详情共用的授权口径）；
 *   - assertWithinDataScope 详情越权校验（self 他人 3002、org 范围外 3002、org_below 下级放行）；
 *   - collectDescendantIds 部门闭包（多根 / 防环 / 悬空父 / 去重）。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-21 donttemo P1 越权修复：补 resolveDataScopeActors / isActorWithinDataScope 覆盖
 *   （审计详情原先只判 selfOnly，org / org_below 档形同虚设）
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import {
  assertWithinDataScope,
  isActorWithinDataScope,
  resolveDataScope,
  resolveDataScopeActors,
  resolveDataScopeFilter,
  type DataScopeActorSet,
  type DataScopeOrgPort,
} from '../data-scope.js';
import { collectDescendantIds } from '../org-tree.js';

/** 内存组织端口桩：dept → members 映射 + 父子边 */
class FakeOrg implements DataScopeOrgPort {
  constructor(
    private readonly ownByUser: Record<string, string[]>,
    private readonly membersByDept: Record<string, string[]>,
    private readonly edges: Array<{ id: string; parentId: string }> = [],
  ) {}

  async listDepartmentIdsByUserId(userId: string): Promise<string[]> {
    return this.ownByUser[userId] ?? [];
  }

  async listVisibleDepartmentIds(userId: string, scope: 'org' | 'org_below'): Promise<string[]> {
    const own = await this.listDepartmentIdsByUserId(userId);
    if (own.length === 0) return [];
    return scope === 'org' ? own : collectDescendantIds(this.edges, own);
  }

  async listUserIdsByDepartmentIds(departmentIds: string[]): Promise<string[]> {
    const users = new Set<string>();
    for (const dept of departmentIds) for (const user of this.membersByDept[dept] ?? []) users.add(user);
    return [...users];
  }
}

/** 部门树：hq → rd → {rd-fe, rd-be}；hq → mkt */
const EDGES = [
  { id: 'hq', parentId: '0' },
  { id: 'rd', parentId: 'hq' },
  { id: 'rd-fe', parentId: 'rd' },
  { id: 'rd-be', parentId: 'rd' },
  { id: 'mkt', parentId: 'hq' },
];

/** bob：研发部负责人（org_below）；carol：研发部（org）；dave：前端组（org）；hank：无部门（org） */
const ORG = new FakeOrg(
  { bob: ['rd'], carol: ['rd'], dave: ['rd-fe'], hank: [] },
  { rd: ['bob', 'carol'], 'rd-fe': ['dave', 'erin'], 'rd-be': ['frank'], mkt: ['grace'] },
  EDGES,
);

describe('resolveDataScope · 纯同步判定（无组织端口）', () => {
  it('all 不受限；self 仅本人', () => {
    expect(resolveDataScope({ id: 'u1', dataScope: 'all' })).toEqual({
      scope: 'all',
      selfOnly: false,
      ownerId: null,
      unrestricted: true,
      departmentIds: null,
      pendingScopes: [],
    });
    expect(resolveDataScope({ id: 'u1', dataScope: 'self' })).toEqual({
      scope: 'self',
      selfOnly: true,
      ownerId: 'u1',
      unrestricted: false,
      departmentIds: null,
      pendingScopes: [],
    });
  });

  it('org / org_below 无端口时按 self 收敛并标记 pendingScopes', () => {
    for (const scope of ['org', 'org_below'] as const) {
      const filter = resolveDataScope({ id: 'u1', dataScope: scope });
      expect(filter.scope).toBe('self');
      expect(filter.selfOnly).toBe(true);
      expect(filter.ownerId).toBe('u1');
      expect(filter.pendingScopes).toEqual([scope]);
    }
  });

  it('范围缺失（旧令牌 / 服务账号）按最小权限 self 收敛', () => {
    const filter = resolveDataScope({ id: 'u1' } as { id: string; dataScope: 'self' });
    expect(filter.selfOnly).toBe(true);
    expect(filter.pendingScopes).toEqual([]);
  });
});

describe('resolveDataScopeFilter · 四档完整解析（TC-TNT-004）', () => {
  it('all：不受限，不带部门条件', async () => {
    const filter = await resolveDataScopeFilter({ id: 'admin', dataScope: 'all' }, ORG);
    expect(filter.unrestricted).toBe(true);
    expect(filter.departmentIds).toBeNull();
  });

  it('org：可见部门 = 本人所在部门（不含下级）', async () => {
    const carol = await resolveDataScopeFilter({ id: 'carol', dataScope: 'org' }, ORG);
    expect(carol).toEqual({
      scope: 'org',
      selfOnly: false,
      ownerId: null,
      unrestricted: false,
      departmentIds: ['rd'],
      pendingScopes: [],
    });
    // 前端组的 dave 不在 carol 的 org 范围内
    const dave = await resolveDataScopeFilter({ id: 'dave', dataScope: 'org' }, ORG);
    expect(dave.departmentIds).toEqual(['rd-fe']);
  });

  it('org_below：可见部门 = 所在部门及全部下级（闭包）', async () => {
    const bob = await resolveDataScopeFilter({ id: 'bob', dataScope: 'org_below' }, ORG);
    expect(bob.scope).toBe('org_below');
    expect(bob.departmentIds).toEqual(expect.arrayContaining(['rd', 'rd-fe', 'rd-be']));
    expect(bob.departmentIds).toHaveLength(3);
  });

  it('org 档用户无部门归属：收敛 self + pendingScopes（绝不放宽）', async () => {
    const hank = await resolveDataScopeFilter({ id: 'hank', dataScope: 'org' }, ORG);
    expect(hank.selfOnly).toBe(true);
    expect(hank.ownerId).toBe('hank');
    expect(hank.pendingScopes).toEqual(['org']);
  });

  it('未注入组织端口：org/org_below 与同步版一致地收敛 self', async () => {
    const filter = await resolveDataScopeFilter({ id: 'bob', dataScope: 'org_below' });
    expect(filter.selfOnly).toBe(true);
    expect(filter.pendingScopes).toEqual(['org_below']);
  });
});

describe('assertWithinDataScope · 详情与写操作越权校验', () => {
  it('all：任意目标放行', async () => {
    await expect(assertWithinDataScope({ id: 'admin', dataScope: 'all' }, 'anyone', ORG)).resolves.toBeUndefined();
  });

  it('self：本人放行，他人 3002', async () => {
    await expect(assertWithinDataScope({ id: 'alice', dataScope: 'self' }, 'alice', ORG)).resolves.toBeUndefined();
    await expect(assertWithinDataScope({ id: 'alice', dataScope: 'self' }, 'bob', ORG)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('org：部门内放行，范围外（含下级部门）3002', async () => {
    await expect(assertWithinDataScope({ id: 'carol', dataScope: 'org' }, 'bob', ORG)).resolves.toBeUndefined();
    // dave 在前端组——carol 的 org 不含下级
    await expect(assertWithinDataScope({ id: 'carol', dataScope: 'org' }, 'dave', ORG)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('org_below：下级部门成员放行，旁支 3002', async () => {
    await expect(assertWithinDataScope({ id: 'bob', dataScope: 'org_below' }, 'frank', ORG)).resolves.toBeUndefined();
    await expect(assertWithinDataScope({ id: 'bob', dataScope: 'org_below' }, 'grace', ORG)).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });

  it('无组织端口时按 self 收敛：他人 3002（fail-closed）', async () => {
    await expect(assertWithinDataScope({ id: 'bob', dataScope: 'org_below' }, 'frank')).rejects.toMatchObject({
      code: ErrorCode.FORBIDDEN,
    });
  });
});

describe('resolveDataScopeActors · 允许归属人集合（列表与详情共用口径）', () => {
  it('all：不限（allowedUserIds = null），任何归属人（含系统任务的 null）都可读', async () => {
    const actors = await resolveDataScopeActors({ id: 'admin', dataScope: 'all' }, ORG);
    expect(actors).toEqual({ scope: 'all', unrestricted: true, allowedUserIds: null });
    expect(isActorWithinDataScope(actors, 'anyone')).toBe(true);
    expect(isActorWithinDataScope(actors, null)).toBe(true);
  });

  it('self：集合就是本人，他人与系统任务一律不可读', async () => {
    const actors = await resolveDataScopeActors({ id: 'alice', dataScope: 'self' }, ORG);
    expect(actors).toEqual({ scope: 'self', unrestricted: false, allowedUserIds: ['alice'] });
    expect(isActorWithinDataScope(actors, 'alice')).toBe(true);
    expect(isActorWithinDataScope(actors, 'bob')).toBe(false);
    // 系统任务记录（userId 为 null）不属于任何按人收敛的集合
    expect(isActorWithinDataScope(actors, null)).toBe(false);
    expect(isActorWithinDataScope(actors, undefined)).toBe(false);
  });

  it('org：集合 = 本部门成员（不含下级部门，不含旁支）', async () => {
    const carol = await resolveDataScopeActors({ id: 'carol', dataScope: 'org' }, ORG);
    expect(carol.scope).toBe('org');
    expect(carol.unrestricted).toBe(false);
    expect([...(carol.allowedUserIds ?? [])].sort()).toEqual(['bob', 'carol']);
    expect(isActorWithinDataScope(carol, 'bob')).toBe(true);
    // dave 在前端组（下级部门）——org 档不含下级
    expect(isActorWithinDataScope(carol, 'dave')).toBe(false);
    expect(isActorWithinDataScope(carol, 'grace')).toBe(false);
  });

  it('org_below：集合 = 部门闭包内的全部成员', async () => {
    const bob = await resolveDataScopeActors({ id: 'bob', dataScope: 'org_below' }, ORG);
    expect(bob.scope).toBe('org_below');
    expect([...(bob.allowedUserIds ?? [])].sort()).toEqual(['bob', 'carol', 'dave', 'erin', 'frank']);
    expect(isActorWithinDataScope(bob, 'frank')).toBe(true);
    // grace 在 mkt（旁支，不在 rd 子树内）
    expect(isActorWithinDataScope(bob, 'grace')).toBe(false);
  });

  it('org 档用户无部门归属：收敛为 self（集合只有本人，绝不放宽为全量）', async () => {
    const hank = await resolveDataScopeActors({ id: 'hank', dataScope: 'org' }, ORG);
    expect(hank).toEqual({ scope: 'self', unrestricted: false, allowedUserIds: ['hank'] });
    expect(isActorWithinDataScope(hank, 'bob')).toBe(false);
  });

  it('未注入组织端口：org_below 收敛为 self，范围外目标不可读', async () => {
    const actors = await resolveDataScopeActors({ id: 'bob', dataScope: 'org_below' });
    expect(actors).toEqual({ scope: 'self', unrestricted: false, allowedUserIds: ['bob'] });
    expect(isActorWithinDataScope(actors, 'frank')).toBe(false);
  });

  it('空集合 fail-closed：{ allowedUserIds: [] } 对任何人都不可读（不退化全量）', () => {
    const empty: DataScopeActorSet = { scope: 'org', unrestricted: false, allowedUserIds: [] };
    expect(isActorWithinDataScope(empty, 'bob')).toBe(false);
    expect(isActorWithinDataScope(empty, null)).toBe(false);
  });
});

describe('collectDescendantIds · 部门闭包', () => {
  it('多根 + 多级后代去重展开', () => {
    expect(collectDescendantIds(EDGES, ['rd']).sort()).toEqual(['rd', 'rd-be', 'rd-fe'].sort());
    expect(collectDescendantIds(EDGES, ['rd', 'mkt']).sort()).toEqual(['rd', 'rd-be', 'rd-fe', 'mkt'].sort());
  });

  it('防环：parent 指错形成环时不死循环', () => {
    const cyclic = [
      { id: 'a', parentId: 'b' },
      { id: 'b', parentId: 'a' },
    ];
    expect(collectDescendantIds(cyclic, ['a']).sort()).toEqual(['a', 'b']);
  });

  it('悬空父节点：仅返回可达集合，不抛错', () => {
    const dangling = [{ id: 'x', parentId: 'ghost' }];
    expect(collectDescendantIds(dangling, ['x'])).toEqual(['x']);
    // ghost 自身不在节点表中，但其子 x 仍可达（闭包按边遍历，不要求根必须是节点）
    expect(collectDescendantIds(dangling, ['ghost']).sort()).toEqual(['ghost', 'x']);
  });

  it('空根集合返回空数组', () => {
    expect(collectDescendantIds(EDGES, [])).toEqual([]);
  });
});
