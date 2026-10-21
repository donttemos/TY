/*
 * @file 集成验收：审计租户隔离（真实库 + 两个租户账号）
 * @description PRD-015 AC-15-07 / AC-15-09 的「真实多租户数据」取证，补上控制器桩用例证明不了的两件事：
 *   ① 行集来自**真实数据库查询**（Prisma 的 `where.tenantId`），而不是测试桩里复刻的过滤逻辑；
 *   ② 导出**产物内容**由真实行集生成，且任务跨实例重跑时按派发时固化的 params 重建查询——
 *      重跑不会丢失租户限制（新增的他租户行绝不出现在产物里）。
 *
 *   数据集刻意用「两个真实租户 + legacy 存量租户」：
 *   - 租户 A（17）管理员 dataScope=all、租户 B（18）成员、legacy（0）系统行；
 *   - 普通出口：A 管理员列表/详情/导出只能拿到 A 租户行，`tenant_id=B` 一律 4001；
 *   - 维护出口：`ignoreTenant` 上下文 + platform* 才跨租户，且可按 tenant_id 收窄；
 *   - 写入侧：`@fw/auth` 的 AuditService 在请求上下文里写库，落盘 `tenant_id` 必须是当前租户。
 *
 *   本地/CI 基础作业：自建临时 SQLite 并按序执行全量迁移 DDL（与 prisma-saas-store 集成同款）；
 *   MySQL / PostgreSQL 的方言矩阵未接入本用例，真机双账号验收步骤见 PRD-015 §7.3。
 * @author donttemo
 * @created 2026-10-21
 * @module example-api/auth
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AuditArchiveService, AuditService, type AuditLogRecord, type AuditQuery, type DataScopeOrgPort, type RequestUser } from '@fw/auth';
import { BizError, ErrorCode } from '@fw/core';
import { runWithRequestContext } from '@fw/logger';
import type { Request } from 'express';
import { AuditController } from './audit.controller.js';
import { AuditArchiveController } from './audit-archive.controller.js';
import { PrismaAuthStore } from './prisma-auth-store.js';
import { PrismaAdminStore } from '../admin/admin-store.js';
import { PrismaAuditArchiveStore } from './audit-archive-store.js';
import type { JobCenterService } from '../jobs/job-center.service.js';
import type { JobRunnerRegistry } from '../jobs/job-runner.registry.js';
import { applyAllSqliteMigrations } from '../../testing/apply-sqlite-migrations.js';

/** 共享库里的两个真实租户 + legacy 存量租户（同一张审计 / 归档表，靠 tenant_id 区分） */
const TENANT_A = '17';
const TENANT_B = '18';
const LEGACY = '0';

const DB_FILE = path.join(process.cwd(), 'prisma', 'test-audit-tenant.db');
const DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;

let prisma: PrismaClient | null = null;
let store: PrismaAuthStore | null = null;
let admin: PrismaAdminStore | null = null;
let audit: AuditService | null = null;
let archive: AuditArchiveService | null = null;

/** 请求桩（控制器只关心 query / headers / ip） */
const REQUEST = { query: {}, headers: {}, ip: '127.0.0.1' } as unknown as Request;

/** 列表 / 导出的中间 13 个过滤位（module … result），保证最后一位正好是 tenant_id */
const FILTER_PAD: [
  undefined, undefined, undefined, undefined, undefined, undefined, undefined,
  undefined, undefined, undefined, undefined, undefined, undefined,
] = [undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined];

/** 导出派发捕获（params + 可直接执行的 runner/工厂，供「重跑」用例复用） */
interface CapturedJob {
  type: string;
  params: Record<string, unknown>;
  runner: (report: (percent: number, message?: string) => void) => Promise<{ content: string; fileName: string }>;
}

/** 控制器测试装置：列表/导出走**真实 Prisma 查询**，详情走真实 AdminStore，任务中心只做捕获与执行 */
function createHarness(): {
  controller: AuditController;
  jobs: CapturedJob[];
  factories: Map<string, (params: Record<string, unknown>) => CapturedJob['runner']>;
} {
  const jobs: CapturedJob[] = [];
  const factories = new Map<string, (params: Record<string, unknown>) => CapturedJob['runner']>();
  const controller = new AuditController(
    // 真实存储层：控制器注入的租户 / 归属人条件直接落到 Prisma where
    { auditLogs: (query: AuditQuery) => store!.pageAuditLogs(query) } as never,
    store as unknown as DataScopeOrgPort,
    admin as never,
    {
      create: async (input: CapturedJob) => {
        jobs.push(input);
        return { id: `job-${jobs.length}` };
      },
    } as unknown as JobCenterService,
    {
      register: (type: string, factory: (params: Record<string, unknown>) => CapturedJob['runner']) => {
        factories.set(type, factory);
      },
    } as unknown as JobRunnerRegistry,
    { recordEvent: () => undefined } as never,
  );
  return { controller, jobs, factories };
}

/**
 * 归档控制器测试装置（与在线同款）
 *
 * 归档查询走 `AuditArchiveService` → `PrismaAuditArchiveStore` 的**真实归档表**，任务中心只做捕获，
 * 保证「在线/归档两套出口」的权限边界与产物格式都能在真实数据上对照。
 */
function createArchiveHarness(): {
  controller: AuditArchiveController;
  jobs: CapturedJob[];
  factories: Map<string, (params: Record<string, unknown>) => CapturedJob['runner']>;
} {
  const jobs: CapturedJob[] = [];
  const factories = new Map<string, (params: Record<string, unknown>) => CapturedJob['runner']>();
  const controller = new AuditArchiveController(
    archive as never,
    store as unknown as DataScopeOrgPort,
    {
      create: async (input: CapturedJob) => {
        jobs.push(input);
        return { id: `job-${jobs.length}` };
      },
    } as unknown as JobCenterService,
    {
      register: (type: string, factory: (params: Record<string, unknown>) => CapturedJob['runner']) => {
        factories.set(type, factory);
      },
    } as unknown as JobRunnerRegistry,
    { recordEvent: () => undefined } as never,
  );
  return { controller, jobs, factories };
}

/** 造数据：两个租户的用户 + 五条审计行（两个租户 + legacy 系统行） */
async function seed(): Promise<void> {
  await prisma!.user.createMany({
    data: [
      { id: 'u-a', tenantId: BigInt(TENANT_A), username: 'tenant-a-admin', passwordHash: 'x', nickname: '租户A管理员' },
      { id: 'u-a2', tenantId: BigInt(TENANT_A), username: 'tenant-a-member', passwordHash: 'x', nickname: '租户A成员' },
      { id: 'u-b', tenantId: BigInt(TENANT_B), username: 'tenant-b-admin', passwordHash: 'x', nickname: '租户B管理员' },
    ],
  });
  const base = Date.UTC(2026, 9, 21, 0, 0, 0);
  const rows = [
    { id: 'log-a-1', tenantId: BigInt(TENANT_A), userId: 'u-a', module: 'user', action: 'create' },
    { id: 'log-a-2', tenantId: BigInt(TENANT_A), userId: 'u-a2', module: 'user', action: 'update' },
    { id: 'log-a-sys', tenantId: BigInt(TENANT_A), userId: null, module: 'system', action: 'export' },
    { id: 'log-b-1', tenantId: BigInt(TENANT_B), userId: 'u-b', module: 'user', action: 'create' },
    { id: 'log-legacy', tenantId: BigInt(LEGACY), userId: null, module: 'system', action: 'login' },
  ];
  let index = 0;
  for (const row of rows) {
    await prisma!.auditLog.create({
      data: {
        ...row,
        action: row.action,
        category: 'admin',
        event: row.action === 'export' ? 'audit.export' : 'user.create',
        result: 'success',
        ip: '10.0.0.1',
        userAgent: 'it',
        traceId: `trace-${row.id}`,
        createdAt: new Date(base + index * 60_000),
        actorLabel: row.userId ?? null,
        auditSource: 'domain',
      },
    });
    index += 1;
  }

  // 平台审计租户选项的真实数据源（含 legacy '0'；停用租户的历史审计仍需可按租户追溯）
  await prisma!.tenant.createMany({
    data: [
      { id: LEGACY, code: 'legacy', name: '存量单租户', status: 1 },
      { id: TENANT_A, code: 'tenant-a', name: '租户A', status: 1 },
      { id: TENANT_B, code: 'tenant-b', name: '租户B', status: 0 },
    ],
  });

  // 归档表数据（与在线表同构：两租户 + legacy 系统行）——归档出口也必须受租户边界约束
  const archiveRows = [
    { id: 'ar-a-1', tenantId: BigInt(TENANT_A), userId: 'u-a', module: 'user', action: 'create' },
    { id: 'ar-a-sys', tenantId: BigInt(TENANT_A), userId: null, module: 'system', action: 'export' },
    { id: 'ar-b-1', tenantId: BigInt(TENANT_B), userId: 'u-b', module: 'user', action: 'create' },
    { id: 'ar-legacy', tenantId: BigInt(LEGACY), userId: null, module: 'system', action: 'login' },
  ];
  let archiveIndex = 0;
  for (const row of archiveRows) {
    await prisma!.auditLogArchive.create({
      data: {
        ...row,
        category: 'admin',
        event: row.action === 'export' ? 'audit.export' : 'user.create',
        result: 'success',
        ip: '10.0.0.2',
        userAgent: 'it-archive',
        traceId: `trace-${row.id}`,
        createdAt: new Date(Date.UTC(2026, 7, 1) + archiveIndex * 60_000),
        actorLabel: row.userId ?? null,
        auditSource: 'domain',
      },
    });
    archiveIndex += 1;
  }
}

/** 请求用户（权限码由守卫校验，本用例关注数据边界；dataScope 参与归属人范围计算） */
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

/** 本租户 A 的管理员：dataScope=all 只解除归属人限制，**不**解除租户边界 */
const ADMIN_A = user('u-a', 'all', TENANT_A);
/** 普通租户 B 的成员：用于反向验证（B 用户也读不到 A 记录） */
const ADMIN_B = user('u-b', 'all', TENANT_B);

/** 真实请求上下文（租户解析中间件 + 守卫会写入这两个标志） */
function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ traceId: 'it-audit-tenant', spanId: '', tenantId }, fn);
}

/** 已授权的跨租户维护上下文（仅 @IgnoreTenant + system:tenant:ignore 路由会出现） */
function asCrossTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return runWithRequestContext({ traceId: 'it-audit-platform', spanId: '', tenantId, ignoreTenant: true }, fn);
}

/** 调普通列表（Nest 平时由 @Query 注入，单测按位置显式给） */
function callList(controller: AuditController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.list(requester, REQUEST, '1', '200', undefined, ...FILTER_PAD, tenantId);
}

/** 调普通导出 */
function callExport(controller: AuditController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.export(requester, requester.id, REQUEST, undefined, ...FILTER_PAD, tenantId);
}

/** 调平台列表 / 平台导出（与普通出口同参数，仅入口不同） */
function callPlatformList(controller: AuditController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.platformList(requester, REQUEST, '1', '200', undefined, ...FILTER_PAD, tenantId);
}

function callPlatformExport(controller: AuditController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.platformExport(requester, requester.id, REQUEST, undefined, ...FILTER_PAD, tenantId);
}

/** 提取列表记录 ID（排序后便于断言集合；系统行的 userId=null 也如实返回） */
function idsOf(result: unknown): string[] {
  return (result as { items: AuditLogRecord[] }).items.map((row) => row.id).sort();
}

/** 真实库 ground truth：按 where 条件查 ID（不经过被测存储层，避免自证） */
async function dbIds(where: { tenantId?: bigint; userId?: string }): Promise<string[]> {
  const rows = await prisma!.auditLog.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((row) => row.id).sort();
}

/** 从导出产物提取数据行 ID（首列；BOM 与表头去掉，CSV 单元格可能带引号包裹） */
function artifactIds(content: string): string[] {
  const lines = content.replace(/^\uFEFF/, '').split('\r\n').filter((line) => line.length > 0);
  return lines
    .slice(1)
    .map((line) => {
      const first = line.split(',')[0] ?? '';
      return first.startsWith('"') && first.endsWith('"') ? first.slice(1, -1).replace(/""/g, '"') : first;
    })
    .sort();
}

/** 捕获抛出的 BizError（未抛出即用例失败） */
async function captureError(promise: Promise<unknown>): Promise<BizError> {
  try {
    await promise;
  } catch (error) {
    return error as BizError;
  }
  throw new Error('应抛出 BizError');
}

// ---------- 归档出口（P2：在线 / 归档切换的服务端对照） ----------

/** 调普通归档列表 / 导出（与在线出口同参数） */
function callArchiveList(controller: AuditArchiveController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.list(requester, REQUEST, '1', '200', undefined, ...FILTER_PAD, tenantId);
}

function callArchiveExport(controller: AuditArchiveController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.export(requester, requester.id, REQUEST, undefined, ...FILTER_PAD, tenantId);
}

/** 调平台归档列表 / 导出（维护入口） */
function callPlatformArchiveList(controller: AuditArchiveController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.platformList(requester, REQUEST, '1', '200', undefined, ...FILTER_PAD, tenantId);
}

function callPlatformArchiveExport(controller: AuditArchiveController, requester: RequestUser, tenantId?: string): Promise<unknown> {
  return controller.platformExport(requester, requester.id, REQUEST, undefined, ...FILTER_PAD, tenantId);
}

/** 真实库 ground truth：归档表按 where 条件查 ID */
async function dbArchiveIds(where: { tenantId?: bigint; userId?: string }): Promise<string[]> {
  const rows = await prisma!.auditLogArchive.findMany({ where, select: { id: true }, orderBy: { id: 'asc' } });
  return rows.map((row) => row.id).sort();
}

/** 取 CSV 表头（BOM 去掉后的第一行） */
function csvHeader(content: string): string {
  return content.replace(/^\uFEFF/, '').split('\r\n')[0] ?? '';
}

beforeAll(async () => {
  fs.rmSync(DB_FILE, { force: true });
  fs.closeSync(fs.openSync(DB_FILE, 'w'));
  await applyAllSqliteMigrations(DB_URL);
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  await prisma.$connect();
  store = new PrismaAuthStore(prisma as never);
  admin = new PrismaAdminStore(prisma as never);
  audit = new AuditService(store as never);
  archive = new AuditArchiveService(new PrismaAuditArchiveStore(prisma as never));
  await seed();
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(DB_FILE, { force: true });
});

describe('AC-15-09 写入侧：审计落库的 tenant_id 取请求上下文真实值', () => {
  it('请求上下文租户 A → 落盘 tenant_id = A（不是默认 0，也不是别的租户）', async () => {
    await asTenant(TENANT_A, async () => {
      await audit!.recordEventSync('user.create', { userId: 'u-a', targetType: 'user', targetId: 'u-a2', targetLabel: '租户A成员' });
    });
    const row = await prisma!.auditLog.findFirst({ where: { event: 'user.create', targetId: 'u-a2' }, orderBy: { createdAt: 'desc' } });
    expect(row).not.toBeNull();
    expect(row!.tenantId.toString()).toBe(TENANT_A);
  });
});

describe('AC-15-07 / AC-15-09 普通出口：真实库行集与授权边界', () => {
  it('dataScope=all 仍受租户约束：A 管理员列表 = 真实库 tenant_id=A 的行', async () => {
    const h = createHarness();
    const result = await asTenant(TENANT_A, () => callList(h.controller, ADMIN_A));
    expect(idsOf(result)).toEqual(await dbIds({ tenantId: BigInt(TENANT_A) }));
    // 反向：B 租户与 legacy 行一条都不在结果里
    expect(idsOf(result)).not.toContain('log-b-1');
    expect(idsOf(result)).not.toContain('log-legacy');
  });

  it('客户端 tenant_id 不能放大：指定他租户 4001，指定本租户放行', async () => {
    const h = createHarness();
    const error = await asTenant(TENANT_A, () => captureError(callList(h.controller, ADMIN_A, TENANT_B)));
    expect(error.code).toBe(ErrorCode.TENANT_INVALID);
    expect(error.code).toBe(4001);
    const ok = await asTenant(TENANT_A, () => callList(h.controller, ADMIN_A, TENANT_A));
    expect(idsOf(ok)).toEqual(await dbIds({ tenantId: BigInt(TENANT_A) }));
  });

  it('详情双维度：本租户记录可读；他租户 / legacy / 归属人范围外一律 404（与不存在同口径）', async () => {
    const h = createHarness();
    await asTenant(TENANT_A, async () => {
      await expect(h.controller.detail(ADMIN_A, 'log-a-1')).resolves.toMatchObject({ id: 'log-a-1' });
      for (const id of ['log-b-1', 'log-legacy']) {
        // 记录真实存在（ground truth），拒绝只能来自租户维度
        expect(await prisma!.auditLog.count({ where: { id } })).toBe(1);
        const error = await captureError(h.controller.detail(ADMIN_A, id));
        expect(error.code).toBe(ErrorCode.NOT_FOUND);
      }
      // 归属人维度：self 档只看本人（同租户的他人记录也 404）
      const selfA = user('u-a', 'self', TENANT_A);
      await expect(h.controller.detail(selfA, 'log-a-1')).resolves.toMatchObject({ id: 'log-a-1' });
      const selfDenied = await captureError(h.controller.detail(selfA, 'log-a-2'));
      expect(selfDenied.code).toBe(ErrorCode.NOT_FOUND);
    });
    // 反向：B 租户用户读不到 A 租户记录
    await asTenant(TENANT_B, async () => {
      const error = await captureError(h.controller.detail(ADMIN_B, 'log-a-1'));
      expect(error.code).toBe(ErrorCode.NOT_FOUND);
    });
  });

  it('普通导出：产物行集 = 本租户真实行，params 固化租户条件，产物不含他租户记录', async () => {
    const h = createHarness();
    await asTenant(TENANT_A, () => callExport(h.controller, ADMIN_A));
    const job = h.jobs[0]!;
    expect(job.params.tenantId).toBe(TENANT_A);
    const artifact = await job.runner(() => undefined);
    expect(artifactIds(artifact.content)).toEqual(await dbIds({ tenantId: BigInt(TENANT_A) }));
    expect(artifact.content).not.toContain('log-b-1');
    expect(artifact.content).not.toContain('log-legacy');
  });

  it('导出任务重跑：按派发时固化的 params 重建查询，期间新增的他租户行不得混入', async () => {
    const h = createHarness();
    await asTenant(TENANT_A, () => callExport(h.controller, ADMIN_A));
    const job = h.jobs[0]!;
    const firstRun = artifactIds((await job.runner(() => undefined)).content);
    expect(firstRun).toEqual(await dbIds({ tenantId: BigInt(TENANT_A) }));

    // 模拟「重跑窗口内另一个租户又产生了审计」：B 租户新增一行
    await prisma!.auditLog.create({
      data: { id: 'log-b-rerun', tenantId: BigInt(TENANT_B), userId: 'u-b', module: 'user', action: 'create', result: 'success', createdAt: new Date() },
    });
    // 跨实例重跑走 jobRunnerRegistry 注册的工厂（闭包不落盘，只有 params 可序列化）
    const factory = h.factories.get('audit.export');
    expect(factory).toBeDefined();
    const rerun = await factory!(job.params)(() => undefined);
    const rerunIds = artifactIds(rerun.content);
    expect(rerunIds).toEqual(firstRun);
    expect(rerunIds).not.toContain('log-b-rerun');
    // 同一 params 再派发一次（内存驱动闭包）同样不混入
    const again = artifactIds((await job.runner(() => undefined)).content);
    expect(again).toEqual(firstRun);
  });
});

describe('AC-15-09 维护入口：显式授权下的跨租户行为（且只放开租户维度）', () => {
  it('import 上下文才跨租户：平台列表 = 真实库全部行，可按 tenant_id 收窄', async () => {
    const h = createHarness();
    await asCrossTenant(TENANT_A, async () => {
      const all = await callPlatformList(h.controller, ADMIN_A);
      expect(idsOf(all)).toEqual(await dbIds({}));
      const narrowed = await callPlatformList(h.controller, ADMIN_A, TENANT_B);
      expect(idsOf(narrowed)).toEqual(await dbIds({ tenantId: BigInt(TENANT_B) }));
      // 平台详情可读他租户记录，且租户字段如实返回
      await expect(h.controller.platformDetail(ADMIN_A, 'log-b-1')).resolves.toMatchObject({ id: 'log-b-1', tenantId: TENANT_B });
    });
  });

  it('平台导出：params.tenantId = null（不注入租户条件），产物含多租户行', async () => {
    const h = createHarness();
    await asCrossTenant(TENANT_A, () => callPlatformExport(h.controller, ADMIN_A));
    const job = h.jobs[0]!;
    expect(job.params.tenantId).toBeNull();
    const artifact = await job.runner(() => undefined);
    const ids = artifactIds(artifact.content);
    expect(ids).toContain('log-a-1');
    expect(ids).toContain('log-b-1');
  });

  it('维护入口只放开租户维度：dataScope 归属人范围照旧收敛（self 档仍只看本人）', async () => {
    const h = createHarness();
    const selfA = user('u-a', 'self', TENANT_A);
    await asCrossTenant(TENANT_A, async () => {
      const result = await callPlatformList(h.controller, selfA);
      expect(idsOf(result)).toEqual(await dbIds({ userId: 'u-a' }));
      expect(idsOf(result)).not.toContain('log-b-1');
    });
  });

  it('未授权上下文（普通请求直接调 platform* 方法）：仍按当前租户收敛，能力来自守卫而非方法名', async () => {
    const h = createHarness();
    const result = await asTenant(TENANT_A, () => callPlatformList(h.controller, ADMIN_A));
    expect(idsOf(result)).toEqual(await dbIds({ tenantId: BigInt(TENANT_A) }));
    expect(idsOf(result)).not.toContain('log-b-1');
  });
});

describe('P2 归档出口：与在线同权限边界、同租户约束、同产物格式（真实归档表）', () => {
  it('普通归档列表：只返回当前租户归档行（真实库），tenant_id 他租户 4001', async () => {
    const h = createArchiveHarness();
    const scoped = await asTenant(TENANT_A, () => callArchiveList(h.controller, ADMIN_A));
    expect(idsOf(scoped)).toEqual(await dbArchiveIds({ tenantId: BigInt(TENANT_A) }));
    expect(idsOf(scoped)).not.toContain('ar-b-1');
    expect(idsOf(scoped)).not.toContain('ar-legacy');

    const error = await asTenant(TENANT_A, () => captureError(callArchiveList(h.controller, ADMIN_A, TENANT_B)));
    expect(error.code).toBe(ErrorCode.TENANT_INVALID);
  });

  it('普通归档导出：产物只含本租户归档行；params 固化租户；期间新增他租户归档行在重跑时不得混入', async () => {
    const h = createArchiveHarness();
    await asTenant(TENANT_A, () => callArchiveExport(h.controller, ADMIN_A));
    const job = h.jobs[0]!;
    expect(job.params.tenantId).toBe(TENANT_A);
    const firstRun = artifactIds((await job.runner(() => undefined)).content);
    expect(firstRun).toEqual(await dbArchiveIds({ tenantId: BigInt(TENANT_A) }));

    await prisma!.auditLogArchive.create({
      data: { id: 'ar-b-rerun', tenantId: BigInt(TENANT_B), userId: 'u-b', module: 'user', action: 'create', result: 'success', createdAt: new Date() },
    });
    const factory = h.factories.get('audit.archive.export');
    expect(factory).toBeDefined();
    const rerun = artifactIds((await factory!(job.params)(() => undefined)).content);
    expect(rerun).toEqual(firstRun);
    expect(rerun).not.toContain('ar-b-rerun');
  });

  it('在线 / 归档导出产物列序一致（同一份 CSV 定义，两种数据源不产生第二套表头）', async () => {
    const online = createHarness();
    await asTenant(TENANT_A, () => callExport(online.controller, ADMIN_A));
    const onlineCsv = (await online.jobs[0]!.runner(() => undefined)).content;

    const archived = createArchiveHarness();
    await asTenant(TENANT_A, () => callArchiveExport(archived.controller, ADMIN_A));
    const archiveCsv = (await archived.jobs[0]!.runner(() => undefined)).content;

    expect(csvHeader(archiveCsv)).toBe(csvHeader(onlineCsv));
    expect(archiveCsv.startsWith('\uFEFF')).toBe(true);
  });

  it('平台归档维护入口：仅 ignoreTenant 上下文跨租户，可按 tenant_id 收窄；普通上下文仍只本租户', async () => {
    const h = createArchiveHarness();
    await asCrossTenant(TENANT_A, async () => {
      const all = await callPlatformArchiveList(h.controller, ADMIN_A);
      expect(idsOf(all)).toEqual(await dbArchiveIds({}));
      const narrowed = await callPlatformArchiveList(h.controller, ADMIN_A, TENANT_B);
      expect(idsOf(narrowed)).toEqual(await dbArchiveIds({ tenantId: BigInt(TENANT_B) }));
    });

    // 无 ignoreTenant 标志（普通请求）直接调 platform* 方法：租户维度不放开
    const normal = await asTenant(TENANT_A, () => callPlatformArchiveList(h.controller, ADMIN_A));
    expect(idsOf(normal)).toEqual(await dbArchiveIds({ tenantId: BigInt(TENANT_A) }));
    expect(idsOf(normal)).not.toContain('ar-b-1');
  });

  it('平台归档导出：params.tenantId = null，产物含多租户归档行', async () => {
    const h = createArchiveHarness();
    await asCrossTenant(TENANT_A, () => callPlatformArchiveExport(h.controller, ADMIN_A));
    const job = h.jobs[0]!;
    expect(job.params.tenantId).toBeNull();
    const ids = artifactIds((await job.runner(() => undefined)).content);
    expect(ids).toContain('ar-a-1');
    expect(ids).toContain('ar-b-1');
  });
});

describe('P2 平台审计租户选项：真实 tenants 表上的受控查询（不要求 tenant:read）', () => {
  it('keyword 模糊匹配（名称 / 编码）+ 分页元信息；停用租户仍返回（历史审计可追溯）', async () => {
    const page = await admin!.listTenantOptions({ keyword: 'tenant-', page: 1, pageSize: 1 });
    expect(page.total).toBe(2); // tenant-a / tenant-b
    expect(page.items).toHaveLength(1);
    expect(page.hasMore).toBe(true);
    expect(page.items[0]).toMatchObject({ id: expect.any(String), code: expect.any(String), name: expect.any(String), status: expect.any(Number) });

    const byName = await admin!.listTenantOptions({ keyword: '租户B', page: 1, pageSize: 20 });
    expect(byName.items.map((item) => item.id)).toEqual([TENANT_B]);
    // 停用租户（status=0）不能被过滤掉，否则历史审计按租户追溯会断链
    expect(byName.items[0]?.status).toBe(0);

    const second = await admin!.listTenantOptions({ page: 2, pageSize: 1 });
    expect(second.page).toBe(2);
    expect(second.items).toHaveLength(1);
  });

  it('ids 批量解析（审计行 → 租户名）：只返回请求的租户，legacy 0 也在内', async () => {
    const page = await admin!.listTenantOptions({ ids: [TENANT_A, LEGACY], page: 1, pageSize: 100 });
    expect(page.items.map((item) => item.id).sort()).toEqual([LEGACY, TENANT_A].sort());
  });

  it('控制器端点：keyword/ids 收敛后透传真实存储（返回 PageResult 最小投影）', async () => {
    const h = createHarness();
    const byKeyword = await asCrossTenant(TENANT_A, () => h.controller.platformTenantOptions('租户A', undefined, '1', '20'));
    expect(byKeyword.items.map((item) => item.id)).toEqual([TENANT_A]);
    expect(Object.keys(byKeyword.items[0] ?? {}).sort()).toEqual(['code', 'id', 'name', 'status']);

    const byIds = await h.controller.platformTenantOptions(undefined, `${TENANT_B},${LEGACY}`, '1', '100');
    expect(byIds.items.map((item) => item.id).sort()).toEqual([LEGACY, TENANT_B].sort());
  });
});
