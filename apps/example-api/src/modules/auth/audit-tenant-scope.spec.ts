/*
 * @file 审计租户隔离（与 dataScope 正交的第二个维度）
 * @description 共享库（shared）下同表数据靠 `tenant_id` 区分。本用例锁定 P1 修复的核心边界：
 *   - 在线列表 / 在线导出 / 归档列表 / 归档导出**四出口**必须自动注入服务端解析出的当前租户，
 *     dataScope=all 也不省略（all 只解除归属人限制，不代表跨租户平台权限）；
 *   - 客户端传入的 `tenant_id` 只能与当前租户相同：指定他租户直接 4001（不能靠 query 越过租户边界）；
 *   - 详情同时校验**归属人范围**与**记录租户归属**，任一不通过统一 404（不泄露存在性）；
 *   - 只有 `@IgnoreTenant()` + `system:tenant:ignore` 的维护入口（守卫写入 ignoreTenant 上下文）才
 *     允许全局 / 按任意租户检索；维护入口只放开租户维度，归属人维度照旧收敛。
 *
 *   与 audit-detail-scope.spec.ts 的分工：那边锁定「四档 dataScope 归属人收敛」，
 *   本文件锁定「租户维度独立强制」；全局访问行为集中在本文件末尾的维护入口用例，
 *   不混进普通端点的租户用例里。
 * @author donttemo
 * @created 2026-10-21
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { META_IGNORE_TENANT, META_PERMISSIONS, collectDescendantIds } from '@fw/auth';
import type { AuditLogRecord, AuditQuery, DataScopeOrgPort, RequestUser } from '@fw/auth';
import { runWithRequestContext } from '@fw/logger';
import type { Request } from 'express';
import { AuditController } from './audit.controller.js';
import { AuditArchiveController } from './audit-archive.controller.js';
import type { AdminStore } from '../admin/admin-store.js';
import type { JobCenterService } from '../jobs/job-center.service.js';
import type { JobRunnerRegistry } from '../jobs/job-runner.registry.js';

/** 共享库里的两个租户 + legacy 存量租户（同一张 audit_log 表，靠 tenant_id 区分） */
const TENANT_A = '17';
const TENANT_B = '18';
const LEGACY = '0';

/** 组织端口桩：d-rd=[u-alice,u-bob]，d-mkt=[u-carol]，d-b=[u-zed]（供 org 档归属人集合计算） */
class FakeOrg implements DataScopeOrgPort {
  async listDepartmentIdsByUserId(userId: string): Promise<string[]> {
    return { 'u-alice': ['d-rd'], 'u-bob': ['d-rd'], 'u-carol': ['d-mkt'], 'u-zed': ['d-b'] }[userId] ?? [];
  }

  async listVisibleDepartmentIds(userId: string, scope: 'org' | 'org_below'): Promise<string[]> {
    const own = await this.listDepartmentIdsByUserId(userId);
    if (own.length === 0) return [];
    return scope === 'org' ? own : collectDescendantIds([{ id: 'd-rd', parentId: '0' }], own);
  }

  async listUserIdsByDepartmentIds(departmentIds: string[]): Promise<string[]> {
    const members: Record<string, string[]> = { 'd-rd': ['u-alice', 'u-bob'], 'd-mkt': ['u-carol'], 'd-b': ['u-zed'] };
    const users = new Set<string>();
    for (const dept of departmentIds) for (const user of members[dept] ?? []) users.add(user);
    return [...users];
  }
}

const ORG = new FakeOrg();

/** 构造审计行（只填契约必需列；tenantId 是本用例的核心变量） */
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

/**
 * 测试数据集：本租户（A）普通/系统记录、B 租户记录、legacy tenant_id=0 记录。
 * 同一张表、不同租户，验证「租户」不是「归属人」的子集。
 */
const RECORDS: AuditLogRecord[] = [
  record('log-a-alice', 'u-alice'),
  record('log-a-bob', 'u-bob'),
  record('log-a-carol', 'u-carol'),
  record('log-a-system', null, TENANT_A),
  record('log-b-zed', 'u-zed', TENANT_B),
  record('log-legacy-system', null, LEGACY),
];

/** 四出口捕获到的查询条件（列表）与导出 params */
interface Captures {
  onlineList?: AuditQuery;
  archiveList?: AuditQuery;
  onlineExport?: Record<string, unknown>;
  archiveExport?: Record<string, unknown>;
}

/** 与存储层同语义的行集收敛：租户条件 + 归属人集合（空集合 = 空结果） */
function selectRows(rows: AuditLogRecord[], query: AuditQuery): AuditLogRecord[] {
  let selected = [...rows];
  if (query.tenantId !== undefined) selected = selected.filter((row) => row.tenantId === query.tenantId);
  if (query.userIds !== undefined) {
    const allowed = new Set(query.userId ? query.userIds.filter((id) => id === query.userId) : query.userIds);
    selected = selected.filter((row) => (row.userId ? allowed.has(row.userId) : false));
  } else if (query.userId) {
    selected = selected.filter((row) => row.userId === query.userId);
  }
  return selected;
}

/** 控制器测试装置：四个读出口 + 详情 + 维护入口共用同一份数据 */
function createHarness(): {
  online: AuditController;
  archive: AuditArchiveController;
  captures: Captures;
  raw: (id: string) => AuditLogRecord | null;
} {
  const byId = new Map(RECORDS.map((row) => [row.id, row]));
  const captures: Captures = {};
  const toPage = (query: AuditQuery) => {
    const rows = selectRows(RECORDS, query);
    return { items: rows, total: rows.length, page: query.page, pageSize: query.pageSize, hasMore: false };
  };
  const authStub = {
    auditLogs: async (query: AuditQuery) => {
      captures.onlineList = query;
      return toPage(query);
    },
  };
  const archiveStub = {
    page: async (query: AuditQuery) => {
      captures.archiveList = query;
      return toPage(query);
    },
  };
  const jobsStub = {
    create: async (input: { type: string; params: Record<string, unknown> }) => {
      if (input.type === 'audit.archive.export') captures.archiveExport = input.params;
      else captures.onlineExport = input.params;
      return { id: 'job-1' };
    },
  };
  const registryStub = { register: () => undefined };
  const auditStub = { recordEvent: () => undefined };

  const online = new AuditController(
    authStub as never,
    ORG,
    { findAuditLogById: async (id: string) => byId.get(id) ?? null } as unknown as AdminStore,
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
  return { online, archive, captures, raw: (id) => byId.get(id) ?? null };
}

/** 请求桩（本用例只关心 query；headers/ip 供 clientIp 使用） */
const REQUEST = { query: {}, headers: {}, ip: '127.0.0.1' } as unknown as Request;

/**
 * 列表 / 导出的位置参数占位：中间 13 个过滤位（module, action, target_type, target_id, from, to,
 * sort, trace_id, request_id, family_id, category, event, result）本用例不关心，用定长元组占位，
 * 保证最后一个位置正好是 `tenant_id`（位置写错会把租户值喂给 result 之类的解析器）。
 */
const FILTER_PAD: [
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined,
] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];

/** 列表 / 导出的客户端入参（tenantId 为 query `tenant_id`，故意与位置参数区分命名） */
interface ClientFilters {
  userId?: string;
  tenantId?: string;
}

/**
 * 调列表端点：Nest 平时由 @Query 注入，单测必须按位置显式给。
 * 位置（list）：page, pageSize, user_id, module, action, target_type, target_id, from, to, sort,
 *   trace_id, request_id, family_id, category, event, result, tenant_id
 */
function callOnlineList(controller: AuditController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.list(requester, REQUEST, '1', '20', filters.userId, ...FILTER_PAD, filters.tenantId);
}

/** 调归档列表端点（位置参数与在线列表一致） */
function callArchiveList(controller: AuditArchiveController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.list(requester, REQUEST, '1', '20', filters.userId, ...FILTER_PAD, filters.tenantId);
}

/** 调在线导出端点（第 4 位起为 query 参数；最后一位是 tenant_id） */
function callOnlineExport(controller: AuditController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.export(requester, requester.id, REQUEST, filters.userId, ...FILTER_PAD, filters.tenantId);
}

/** 调归档导出端点（位置参数与在线导出一致） */
function callArchiveExport(controller: AuditArchiveController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.export(requester, requester.id, REQUEST, filters.userId, ...FILTER_PAD, filters.tenantId);
}

/** 维护入口四出口（与普通出口同参数，仅路径/元数据不同） */
function callPlatformList(controller: AuditController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.platformList(requester, REQUEST, '1', '20', filters.userId, ...FILTER_PAD, filters.tenantId);
}

function callPlatformArchiveList(controller: AuditArchiveController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.platformList(requester, REQUEST, '1', '20', filters.userId, ...FILTER_PAD, filters.tenantId);
}

function callPlatformExport(controller: AuditController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.platformExport(requester, requester.id, REQUEST, filters.userId, ...FILTER_PAD, filters.tenantId);
}

function callPlatformArchiveExport(controller: AuditArchiveController, requester: RequestUser, filters: ClientFilters = {}): Promise<unknown> {
  return controller.platformExport(requester, requester.id, REQUEST, filters.userId, ...FILTER_PAD, filters.tenantId);
}

/** 构造请求用户；tenantId 省略 = legacy 单租户部署里无租户归属的账号 */
function user(id: string, dataScope: RequestUser['dataScope'], tenantId?: string): RequestUser {
  return {
    id,
    username: id,
    roles: [],
    permissions: ['audit:read', 'audit:export', 'system:tenant:ignore'],
    dataScope,
    via: 'jwt',
    ...(tenantId !== undefined ? { tenantId } : {}),
  };
}

/** 本租户（A）的 all 管理员：归属人维度不限，但租户维度仍被强制 */
const ADMIN_A = user('u-admin', 'all', TENANT_A);

/** 捕获抛出的 BizError（未抛出即用例失败） */
async function captureError(promise: Promise<unknown>): Promise<BizError> {
  try {
    await promise;
  } catch (error) {
    return error as BizError;
  }
  throw new Error('应抛出 BizError（普通请求显式指定他租户必须 fail-closed）');
}

/** 断言详情被拒为 404/1002（与「记录不存在」一致，不泄露存在性） */
async function expectDenied(controller: AuditController, requester: RequestUser, id: string): Promise<void> {
  const error = await captureError(controller.detail(requester, id));
  expect(error).toBeInstanceOf(BizError);
  expect(error.code).toBe(ErrorCode.NOT_FOUND);
}

/** 断言 4001（租户条件与当前租户不一致） */
async function expectTenantRejected(promise: Promise<unknown>): Promise<void> {
  const error = await captureError(promise);
  expect(error).toBeInstanceOf(BizError);
  expect(error.code).toBe(ErrorCode.TENANT_INVALID);
  expect(error.code).toBe(4001);
}

/** 提取列表结果的记录 ID（排序后便于断言集合） */
function idsOf(result: unknown): string[] {
  const page = result as { items: AuditLogRecord[] };
  return page.items.map((row) => row.id).sort();
}

describe('P1 · 审计租户隔离（与 dataScope 正交）', () => {
  it('四出口强制注入服务端当前租户：dataScope=all 也不省略', async () => {
    const h = createHarness();

    // 在线列表 / 归档列表：租户条件 = 服务端当前租户，行集只剩本租户（含本租户系统任务）
    expect(idsOf(await callOnlineList(h.online, ADMIN_A))).toEqual(['log-a-alice', 'log-a-bob', 'log-a-carol', 'log-a-system']);
    expect(h.captures.onlineList?.tenantId).toBe(TENANT_A);
    expect(idsOf(await callArchiveList(h.archive, ADMIN_A))).toEqual(['log-a-alice', 'log-a-bob', 'log-a-carol', 'log-a-system']);
    expect(h.captures.archiveList?.tenantId).toBe(TENANT_A);

    // 在线导出 / 归档导出：派发 params 固化同一租户条件（跨实例重跑沿用）
    await callOnlineExport(h.online, ADMIN_A);
    expect(h.captures.onlineExport?.tenantId).toBe(TENANT_A);
    await callArchiveExport(h.archive, ADMIN_A);
    expect(h.captures.archiveExport?.tenantId).toBe(TENANT_A);
  });

  it('客户端 tenant_id 不能放大：显式指定他租户在四出口一律 4001', async () => {
    const h = createHarness();
    await expectTenantRejected(callOnlineList(h.online, ADMIN_A, { tenantId: TENANT_B }));
    await expectTenantRejected(callArchiveList(h.archive, ADMIN_A, { tenantId: TENANT_B }));
    await expectTenantRejected(callOnlineExport(h.online, ADMIN_A, { tenantId: TENANT_B }));
    await expectTenantRejected(callArchiveExport(h.archive, ADMIN_A, { tenantId: TENANT_B }));
    // 也拒绝请求 legacy 存量租户（客户端不能自行挑选租户，包括 '0'）
    await expectTenantRejected(callOnlineList(h.online, ADMIN_A, { tenantId: LEGACY }));
  });

  it('客户端 tenant_id 与当前租户一致：照常放行（同值不产生副作用）', async () => {
    const h = createHarness();
    await callOnlineList(h.online, ADMIN_A, { tenantId: TENANT_A });
    expect(h.captures.onlineList?.tenantId).toBe(TENANT_A);
    await callArchiveExport(h.archive, ADMIN_A, { tenantId: TENANT_A });
    expect(h.captures.archiveExport?.tenantId).toBe(TENANT_A);
  });

  it('详情：all 只解除归属人限制，不能凭记录 ID 跨租户读取', async () => {
    const h = createHarness();

    // 本租户记录（含系统任务）可读——归属人维度确实不限
    await expect(h.online.detail(ADMIN_A, 'log-a-bob')).resolves.toMatchObject({ id: 'log-a-bob' });
    await expect(h.online.detail(ADMIN_A, 'log-a-system')).resolves.toMatchObject({ id: 'log-a-system' });

    // 跨租户记录 / legacy tenant_id=0 记录：即使 dataScope=all 也 404（记录存在，拒绝来自租户判定）
    for (const id of ['log-b-zed', 'log-legacy-system']) {
      expect(h.raw(id)).not.toBeNull();
      await expectDenied(h.online, ADMIN_A, id);
    }
  });

  it('详情：归属人与租户两个维度同时校验（任一不通过都 404）', async () => {
    const h = createHarness();
    const aliceA = user('u-alice', 'self', TENANT_A);
    const zedB = user('u-zed', 'self', TENANT_B);

    await expect(h.online.detail(aliceA, 'log-a-alice')).resolves.toMatchObject({ id: 'log-a-alice' });
    await expectDenied(h.online, aliceA, 'log-a-bob'); // 同租户但超出归属人范围
    await expectDenied(h.online, aliceA, 'log-b-zed'); // 跨租户（同时超出归属人范围）
    await expect(h.online.detail(zedB, 'log-b-zed')).resolves.toMatchObject({ id: 'log-b-zed' });
    await expectDenied(h.online, zedB, 'log-a-alice'); // 反向：B 租户用户读不到 A 租户记录
  });

  it('legacy 单租户（无租户上下文 / 无用户租户）：不注入租户过滤，保持既有行为', async () => {
    const h = createHarness();
    const legacyAdmin = user('u-root', 'all'); // 未设置 tenantId

    expect(idsOf(await callOnlineList(h.online, legacyAdmin))).toEqual(RECORDS.map((row) => row.id).sort());
    expect(h.captures.onlineList?.tenantId).toBeUndefined();
    await expect(h.online.detail(legacyAdmin, 'log-b-zed')).resolves.toMatchObject({ id: 'log-b-zed' });
  });

  it('维护入口：仅守卫写入 ignoreTenant 后才全局可读（可再按 tenant_id 收窄）', async () => {
    const h = createHarness();

    // 同一控制器方法、无 ignoreTenant 上下文（普通请求）→ 仍按当前租户收敛：
    // 绕过能力来自守卫校验后的上下文标志，不来自方法名 / dataScope
    expect(idsOf(await callPlatformList(h.online, ADMIN_A))).toEqual(['log-a-alice', 'log-a-bob', 'log-a-carol', 'log-a-system']);
    expect(h.captures.onlineList?.tenantId).toBe(TENANT_A);

    await runWithRequestContext({ traceId: 'mt-tenant', spanId: '', tenantId: TENANT_A, ignoreTenant: true }, async () => {
      // 全局列表：不带 tenant_id 即全部租户
      expect(idsOf(await callPlatformList(h.online, ADMIN_A))).toEqual(RECORDS.map((row) => row.id).sort());
      expect(h.captures.onlineList?.tenantId).toBeUndefined();
      // 维护入口可按任意 tenant_id 收窄（这里是普通端点会 4001 的那个值）
      expect(idsOf(await callPlatformList(h.online, ADMIN_A, { tenantId: TENANT_B }))).toEqual(['log-b-zed']);
      expect(h.captures.onlineList?.tenantId).toBe(TENANT_B);

      // 全局详情：跨租户与 legacy 记录都可读
      await expect(h.online.platformDetail(ADMIN_A, 'log-b-zed')).resolves.toMatchObject({ id: 'log-b-zed' });
      await expect(h.online.platformDetail(ADMIN_A, 'log-legacy-system')).resolves.toMatchObject({ id: 'log-legacy-system' });

      // 全局导出：params.tenantId 为 null（不注入租户条件），派发时固化
      await callPlatformExport(h.online, ADMIN_A);
      expect(h.captures.onlineExport?.tenantId).toBeNull();
      await callPlatformExport(h.online, ADMIN_A, { tenantId: TENANT_B });
      expect(h.captures.onlineExport?.tenantId).toBe(TENANT_B);

      // 归档维护出口同一语义
      expect(idsOf(await callPlatformArchiveList(h.archive, ADMIN_A))).toEqual(RECORDS.map((row) => row.id).sort());
      expect(h.captures.archiveList?.tenantId).toBeUndefined();
      await callPlatformArchiveExport(h.archive, ADMIN_A);
      expect(h.captures.archiveExport?.tenantId).toBeNull();
    });
  });

  it('维护入口的路由元数据：只有 platform* 标 @IgnoreTenant，普通端点不带豁免标志', () => {
    // 守卫按路由元数据决定是否放行跨租户（并要求 system:tenant:ignore）——元数据缺失/误挂都是边界缺陷
    for (const handler of [AuditController.prototype.platformList, AuditController.prototype.platformExport, AuditController.prototype.platformDetail]) {
      expect(Reflect.getMetadata(META_IGNORE_TENANT, handler), handler.name).toBe(true);
    }
    for (const handler of [AuditController.prototype.list, AuditController.prototype.export, AuditController.prototype.detail]) {
      expect(Reflect.getMetadata(META_IGNORE_TENANT, handler), handler.name).not.toBe(true);
    }
    for (const handler of [AuditArchiveController.prototype.platformList, AuditArchiveController.prototype.platformExport]) {
      expect(Reflect.getMetadata(META_IGNORE_TENANT, handler), handler.name).toBe(true);
    }
    for (const handler of [AuditArchiveController.prototype.list, AuditArchiveController.prototype.export]) {
      expect(Reflect.getMetadata(META_IGNORE_TENANT, handler), handler.name).not.toBe(true);
    }
    // 维护入口仍受业务权限码约束（与 system:tenant:ignore 是「与」关系，不是二选一）
    expect(Reflect.getMetadata(META_PERMISSIONS, AuditController.prototype.platformList)).toEqual(['audit:read']);
    expect(Reflect.getMetadata(META_PERMISSIONS, AuditController.prototype.platformExport)).toEqual(['audit:export']);
    expect(Reflect.getMetadata(META_PERMISSIONS, AuditArchiveController.prototype.platformExport)).toEqual(['audit:export']);
  });

  it('维护入口只放开租户维度：归属人（dataScope）维度照旧收敛', async () => {
    const h = createHarness();
    const carolA = user('u-carol', 'org', TENANT_A); // d-mkt 成员

    await runWithRequestContext({ traceId: 'mt-scope', spanId: '', tenantId: TENANT_A, ignoreTenant: true }, async () => {
      // 租户不限，但 org 档归属人集合只有 d-mkt（u-carol）→ 看不到其他租户的系统记录 / 他人记录
      expect(idsOf(await callPlatformList(h.online, carolA))).toEqual(['log-a-carol']);
      expect(h.captures.onlineList?.tenantId).toBeUndefined();
      expect([...(h.captures.onlineList?.userIds ?? [])].sort()).toEqual(['u-carol']);
    });
  });
});
