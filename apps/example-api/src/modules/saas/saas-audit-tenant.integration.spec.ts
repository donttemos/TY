/*
 * @file 集成验收：SaaS 运营审计的租户维度（真实库 + 真实 AuditService）
 * @description 控制器的桩用例只能证明「payload 里传了 tenantId」，证明不了「落库的 tenant_id 对不对」。
 *   本用例用**真实 PrismaAuthStore + 真实 AuditService + 真实 PrismaSaasStore** 落一条真实的拒绝审计，
 *   回答两件事：
 *   ① 平台运营请求（@IgnoreTenant，通常不带 x-tenant-id，请求上下文无 tenantId）下，
 *      `saas.subscription.create_rejected` 的 tenant_id 必须是**目标租户**，而不是回退成 0；
 *   ② 平台审计的租户筛选（`where.tenantId`）能按该租户查到这条记录——这正是运营的实际检索路径。
 *   反向对照组证明「不显式传就落 0、按租户查不到」不是猜测，而是必须被修复的行为；
 *   套餐事件（平台级对象）同样锁定为不落租户维度，避免平台配置动作被租户查询命中。
 *   同一契约也覆盖 `/tenants` 租户管理面（整类 `@IgnoreTenant()`，走的是 `audit.record` 低层通道）：
 *   开租户的审计必须落新租户维度，否则「该租户被创建」在平台审计按租户检索时不可见。
 *
 *   本地/CI 基础作业：自建临时 SQLite 并按序执行全量迁移 DDL（与 audit-tenant-isolation 集成同款）。
 *   真机取证口径见 CHANGELOG / docs/64。
 * @author donttemo
 * @created 2026-10-21
 * @module example-api/saas
 */
import 'reflect-metadata';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { PrismaClient } from '@prisma/client';
import { AuditService, type AuditLogRecord, type RequestUser } from '@fw/auth';
import { ErrorCode } from '@fw/core';
import type { Request } from 'express';
import { PrismaAuthStore } from '../auth/prisma-auth-store.js';
import { PrismaSaasStore } from './prisma-saas-store.js';
import { SaasOpsController } from './saas-ops.controller.js';
import { TenantAdminController } from '../tenant/tenant-admin.controller.js';
import { PrismaTenantAdminStore } from '../tenant/tenant-admin.store.js';
import { applyAllSqliteMigrations } from '../../testing/apply-sqlite-migrations.js';

/** 已终止租户（终态，迁移表只有 dispose）：开通订阅必被拒 */
const TERMINATED = '21';
/** 正常租户：用于套餐事件对照（平台级对象不该落任何租户） */
const ACTIVE = '22';

const DB_FILE = path.join(process.cwd(), 'prisma', 'test-saas-audit-tenant.db');
const DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;

let prisma: PrismaClient | null = null;
let authStore: PrismaAuthStore | null = null;
let saasStore: PrismaSaasStore | null = null;
let audit: AuditService | null = null;
let controller: SaasOpsController | null = null;

/** 请求桩（控制器只关心 headers / ip） */
const REQUEST = { headers: {}, ip: '127.0.0.1' } as unknown as Request;

/** 平台运营操作人（持有 ops:saas:write；权限判定由守卫覆盖，本用例只关心审计落库） */
const OPERATOR: RequestUser = {
  id: 'u-ops',
  username: 'ops-admin',
  roles: [],
  permissions: ['ops:saas:read', 'ops:saas:write', 'system:tenant:ignore'],
  dataScope: 'all',
  via: 'jwt',
};

/** 套餐服务桩：只提供 plan.create 需要的返回值（本用例不触达订阅领域服务） */
function plansStub(): { createPlan: (input: { code: string; name: string }) => Promise<{ id: string; code: string; name: string }> } {
  return {
    createPlan: async (input) => ({ id: 'plan-it-1', ...input }),
  };
}

/** 轮询等待异步审计落库（recordEvent 是 fire-and-forget，不阻塞业务返回） */
async function waitForRow(find: () => Promise<AuditLogRecord | null>, timeoutMs = 3000): Promise<AuditLogRecord> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const row = await find();
    if (row) return row;
    if (Date.now() > deadline) throw new Error(`审计行未在 ${timeoutMs}ms 内落库`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/** 按 事件 + tenant_id 走**真实查询路径**（与平台审计列表同一个 where 组装） */
async function findAudit(event: string, tenantId?: string): Promise<AuditLogRecord | null> {
  const page = await authStore!.pageAuditLogs({ page: 1, pageSize: 10, event, ...(tenantId ? { tenantId } : {}) });
  return page.items[0] ?? null;
}

beforeAll(async () => {
  fs.rmSync(DB_FILE, { force: true });
  fs.closeSync(fs.openSync(DB_FILE, 'w'));
  await applyAllSqliteMigrations(DB_URL);
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
  await prisma.$connect();
  authStore = new PrismaAuthStore(prisma as never);
  saasStore = new PrismaSaasStore(prisma as never);
  audit = new AuditService(authStore as never);
  controller = new SaasOpsController(
    saasStore,
    plansStub() as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    audit,
  );
  await prisma.tenant.createMany({
    data: [
      { id: TERMINATED, code: 'it-terminated', name: '集成终止租户', status: 4 },
      { id: ACTIVE, code: 'it-active', name: '集成正常租户', status: 1 },
    ],
  });
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  fs.rmSync(DB_FILE, { force: true });
});

describe('SaaS 运营审计的租户维度（真实库）', () => {
  it('终止租户开通被拒：tenant_id 落目标租户，平台审计按该租户查得到、按 0 查不到', async () => {
    // 无请求上下文 = 线上 @IgnoreTenant 运营请求的常态（没有 x-tenant-id，persist 无处可回退）
    await expect(
      controller!.createSubscription({ tenantId: TERMINATED, planCode: 'default' } as never, OPERATOR, undefined),
    ).rejects.toMatchObject({ code: ErrorCode.LIFECYCLE_TRANSITION_INVALID });

    const row = await waitForRow(() => findAudit('saas.subscription.create_rejected', TERMINATED));
    expect(row.tenantId).toBe(TERMINATED); // 落库就是目标租户，不是 0
    expect(row.result).toBe('denied');
    expect(row.targetLabel).toBe('集成终止租户'); // 名称快照仍按目标租户解析
    expect(row.actorLabel).toBe('ops-admin');

    // 运营的实际检索路径：平台审计按租户筛选（where.tenantId）
    expect(await findAudit('saas.subscription.create_rejected', '0')).toBeNull();
  });

  it('对照组：同一事件不传 tenantId 时落 0，按目标租户筛选查不到（证明显式传值是唯一正确姿势）', async () => {
    // 直接调用 AuditService 模拟「漏传 tenantId」的写入点（无请求上下文）
    audit!.recordEventSync('saas.subscription.create_rejected', {
      userId: OPERATOR.id,
      targetType: 'tenant',
      targetId: TERMINATED,
      targetLabel: '集成终止租户',
      result: 'denied',
      reason: '对照：漏传 tenantId',
    });
    const legacyRow = await waitForRow(async () => {
      const page = await authStore!.pageAuditLogs({ page: 1, pageSize: 10, event: 'saas.subscription.create_rejected', tenantId: '0' });
      return page.items.find((item) => item.reason === '对照：漏传 tenantId') ?? null;
    });
    expect(legacyRow.tenantId).toBe('0');
    // 按目标租户筛选时它不会出现——这就是修复前的真实后果
    const page = await authStore!.pageAuditLogs({ page: 1, pageSize: 10, event: 'saas.subscription.create_rejected', tenantId: TERMINATED });
    expect(page.items.some((item) => item.reason === '对照：漏传 tenantId')).toBe(false);
  });

  it('套餐事件是平台级对象：不落租户维度（不会污染租户的审计视图）', async () => {
    await controller!.createPlan({ code: 'it-plan', name: '集成套餐' } as never, OPERATOR, undefined);
    const row = await waitForRow(() => findAudit('saas.plan.create', '0'));
    expect(row.tenantId).toBe('0');
    expect(await findAudit('saas.plan.create', TERMINATED)).toBeNull();
    expect(await findAudit('saas.plan.create', ACTIVE)).toBeNull();
  });
});

describe('租户管理面审计的租户维度（/tenants 同为 @IgnoreTenant，走 audit.record 低层通道）', () => {
  it('开租户：审计落新租户维度，平台按该租户可查、按 0 查不到', async () => {
    const adminStore = new PrismaTenantAdminStore(prisma as never);
    const adminController = new TenantAdminController(
      adminStore as never,
      { invalidate: () => undefined } as never, // TenantService：开租户后失效解析缓存
      { create: async () => ({ id: 'job-stub' }) } as never, // 本用例不触达异步任务
      audit!,
      { register: () => undefined } as never,
      {} as never, // 生命周期服务：开租户不迁移状态
    );
    const created = await adminController.create(
      { code: 'it-new-tenant', name: '集成新建租户', isolation: 'shared' } as never,
      OPERATOR.id,
      REQUEST,
    );

    const row = await waitForRow(async () => {
      const page = await authStore!.pageAuditLogs({ page: 1, pageSize: 10, module: 'tenant', action: 'create', targetId: created.id });
      return page.items[0] ?? null;
    });
    expect(row.tenantId).toBe(created.id); // 落新租户，不是 0
    expect(row.targetType).toBe('tenant');

    const byTenant = await authStore!.pageAuditLogs({ page: 1, pageSize: 10, module: 'tenant', action: 'create', tenantId: created.id });
    expect(byTenant.items.some((item) => item.targetId === created.id)).toBe(true);
    const byZero = await authStore!.pageAuditLogs({ page: 1, pageSize: 10, module: 'tenant', action: 'create', tenantId: '0' });
    expect(byZero.items.some((item) => item.targetId === created.id)).toBe(false);
  });
});
