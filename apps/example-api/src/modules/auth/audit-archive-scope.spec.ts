/*
 * @file 归档审计与在线审计的授权范围同源（P1 越权修复配套回归）
 * @description `/audit-archives` 没有详情端点，但列表 / 导出各自手写过一份 scopeUserIds，
 *   与在线 `/audit-logs` 是两份独立实现——两处一旦漂移，就会出现「在线列表看不见、归档列表
 *   看得见」的错位（同一批数据、两个范围）。本用例锁定四个端点（在线列表 / 在线导出 /
 *   归档列表 / 归档导出）对同一用户注入的 `userId` / `userIds` 必须完全相同
 *   （self / org / org_below / all 四档，含客户端传 `user_id` 的放大尝试）。
 *
 *   归档侧此前无任何控制器级用例，这条断言是其范围语义的兜底。
 * @author donttemo
 * @created 2026-10-21
 * @modified 2026-10-21 donttemo 补「在线导出 ⇔ 在线列表」同源断言（原仅覆盖归档侧导出）
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import { collectDescendantIds } from '@fw/auth';
import type { AuditQuery, DataScopeOrgPort, RequestUser } from '@fw/auth';
import type { Request } from 'express';
import { AuditController } from './audit.controller.js';
import { AuditArchiveController } from './audit-archive.controller.js';
import type { AdminStore } from '../admin/admin-store.js';
import type { JobCenterService } from '../jobs/job-center.service.js';
import type { JobRunnerRegistry } from '../jobs/job-runner.registry.js';

/** 组织端口桩（与 PrismaAuthStore 同语义：org=本部门，org_below=部门闭包） */
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

/** 部门树：d-rd → d-rd-fe；d-mkt 独立根；d-b-rd 属另一租户 */
const ORG = new FakeOrg(
  { 'u-alice': ['d-rd'], 'u-bob': ['d-rd'], 'u-erin': ['d-rd-fe'], 'u-carol': ['d-mkt'], 'u-zed': ['d-b-rd'], 'u-nil': [] },
  { 'd-rd': ['u-alice', 'u-bob'], 'd-rd-fe': ['u-erin'], 'd-mkt': ['u-carol'], 'd-b-rd': ['u-zed'] },
  [
    { id: 'd-rd', parentId: '0' },
    { id: 'd-rd-fe', parentId: 'd-rd' },
    { id: 'd-mkt', parentId: '0' },
    { id: 'd-b-rd', parentId: '0' },
  ],
);

/** 请求用户 */
function user(id: string, dataScope: RequestUser['dataScope']): RequestUser {
  return { id, username: id, roles: [], permissions: ['audit:read', 'audit:export'], dataScope, via: 'jwt', tenantId: '17' };
}

/** 在线列表 / 在线导出 / 归档列表 / 归档导出四处捕获到的查询条件 */
interface Captures {
  onlineList?: AuditQuery;
  archiveList?: AuditQuery;
  onlineExportParams?: Record<string, unknown>;
  archiveExportParams?: Record<string, unknown>;
}

/** 构造四套端点（共用同一个组织端口桩），返回捕获到的查询条件 */
function createHarness(): {
  online: AuditController;
  archive: AuditArchiveController;
  captures: Captures;
} {
  const captures: Captures = {};
  const emptyPage = { items: [], total: 0, page: 1, pageSize: 20, hasMore: false };

  const authStub = {
    auditLogs: async (query: AuditQuery) => {
      captures.onlineList = query;
      return emptyPage;
    },
  };
  const archiveStub = {
    page: async (query: AuditQuery) => {
      captures.archiveList = query;
      return emptyPage;
    },
  };
  // 两个导出端点共用一个任务中心桩，按任务类型分开捕获（audit.export / audit.archive.export）
  const jobsStub = {
    create: async (input: { type: string; params: Record<string, unknown> }) => {
      if (input.type === 'audit.archive.export') captures.archiveExportParams = input.params;
      else captures.onlineExportParams = input.params;
      return { id: 'job-1' };
    },
  };
  const registryStub = { register: () => undefined };
  const auditStub = { recordEvent: () => undefined };

  const online = new AuditController(
    authStub as never,
    ORG,
    { findAuditLogById: async () => null } as unknown as AdminStore,
    jobsStub as unknown as JobCenterService,
    registryStub as unknown as JobRunnerRegistry,
    auditStub as never,
  );
  const archive = new AuditArchiveController(
    archiveStub as unknown as never,
    ORG,
    jobsStub as unknown as JobCenterService,
    registryStub as unknown as JobRunnerRegistry,
    auditStub as never,
  );
  return { online, archive, captures };
}

/** 请求桩（本用例不校验过滤参数；headers 供 clientIp 取来源 IP） */
const REQUEST = { query: {}, headers: {}, ip: '127.0.0.1' } as unknown as Request;

/** 调列表端点：显式传位置参数（Nest 平时由 @Query 注入，单测里必须自己给） */
function listOnline(controller: AuditController, requester: RequestUser, clientUserId?: string): Promise<unknown> {
  return controller.list(requester, REQUEST, '1', '20', clientUserId);
}

/** 调归档列表端点（同上） */
function listArchive(controller: AuditArchiveController, requester: RequestUser, clientUserId?: string): Promise<unknown> {
  return controller.list(requester, REQUEST, '1', '20', clientUserId);
}

/** 调归档导出端点（第 4 位起是 query 参数，取 clientUserId） */
function exportArchive(controller: AuditArchiveController, requester: RequestUser, clientUserId?: string): Promise<unknown> {
  return controller.export(requester, requester.id, REQUEST, clientUserId);
}

describe('P1 · 归档审计与在线审计的授权范围同源', () => {
  it('四档下列表注入的归属人约束逐个相同（在线 ⇔ 归档）', async () => {
    const table: Array<{ scope: RequestUser['dataScope']; userId: string }> = [
      { scope: 'self', userId: 'u-alice' },
      { scope: 'org', userId: 'u-carol' },
      { scope: 'org', userId: 'u-alice' },
      { scope: 'org_below', userId: 'u-bob' },
      // 无部门归属的 org 档：两端都必须收敛为 self
      { scope: 'org', userId: 'u-nil' },
      { scope: 'all', userId: 'u-admin' },
    ];

    for (const entry of table) {
      const { online, archive, captures } = createHarness();
      const requester = user(entry.userId, entry.scope);
      await listOnline(online, requester);
      await listArchive(archive, requester);

      // 只比对授权相关字段（列表其余过滤面各自演进，不属本用例的契约）
      const onlineActors = { userId: captures.onlineList?.userId, userIds: captures.onlineList?.userIds };
      const archiveActors = { userId: captures.archiveList?.userId, userIds: captures.archiveList?.userIds };
      expect(archiveActors, `${entry.scope} / ${entry.userId}`).toEqual(onlineActors);
    }
  });

  it('归档导出 params 的归属人约束与归档列表完全一致（导出不得比列表更多）', async () => {
    const table: Array<{ scope: RequestUser['dataScope']; userId: string; clientUserId?: string }> = [
      { scope: 'self', userId: 'u-alice', clientUserId: 'u-bob' },
      { scope: 'org_below', userId: 'u-bob', clientUserId: 'u-zed' },
      { scope: 'all', userId: 'u-admin' },
    ];

    for (const entry of table) {
      const { archive, captures } = createHarness();
      const requester = user(entry.userId, entry.scope);
      await listArchive(archive, requester, entry.clientUserId);
      const listed = captures.archiveList;
      await exportArchive(archive, requester, entry.clientUserId);

      expect(captures.archiveExportParams?.userId, `${entry.scope} / ${entry.userId}`).toBe(listed?.userId);
      expect(captures.archiveExportParams?.userIds).toEqual(listed?.userIds);
    }
  });

  it('在线导出 params 的归属人约束与在线列表完全一致（导出不得比列表更多）', async () => {
    const table: Array<{ scope: RequestUser['dataScope']; userId: string; clientUserId?: string }> = [
      { scope: 'self', userId: 'u-alice', clientUserId: 'u-bob' },
      { scope: 'org', userId: 'u-alice', clientUserId: 'u-zed' },
      { scope: 'org_below', userId: 'u-bob' },
      { scope: 'all', userId: 'u-admin' },
    ];

    for (const entry of table) {
      const { online, captures } = createHarness();
      const requester = user(entry.userId, entry.scope);
      await listOnline(online, requester, entry.clientUserId);
      const listed = captures.onlineList;
      await online.export(requester, requester.id, REQUEST, entry.clientUserId);

      expect(captures.onlineExportParams?.userId, `${entry.scope} / ${entry.userId}`).toBe(listed?.userId);
      expect(captures.onlineExportParams?.userIds).toEqual(listed?.userIds);
    }
  });

  it('self 档忽略客户端传入的 user_id（归档与在线一致，不能被 query 放大）', async () => {
    const { online, archive, captures } = createHarness();
    const alice = user('u-alice', 'self');

    await listOnline(online, alice, 'u-bob');
    await listArchive(archive, alice, 'u-bob');

    expect(captures.onlineList?.userId).toBe('u-alice');
    expect(captures.archiveList?.userId).toBe('u-alice');
    expect(captures.archiveList?.userIds).toBeUndefined();
  });

  it('org / org_below 档把客户端 user_id 交给存储层与部门集合取交集（不放宽为并集）', async () => {
    const { archive, captures } = createHarness();
    await listArchive(archive, user('u-bob', 'org_below'), 'u-zed');
    // 集合仍是 bob 的部门闭包成员；客户端传入的 u-zed 只作为交集条件，永远无法被并进来
    expect([...(captures.archiveList?.userIds ?? [])].sort()).toEqual(['u-alice', 'u-bob', 'u-erin']);
    expect(captures.archiveList?.userId).toBe('u-zed');
  });
});
