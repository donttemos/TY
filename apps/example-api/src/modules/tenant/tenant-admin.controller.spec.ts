/*
 * @file 单测：租户管理端点（N-01）
 * @description 直接实例化 TenantAdminController（不经 HTTP 层）验证端点契约：入参校验
 *   （isolation / status 枚举、code / name / isolation 必填）、404 / 1004 语义、legacy 停用
 *   与迁移拦截、审计记录（before / after / ip）、派发迁移长任务返回 JobView。
 *   存储层校验（编码格式 / 连接串 / 唯一性）见 tenant-admin.store.spec.ts。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/tenant
 */

import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { BizError } from '@fw/core';
import { AuditService } from '@fw/auth';
import { TenantService } from '@fw/tenant';
import { TenantLifecycleService } from '@fw/saas';
import type { LifecycleStatus, LifecycleStore } from '@fw/saas';
import { JobCenterService } from '../jobs/job-center.service.js';
import { JobRunnerRegistry } from '../jobs/job-runner.registry.js';
import { TenantAdminController } from './tenant-admin.controller.js';
import { LEGACY_TENANT_ID } from './tenant-admin.store.js';
import type { TenantAdminStore, TenantStatus, TenantView } from './tenant-admin.store.js';
import type { Request } from 'express';

/** 五态编值 ↔ 领域态（与 PrismaSaasStore 同口径：0 读作 frozen；见 ADR-0029 §2.4） */
const INT_TO_STATUS: Record<number, LifecycleStatus> = { 0: 'frozen', 1: 'active', 2: 'grace', 3: 'frozen', 4: 'terminated', 5: 'pending' };
const STATUS_TO_INT: Record<LifecycleStatus, number> = { pending: 5, active: 1, grace: 2, frozen: 3, terminated: 4 };

/** 构造一个租户视图 */
function makeView(overrides: Partial<TenantView> = {}): TenantView {
  return {
    id: '1',
    code: 'acme',
    name: 'ACME 公司',
    isolation: 'shared',
    plan: 'pro',
    status: 1,
    expireAt: null,
    dedicatedDbConfigured: false,
    createdAt: '2026-10-13T00:00:00.000Z',
    updatedAt: '2026-10-13T00:00:00.000Z',
    ...overrides,
  };
}

/** 内存假存储（镜像真实存储的守卫语义：legacy 不可停用 / 不可迁移） */
function createFakeStore(initial: TenantView[] = [makeView()]) {
  const rows = [...initial];
  const store: TenantAdminStore = {
    async pageTenants(query) {
      let items = [...rows];
      if (query.keyword) items = items.filter((t) => t.code.includes(query.keyword!) || t.name.includes(query.keyword!));
      if (query.isolation) items = items.filter((t) => t.isolation === query.isolation);
      if (query.status !== undefined) items = items.filter((t) => t.status === query.status);
      return { items, total: items.length, page: query.page, pageSize: query.pageSize, hasMore: false };
    },
    async findTenantViewById(id) {
      // 与真实 Prisma 同语义：每次返回新对象（就地 update 不污染调用方 before 快照）
      const row = rows.find((t) => t.id === id);
      return row ? { ...row } : null;
    },
    async findTenantByCode(code) {
      const row = rows.find((t) => t.code === code);
      return row ? { ...row } : null;
    },
    async createTenant(input) {
      const view = makeView({ id: '99', code: input.code, name: input.name, isolation: input.isolation, plan: input.plan ?? null, status: 1 });
      rows.push(view);
      return view;
    },
    async updateTenant(id, patch) {
      const row = rows.find((t) => t.id === id);
      if (!row) throw new BizError(1002, '租户不存在');
      // 与真实存储同语义：本假件没有 status 写分支（状态写权在状态机，见下方 createLifecycle）
      Object.assign(row, patch);
      return { ...row };
    },
    async setTenantIsolation(id, isolation, dbUrl) {
      if (id === LEGACY_TENANT_ID) throw new BizError(1004, '存量单租户（legacy）不可迁移隔离级别');
      const row = rows.find((t) => t.id === id);
      if (!row) throw new BizError(1002, '租户不存在');
      row.isolation = isolation;
      row.dedicatedDbConfigured = Boolean(dbUrl);
      return { ...row };
    },
    async countTenantUsers() {
      return 3;
    },
  };
  return { store, rows };
}

/**
 * 真实状态机 + 内存 LifecycleStore（与控制器共享同一 rows）：
 * 用**真的** TenantLifecycleService 校验「停用=freeze / 启用=resume|activate」的路由与非法迁移的 4030，
 * 而不是在假件里重写一遍迁移表。
 */
function createLifecycle(rows: TenantView[]): TenantLifecycleService {
  const currentStatus = (id: string): LifecycleStatus | null => {
    const row = rows.find((t) => t.id === id);
    return row ? (INT_TO_STATUS[row.status] ?? 'frozen') : null;
  };
  const store: LifecycleStore = {
    async findTenantStatus(id) {
      return currentStatus(id);
    },
    async conditionalUpdateStatus(id, from, to) {
      const row = rows.find((t) => t.id === id);
      if (!row) return false;
      if (currentStatus(id) !== from) return false;
      row.status = STATUS_TO_INT[to] as TenantStatus;
      return true;
    },
    async appendLifecycleLog() {
      /* 日志面不在本套用例断言范围（由 prisma-saas-store.integration.spec.ts 覆盖） */
    },
    async listLifecycleLogs() {
      return [];
    },
    async countTenantsByStatus() {
      return 0;
    },
    async listRecentLifecycleLogs() {
      return [];
    },
  };
  return new TenantLifecycleService(store);
}

/** 组装被测控制器（依赖全部用假件；任务中心与状态机用真实实现以覆盖派发与迁移契约） */
function createController(initial?: TenantView[]) {
  const { store, rows } = createFakeStore(initial);
  const lifecycle = createLifecycle(rows);
  const tenants = { invalidate: vi.fn() } as unknown as TenantService;
  const audit = { record: vi.fn() } as unknown as AuditService;
  const jobs = new JobCenterService();
  // M10 E-01：执行体注册表为真实实现（构造期登记 tenant.migrate 工厂）
  const jobRegistry = new JobRunnerRegistry();
  // 手动构造：构造器参数装饰器不参与直接实例化，按位置传假件即可
  const controller = new TenantAdminController(store, tenants, jobs, audit, jobRegistry, lifecycle);
  const request = { headers: { 'x-forwarded-for': '10.0.0.9, 10.0.0.1' }, ip: '127.0.0.1' } as unknown as Request;
  return { controller, store, rows, tenants, audit, jobs, lifecycle, request };
}

describe('TenantAdminController', () => {
  describe('GET /tenants 列表', () => {
    it('分页默认值与关键字透传到存储层', async () => {
      const { controller, store } = createController();
      const spy = vi.spyOn(store, 'pageTenants');
      await controller.list('2', '50', 'acme', undefined, undefined, undefined);
      expect(spy).toHaveBeenCalledWith(expect.objectContaining({ page: 2, pageSize: 50, keyword: 'acme' }));
    });

    it('非法 isolation / status 一律 1001（不静默忽略）', async () => {
      const { controller } = createController();
      await expect(controller.list('1', '20', undefined, 'nope', undefined, undefined)).rejects.toMatchObject({ code: 1001 });
      await expect(controller.list('1', '20', undefined, undefined, '7', undefined)).rejects.toMatchObject({ code: 1001 });
    });

    it('未知排序字段经白名单解析为 1001（mock / 后端同语义）', async () => {
      const { controller } = createController();
      await expect(controller.list('1', '20', undefined, undefined, undefined, 'secret:asc')).rejects.toMatchObject({ code: 1001 });
      await expect(controller.list('1', '20', undefined, undefined, undefined, 'code:asc,created_at:desc')).resolves.toBeTruthy();
    });
  });

  describe('POST /tenants 开租户', () => {
    it('code / name / isolation 必填（1001）', async () => {
      const { controller } = createController();
      await expect(controller.create({}, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
      await expect(controller.create({ code: 'x' }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
      await expect(controller.create({ code: 'x', name: 'y' }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
    });

    it('成功后失效解析缓存并写审计（模块 tenant / 动作 create / IP 取首个转发地址）', async () => {
      const { controller, tenants, audit, request } = createController();
      const created = await controller.create({ code: 'newco', name: '新公司', isolation: 'shared', plan: 'basic' }, 'u-1', request);
      expect(created.code).toBe('newco');
      expect(tenants.invalidate).toHaveBeenCalledTimes(1);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        userId: 'u-1',
        module: 'tenant',
        action: 'create',
        tenantId: created.id, // 租户维度必须显式（@IgnoreTenant 无上下文本租户可回退）
        targetType: 'tenant',
        ip: '10.0.0.9',
      }));
    });
  });

  describe('PUT /tenants/:id 更新', () => {
    it('不存在 → 1002；非法 status → 1001；legacy 停用 → 1004', async () => {
      const { controller } = createController([makeView(), makeView({ id: '0', code: 'legacy', name: '存量单租户' })]);
      await expect(controller.update('404', {}, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1002 });
      await expect(controller.update('1', { status: 5 as 0 | 1 }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
      await expect(controller.update('0', { status: 0 }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1004 });
    });

    it('status=0 走 freeze：落库为规范码 3（不再直写存量码 0）', async () => {
      const { controller, rows } = createController();
      const updated = await controller.update('1', { name: '新名', status: 0 }, 'u-1', { headers: {} } as unknown as Request);
      expect(updated.status).toBe(3);
      expect(updated.name).toBe('新名');
      expect(rows.find((t) => t.id === '1')?.status).toBe(3);
    });

    it('成功时审计带 before / after 快照（after 为迁移后的真实编值）', async () => {
      const { controller, audit, request } = createController();
      await controller.update('1', { name: '新名', status: 0 }, 'u-1', request);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'update',
        tenantId: '1',
        before: expect.objectContaining({ name: 'ACME 公司', status: 1 }),
        after: expect.objectContaining({ name: '新名', status: 3 }),
      }));
    });

    it('已终止（4）不可被「启用」复活：resume 非法 → 4030，终止态原地不动', async () => {
      const { controller, rows } = createController([makeView({ id: '2', code: 'gone', status: 4 })]);
      await expect(controller.update('2', { status: 1 }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 4030 });
      expect(rows.find((t) => t.id === '2')?.status).toBe(4);
    });

    it('待开通（5）点「启用」走 activate（pending 无 resume 入口）', async () => {
      const { controller, rows } = createController([makeView({ id: '5', code: 'pnd', status: 5 })]);
      const enabled = await controller.update('5', { status: 1 }, 'u-1', { headers: {} } as unknown as Request);
      expect(enabled.status).toBe(1);
      expect(rows.find((t) => t.id === '5')?.status).toBe(1);
    });
  });

  describe('DELETE /tenants/:id 停用', () => {
    it('不存在 → 1002；legacy → 1004（控制器层拦截）', async () => {
      const { controller } = createController([makeView(), makeView({ id: '0', code: 'legacy', name: '存量单租户' })]);
      await expect(controller.disable('404', 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1002 });
      await expect(controller.disable('0', 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1004 });
    });

    it('正常停用 = freeze：落库 3，写审计并带 affectedUsers', async () => {
      const { controller, audit, rows, request } = createController();
      const disabled = await controller.disable('1', 'u-1', request);
      expect(disabled.status).toBe(3);
      expect(rows.find((t) => t.id === '1')?.status).toBe(3);
      expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({
        action: 'delete',
        tenantId: '1',
        after: expect.objectContaining({ status: 3, affectedUsers: 3 }),
      }));
    });

    it('重复停用幂等（已是冻结 → alreadyApplied，不报错）', async () => {
      const { controller, rows } = createController([makeView({ status: 3 })]);
      const disabled = await controller.disable('1', 'u-1', { headers: {} } as unknown as Request);
      expect(disabled.status).toBe(3);
      expect(rows.find((t) => t.id === '1')?.status).toBe(3);
    });

    it('已终止（4）不可停用：freeze 非法 → 4030（旧实现会把终止态覆盖成 0）', async () => {
      const { controller, rows } = createController([makeView({ status: 4 })]);
      await expect(controller.disable('1', 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 4030 });
      expect(rows.find((t) => t.id === '1')?.status).toBe(4);
    });
  });

  describe('POST /tenants/:id/migrate 迁移', () => {
    it('目标级别必填且受限；不存在 → 1002；同级别 → 1004；dedicated 必须带 dbUrl', async () => {
      const { controller } = createController([makeView(), makeView({ id: '3', code: 'dedicated', name: '独立库租户', isolation: 'dedicated', dedicatedDbConfigured: true })]);
      await expect(controller.migrate('1', {}, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
      await expect(controller.migrate('1', { isolation: 'weird' as 'shared' }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
      await expect(controller.migrate('404', { isolation: 'shared' }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1002 });
      await expect(controller.migrate('1', { isolation: 'shared' }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1004 });
      await expect(controller.migrate('1', { isolation: 'dedicated' }, 'u-1', { headers: {} } as unknown as Request)).rejects.toMatchObject({ code: 1001 });
    });

    it('legacy 不可迁移（存储层 1004 上抛）', async () => {
      const { controller } = createController([makeView({ id: '0', code: 'legacy', name: '存量单租户' })]);
      await expect(controller.migrate('0', { isolation: 'dedicated', dbUrl: 'postgresql://x' }, 'u-1', { headers: {} } as unknown as Request))
        .rejects.toMatchObject({ code: 1004 });
    });

    it('合法迁移：派发任务返回 JobView（pending + jobId），执行体完成控制面切换', async () => {
      const { controller, jobs, audit, request } = createController();
      const job = (await controller.migrate('1', { isolation: 'dedicated', dbUrl: 'postgresql://u:p@h:5432/acme' }, 'u-1', request)) as {
        id: string;
        type: string;
        status: string;
      };
      expect(job.type).toBe('tenant.migrate');
      expect(job.status).toBe('pending');
      expect(job.id).toMatch(/^job-/);

      // 等后台执行体跑完（控制面切换 + 审计 + 缓存失效都在 runner 内）
      const deadline = Date.now() + 2000;
      let view = jobs.get(job.id, 'u-1');
      while (view && view.status !== 'succeeded' && view.status !== 'failed' && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
        view = jobs.get(job.id, 'u-1');
      }
      expect(view?.status).toBe('succeeded');
      expect(view?.progress).toBe(100);
      // 隔离级别迁移属租户级事实：审计必须带目标租户维度，否则平台按租户查不到
      expect(audit.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'update', tenantId: '1', targetId: '1', targetType: 'tenant' }),
      );
    });
  });
});
