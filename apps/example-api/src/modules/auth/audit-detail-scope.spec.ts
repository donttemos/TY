/*
 * @file 审计详情 dataScope 授权边界（P1 越权回归）
 * @description GET /api/v1/audit-logs/:id 的服务端权限边界必须与列表一致，四档逐一锁定：
 *   - self：仅本人记录；系统任务（userId 为 null）不可读；
 *   - org：记录操作人必须是**本部门**成员（不含下级部门、不含旁支、不含其它租户）；
 *   - org_below：部门及全部下级成员可读，旁支与跨租户一律不可读；
 *   - all：解除**归属人**限制（本租户内任何操作人，含系统任务），但不解除**租户**边界——
 *     跨租户读取只允许经 @IgnoreTenant 维护入口（见 audit-tenant-scope.spec.ts）。
 *   范围外与「记录不存在」返回**同一个 404**（同 code 同 message），不泄露记录存在性；
 *   并验证共享库多租户（tenant A / tenant B 共存一张表）下猜 ID 也读不到别家记录。
 *
 *   历史缺陷（本次修复）：detail() 此前只判 `scope.selfOnly`，org / org_below 档的部门管理者
 *   可凭列表里看不见的记录 ID 直读详情（服务端没有把 dataScope 落到归属人集合上）。
 *   第二处缺陷（P1 租户分维）：detail() 只判归属人，未校验记录 tenantId——本租户 dataScope=all
 *   用户可凭 ID 直读他租户记录；现同时校验记录租户归属。
 * @author donttemo
 * @created 2026-10-21
 * @modified 2026-10-21 donttemo P1 租户隔离分维：all 档改为「本租户内不限归属人」，跨租户详情
 *   移入独立维护入口测试；列表桩补 tenantId 收敛（与存储层同语义）
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import { BizError, ERROR_CODE_META, ErrorCode } from '@fw/core';
import { collectDescendantIds } from '@fw/auth';
import type { AuditLogRecord, AuditQuery, DataScopeOrgPort, RequestUser } from '@fw/auth';
import type { Request } from 'express';
import { AuditController } from './audit.controller.js';
import type { AdminStore } from '../admin/admin-store.js';
import type { JobCenterService } from '../jobs/job-center.service.js';
import type { JobRunnerRegistry } from '../jobs/job-runner.registry.js';

/** 共享库里的两个租户（同一张 audit_log 表，靠 tenant_id 区分） */
const TENANT_A = '17';
const TENANT_B = '18';

/** 组织端口桩：与 PrismaAuthStore 同语义（org=本部门，org_below=部门闭包） */
class FakeOrg implements DataScopeOrgPort {
  constructor(
    private readonly ownByUser: Record<string, string[]>,
    private readonly membersByDept: Record<string, string[]>,
    private readonly edges: Array<{ id: string; parentId: string }>,
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

/**
 * 部门树：d-rd → d-rd-fe；d-mkt / d-b-rd 为独立根（d-b-rd 属 B 租户）
 *
 * 成员：d-rd=[alice,bob]、d-rd-fe=[erin]、d-mkt=[carol]、d-b-rd=[zed]
 */
const ORG = new FakeOrg(
  {
    'u-alice': ['d-rd'],
    'u-bob': ['d-rd'],
    'u-erin': ['d-rd-fe'],
    'u-carol': ['d-mkt'],
    'u-zed': ['d-b-rd'],
    'u-nil': [],
  },
  { 'd-rd': ['u-alice', 'u-bob'], 'd-rd-fe': ['u-erin'], 'd-mkt': ['u-carol'], 'd-b-rd': ['u-zed'] },
  [
    { id: 'd-rd', parentId: '0' },
    { id: 'd-rd-fe', parentId: 'd-rd' },
    { id: 'd-mkt', parentId: '0' },
    { id: 'd-b-rd', parentId: '0' },
  ],
);

/** 构造审计行（只填契约必需列） */
function record(id: string, userId: string | null, tenantId = TENANT_A): AuditLogRecord {
  return {
    id,
    tenantId,
    userId,
    module: 'auth',
    action: 'login',
    category: 'auth',
    event: 'auth.login',
    result: 'success',
    familyId: null,
    jti: null,
    requestId: null,
    targetType: 'user',
    targetId: userId,
    beforeValue: null,
    afterValue: null,
    ip: '127.0.0.1',
    userAgent: 'vitest',
    traceId: null,
    createdAt: new Date('2026-10-21T00:00:00Z'),
    summary: null,
    targetLabel: null,
    actorLabel: null,
    reason: null,
    auditSource: 'domain',
  };
}

/** 测试数据集：含本人 / 同部门 / 下级部门 / 旁支 / 跨租户 / 系统任务六类归属人 */
const RECORDS: AuditLogRecord[] = [
  record('log-alice', 'u-alice'),
  record('log-bob', 'u-bob'),
  record('log-erin', 'u-erin'),
  record('log-carol', 'u-carol'),
  record('log-nil', 'u-nil'),
  record('log-zed', 'u-zed', TENANT_B),
  record('log-system', null, '0'),
  // 本租户内的系统任务记录：all 档可见（归属人维度不限），但按人收敛的档位一律不可见
  record('log-a-system', null, TENANT_A),
];

/** 控制器测试装置：捕获列表查询条件，并提供「不做授权」的原始读取用于断言记录确实存在 */
interface Harness {
  controller: AuditController;
  /** 最近一次列表查询入参（含数据范围注入的 userId / userIds） */
  listQuery(): AuditQuery | undefined;
  /** 绕过授权直接读原始行（证明拒绝来自授权判定而非记录不存在） */
  raw(id: string): AuditLogRecord | null;
}

function createHarness(): Harness {
  const byId = new Map(RECORDS.map((row) => [row.id, row]));
  let query: AuditQuery | undefined;
  const auth = {
    auditLogs: async (input: AuditQuery) => {
      query = input;
      // 与存储层同语义：归属人集合收敛（空集合 = 空结果）+ 租户条件收敛（P1 租户分维）
      let rows = [...byId.values()];
      if (input.tenantId !== undefined) rows = rows.filter((row) => row.tenantId === input.tenantId);
      if (input.userIds !== undefined) {
        const allowed = new Set(input.userId ? input.userIds.filter((id) => id === input.userId) : input.userIds);
        rows = rows.filter((row) => (row.userId ? allowed.has(row.userId) : false));
      } else if (input.userId) {
        rows = rows.filter((row) => row.userId === input.userId);
      }
      return { items: rows, total: rows.length, page: 1, pageSize: input.pageSize, hasMore: false };
    },
  };
  const controller = new AuditController(
    auth as never,
    ORG,
    { findAuditLogById: async (id: string) => byId.get(id) ?? null } as unknown as AdminStore,
    {} as unknown as JobCenterService,
    { register: () => undefined } as unknown as JobRunnerRegistry,
    {} as never,
  );
  return { controller, listQuery: () => query, raw: (id) => byId.get(id) ?? null };
}

/** 构造请求用户 */
function user(id: string, dataScope: RequestUser['dataScope'], tenantId = TENANT_A): RequestUser {
  return { id, username: id, roles: [], permissions: ['audit:read'], dataScope, via: 'jwt', tenantId };
}

/** 捕获抛出的 BizError（未抛出即用例失败） */
async function captureError(promise: Promise<unknown>): Promise<BizError> {
  try {
    await promise;
  } catch (error) {
    return error as BizError;
  }
  throw new Error('应抛出 BizError（授权范围外必须 fail-closed）');
}

/** 断言详情被拒为 404/1002（不是 403：不泄露记录存在性） */
async function expectDenied(controller: AuditController, requester: RequestUser, id: string): Promise<void> {
  const error = await captureError(controller.detail(requester, id));
  expect(error).toBeInstanceOf(BizError);
  expect(error.code).toBe(ErrorCode.NOT_FOUND);
  expect(ERROR_CODE_META[ErrorCode.NOT_FOUND].http).toBe(404);
}

describe('P1 · 审计详情 dataScope 服务端收敛', () => {
  it('self：仅本人可读，同部门同事 / 系统任务一律 404', async () => {
    const h = createHarness();
    const alice = user('u-alice', 'self');

    await expect(h.controller.detail(alice, 'log-alice')).resolves.toMatchObject({ id: 'log-alice' });

    for (const id of ['log-bob', 'log-erin', 'log-carol', 'log-nil', 'log-zed', 'log-system', 'log-a-system']) {
      await expectDenied(h.controller, alice, id);
    }
    // 拒绝来自授权判定，而不是记录不存在
    expect(h.raw('log-bob')).not.toBeNull();
  });

  it('org：同部门成员可读，下级部门 / 旁支 / 跨租户 404', async () => {
    const h = createHarness();
    const carol = user('u-carol', 'org');
    const alice = user('u-alice', 'org');

    await expect(h.controller.detail(carol, 'log-carol')).resolves.toMatchObject({ id: 'log-carol' });
    // 同部门（d-rd 内 alice / bob 互见）
    await expect(h.controller.detail(alice, 'log-alice')).resolves.toMatchObject({ id: 'log-alice' });
    await expect(h.controller.detail(alice, 'log-bob')).resolves.toMatchObject({ id: 'log-bob' });

    // d-mkt 的 carol 看不到 d-rd / d-rd-fe（下级）/ B 租户 / 系统任务
    for (const id of ['log-alice', 'log-bob', 'log-erin', 'log-nil', 'log-zed', 'log-system', 'log-a-system']) {
      await expectDenied(h.controller, carol, id);
    }
    // d-rd 的 alice 看不到下级部门 d-rd-fe 的 erin（org 档不含下级）
    await expectDenied(h.controller, alice, 'log-erin');
  });

  it('org_below：部门及下级成员可读，旁支 / 跨租户 / 系统任务 404', async () => {
    const h = createHarness();
    const bob = user('u-bob', 'org_below');

    for (const id of ['log-alice', 'log-bob', 'log-erin']) {
      await expect(h.controller.detail(bob, id)).resolves.toMatchObject({ id });
    }
    for (const id of ['log-carol', 'log-nil', 'log-zed', 'log-system', 'log-a-system']) {
      await expectDenied(h.controller, bob, id);
    }
  });

  it('all：解除归属人限制（本租户内他人 / 系统任务可读），但不解除租户边界', async () => {
    const h = createHarness();
    const admin = user('u-admin', 'all');
    // 本租户（A）内的全部记录可读，含系统任务（userId=null）——归属人维度确实不限
    for (const row of RECORDS.filter((item) => item.tenantId === TENANT_A)) {
      await expect(h.controller.detail(admin, row.id)).resolves.toMatchObject({ id: row.id });
    }
    // 但 all 不等于平台级跨租户权限：B 租户记录 / 存量 tenant_id=0 记录一律 404
    for (const id of ['log-zed', 'log-system']) {
      expect(h.raw(id)).not.toBeNull(); // 记录确实存在，拒绝来自租户判定
      await expectDenied(h.controller, admin, id);
    }
  });

  it('all 档 + 未走维护入口：即使持有 system:tenant:ignore 也不能跨租户直读（权限不改变普通端点边界）', async () => {
    const h = createHarness();
    const platformOperator = user('u-admin', 'all');
    platformOperator.permissions = ['audit:read', 'system:tenant:ignore'];
    // 普通详情端点没有 @IgnoreTenant，守卫不会写入 ignoreTenant 上下文 → 仍按当前租户收敛
    await expectDenied(h.controller, platformOperator, 'log-zed');
  });

  it('org 档但无部门归属：收敛为 self（他人 404，绝不放宽）', async () => {
    const h = createHarness();
    const nil = user('u-nil', 'org');

    await expect(h.controller.detail(nil, 'log-nil')).resolves.toMatchObject({ id: 'log-nil' });
    for (const id of ['log-alice', 'log-zed', 'log-system', 'log-a-system']) {
      await expectDenied(h.controller, nil, id);
    }
  });

  it('共享库多租户：A 租户部门管理者猜 ID 读不到 B 租户记录（含 org_below 上级）', async () => {
    const h = createHarness();
    // A 租户里的两条管理线：rd（org_below）与 mkt（org）
    const rdManager = user('u-bob', 'org_below');
    const mktManager = user('u-carol', 'org');
    const allManager = user('u-admin', 'all');

    expect(h.raw('log-zed')).not.toBeNull(); // B 租户记录确实在同一张表里
    await expectDenied(h.controller, rdManager, 'log-zed');
    await expectDenied(h.controller, mktManager, 'log-zed');
    // dataScope=all 只解除归属人限制：本租户 all 用户同样不能读 B 租户记录
    await expectDenied(h.controller, allManager, 'log-zed');
    // 反向：B 租户管理者也读不到 A 租户记录
    const zed = user('u-zed', 'org_below', TENANT_B);
    for (const id of ['log-alice', 'log-bob', 'log-carol']) {
      await expectDenied(h.controller, zed, id);
    }
  });

  it('越权与不存在返回完全相同的 404（同 code 同 message，不泄露存在性）', async () => {
    const h = createHarness();
    const alice = user('u-alice', 'self');
    const missing = await captureError(h.controller.detail(alice, 'log-does-not-exist'));
    const denied = await captureError(h.controller.detail(alice, 'log-bob'));

    expect(missing.code).toBe(ErrorCode.NOT_FOUND);
    expect(denied.code).toBe(missing.code);
    expect(denied.message).toBe(missing.message);
  });

  it('列表与详情同源：四种范围下列表可见集合与详情可读集合逐一相等', async () => {
    const table: Array<{ scope: RequestUser['dataScope']; userId: string; visible: string[] }> = [
      { scope: 'self', userId: 'u-alice', visible: ['log-alice'] },
      { scope: 'self', userId: 'u-bob', visible: ['log-bob'] },
      { scope: 'org', userId: 'u-carol', visible: ['log-carol'] },
      { scope: 'org', userId: 'u-alice', visible: ['log-alice', 'log-bob'] },
      { scope: 'org_below', userId: 'u-bob', visible: ['log-alice', 'log-bob', 'log-erin'] },
      // all：仅解除归属人限制，本租户（A）内的系统任务记录可见；B 租户与 tenant_id=0 存量行仍不可见
      {
        scope: 'all',
        userId: 'u-admin',
        visible: RECORDS.filter((row) => row.tenantId === TENANT_A).map((row) => row.id),
      },
    ];

    for (const entry of table) {
      const h = createHarness();
      const requester = user(entry.userId, entry.scope);
      const page = await h.controller.list(requester, { query: {} } as unknown as Request);
      const listed = page.items.map((row) => row.id);
      expect({ scope: entry.scope, userId: entry.userId, ids: [...listed].sort() }).toEqual({
        scope: entry.scope,
        userId: entry.userId,
        ids: [...entry.visible].sort(),
      });

      // 详情判定必须与列表逐个一致：列表可见 ⇔ 详情可读
      for (const row of RECORDS) {
        if (entry.visible.includes(row.id)) {
          await expect(h.controller.detail(requester, row.id)).resolves.toMatchObject({ id: row.id });
        } else {
          await expectDenied(h.controller, requester, row.id);
        }
      }

      // 列表注入的归属人集合就是详情判定所用的集合（self 档走 userId，其余走 userIds）；
      // 租户维度另行强制为服务端当前租户（与 dataScope 正交，四档都必须带）
      const query = h.listQuery();
      expect(query?.tenantId).toBe(TENANT_A);
      if (entry.scope === 'self') {
        expect(query?.userId).toBe(entry.userId);
        expect(query?.userIds).toBeUndefined();
      } else if (entry.scope === 'all') {
        expect(query?.userIds).toBeUndefined();
      } else {
        expect([...(query?.userIds ?? [])].sort()).toEqual(
          [...(entry.visible.map((id) => RECORDS.find((row) => row.id === id)!.userId!))].sort(),
        );
      }
    }
  });
});
