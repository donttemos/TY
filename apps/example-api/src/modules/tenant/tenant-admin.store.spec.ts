/*
 * @file 单测：租户管理存储（N-01）
 * @description 以内存假 PrismaClient 驱动**真实**的 PrismaTenantAdminStore，验证存储端口契约：
 *   编码格式 / dedicated 必填连接串 / shared 拒收连接串 / 编码唯一（1003 而非 500）、
 *   legacy 停用与迁移一律拒绝、停用不写 deletedAt（解析仍能命中给 4001）、
 *   主键取「现有最大数字 ID + 1」（与 users.tenant_id 的 bigint 语义对齐）。
 *   控制器层语义（端点权限 / 审计 / 派发）见 tenant-admin.controller.spec.ts。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/tenant
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import { BizError } from '@fw/core';
import { PrismaTenantAdminStore, LEGACY_TENANT_ID } from './tenant-admin.store.js';
import { decryptDbUrl } from './db-url-crypto.js';

/** 内存中的租户行（Prisma 生成类型的本地投影） */
interface FakeTenantRow {
  id: string;
  code: string;
  name: string;
  isolation: string;
  dbUrlEnc: string | null;
  plan: string | null;
  status: number;
  expireAt: Date | null;
  deletedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  createdBy: string;
  updatedBy: string;
}

/** where 匹配器：支持等值 / OR 数组 / contains（pageTenants 的关键字检索） */
function matches(row: FakeTenantRow, where: Record<string, unknown>): boolean {
  return Object.entries(where).every(([key, expected]) => {
    if (key === 'OR' && Array.isArray(expected)) {
      return expected.some((clause) => matches(row, clause as Record<string, unknown>));
    }
    const actual = (row as unknown as Record<string, unknown>)[key];
    if (expected !== null && typeof expected === 'object' && 'contains' in (expected as object)) {
      return String(actual).includes(String((expected as { contains: string }).contains));
    }
    return actual === expected;
  });
}

/** 构建内存假 PrismaClient（tenant + user 两个模型） */
function createFakeClient(seed: FakeTenantRow[], userCount = 0) {
  const rows: FakeTenantRow[] = seed.map((row) => ({ ...row }));
  let autoId = 0;
  const tenant = {
    async findUnique({ where }: { where: { id: string } }) {
      return rows.find((row) => row.id === where.id && row.deletedAt === null) ?? null;
    },
    async findFirst({ where }: { where: Record<string, unknown> }) {
      return rows.find((row) => matches(row, { deletedAt: null, ...where })) ?? null;
    },
    async findMany({ where, orderBy, skip = 0, take }: { where?: Record<string, unknown>; orderBy?: Record<string, string>[]; skip?: number; take?: number }) {
      const filtered = rows.filter((row) => matches(row, { deletedAt: null, ...(where ?? {}) }));
      const ordered = [...filtered].sort((a, b) => {
        for (const clause of orderBy ?? []) {
          const [field, direction] = Object.entries(clause)[0] as [string, string];
          const left = (a as unknown as Record<string, unknown>)[field];
          const right = (b as unknown as Record<string, unknown>)[field];
          if (left === right) continue;
          const diff = String(left) < String(right) ? -1 : 1;
          return direction === 'desc' ? -diff : diff;
        }
        return 0;
      });
      return typeof take === 'number' ? ordered.slice(skip, skip + take) : ordered.slice(skip);
    },
    async count({ where }: { where?: Record<string, unknown> }) {
      return rows.filter((row) => matches(row, { deletedAt: null, ...(where ?? {}) })).length;
    },
    async create({ data }: { data: Partial<FakeTenantRow> }) {
      autoId += 1;
      const now = new Date();
      const row: FakeTenantRow = {
        deletedAt: null,
        createdBy: 'system',
        updatedBy: 'system',
        ...data,
        id: (data.id as string) ?? `fake-${autoId}`,
        createdAt: now,
        updatedAt: now,
      } as FakeTenantRow;
      rows.push(row);
      return { ...row };
    },
    async update({ where, data }: { where: { id: string }; data: Partial<FakeTenantRow> }) {
      const row = rows.find((item) => item.id === where.id && item.deletedAt === null);
      if (!row) throw new Error('记录不存在');
      Object.assign(row, data, { updatedAt: new Date() });
      return { ...row };
    },
  };
  const user = {
    async count() {
      return userCount;
    },
  };
  return { client: { tenant, user } as never, rows };
}

/** 构造一行租户（同 seedTenants 的字段口径） */
function makeRow(overrides: Partial<FakeTenantRow>): FakeTenantRow {
  return {
    id: '0',
    code: 'legacy',
    name: '存量单租户',
    isolation: 'shared',
    dbUrlEnc: null,
    plan: null,
    status: 1,
    expireAt: null,
    deletedAt: null,
    createdAt: new Date('2026-10-13T00:00:00.000Z'),
    updatedAt: new Date('2026-10-13T00:00:00.000Z'),
    createdBy: 'system',
    updatedBy: 'system',
    ...overrides,
  };
}

/** 四行基线（与 seed 同构：legacy / acme / off / dedicated） */
function seedRows(): FakeTenantRow[] {
  return [
    makeRow({ id: '0', code: 'legacy', name: '存量单租户' }),
    makeRow({ id: '1', code: 'acme', name: 'ACME 公司', plan: 'pro' }),
    makeRow({ id: '2', code: 'off', name: '已停用租户', status: 0 }),
    makeRow({ id: '3', code: 'dedicated', name: '独立库租户', isolation: 'dedicated', dbUrlEnc: 'v1.enc' }),
  ];
}

describe('PrismaTenantAdminStore', () => {
  it('分页列表：关键字命中 code / name，非法排序在解析层被拒（调用方负责）', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);

    const all = await store.pageTenants({ page: 1, pageSize: 20 });
    expect(all.total).toBe(4);
    expect(all.items.map((t) => t.code)).toEqual(['legacy', 'acme', 'off', 'dedicated']);

    const byKeyword = await store.pageTenants({ page: 1, pageSize: 20, keyword: 'ACME' });
    expect(byKeyword.total).toBe(1);
    expect(byKeyword.items[0]?.code).toBe('acme');

    const byIsolation = await store.pageTenants({ page: 1, pageSize: 20, isolation: 'dedicated' });
    expect(byIsolation.total).toBe(1);
    expect(byIsolation.items[0]?.dedicatedDbConfigured).toBe(true);
  });

  it('视图绝不外泄连接串：dedicated 只回布尔位', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);
    const view = await store.findTenantViewById('3');
    expect(view?.dedicatedDbConfigured).toBe(true);
    expect(JSON.stringify(view)).not.toContain('v1.enc');
    expect(view).not.toHaveProperty('dbUrlEnc');
  });

  it('开租户：主键取最大数字 ID + 1，dedicated 落密文（可解密回原文）', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);

    const created = await store.createTenant({
      code: 'newco',
      name: '新公司',
      isolation: 'dedicated',
      dbUrl: 'postgresql://u:p@localhost:5432/newco',
      plan: 'basic',
    });
    expect(created.id).toBe('4');
    expect(created.status).toBe(1);
    expect(created.dedicatedDbConfigured).toBe(true);
  });

  it('开租户校验：编码格式 / 必填 / dedicated 连接串 / shared 拒收 / 唯一性', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);
    const base = { code: 'ok-co', name: '可用', isolation: 'shared' as const };

    await expect(store.createTenant({ ...base, code: 'Bad_Code' })).rejects.toThrow(BizError);
    await expect(store.createTenant({ ...base, code: 'x'.repeat(65) })).rejects.toThrow(BizError);
    await expect(store.createTenant({ ...base, code: '' })).rejects.toThrow(BizError);
    await expect(store.createTenant({ ...base, name: '' })).rejects.toThrow(BizError);
    await expect(store.createTenant({ ...base, isolation: 'dedicated' })).rejects.toThrow('dbUrl');
    await expect(store.createTenant({ ...base, dbUrl: 'postgresql://x' })).rejects.toThrow('shared 隔离级别不接受 dbUrl');
    // 编码唯一性冲突是 1003 而不是底层唯一约束抛成的 500
    await expect(store.createTenant({ ...base, code: 'acme' })).rejects.toMatchObject({ code: 1003 });
  });

  it('停用：不写 deletedAt（解析仍能按 code 命中并给 4001），legacy 一律拒绝', async () => {
    const { client, rows } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);

    const disabled = await store.disableTenant('1');
    expect(disabled.status).toBe(0);
    expect(rows.find((row) => row.id === '1')?.deletedAt).toBeNull();
    expect(rows.find((row) => row.id === '1')?.status).toBe(0);

    await expect(store.disableTenant(LEGACY_TENANT_ID)).rejects.toMatchObject({ code: 1004 });
    await expect(store.disableTenant('999')).rejects.toMatchObject({ code: 1002 });
  });

  it('迁移：legacy 拒绝、同级别拒绝、dedicated 必须带连接串', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);

    await expect(store.setTenantIsolation(LEGACY_TENANT_ID, 'dedicated', 'postgresql://x')).rejects.toMatchObject({ code: 1004 });
    await expect(store.setTenantIsolation('1', 'shared', null)).rejects.toMatchObject({ code: 1004 }); // 已是 shared
    await expect(store.setTenantIsolation('1', 'dedicated', null)).rejects.toThrow('dbUrl');

    const migrated = await store.setTenantIsolation('1', 'dedicated', 'postgresql://u:p@h:5432/acme');
    expect(migrated.isolation).toBe('dedicated');
    expect(migrated.dedicatedDbConfigured).toBe(true);
  });

  it('更新：非法 status 400；legacy 停用由控制器层拦截（存储层只守不删）', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);
    await expect(store.updateTenant('1', { status: 2 as 0 | 1 })).rejects.toMatchObject({ code: 1001 });
    const updated = await store.updateTenant('1', { name: 'ACME 新名', plan: null, status: 0 });
    expect(updated.name).toBe('ACME 新名');
    expect(updated.plan).toBeNull();
    expect(updated.status).toBe(0);
  });

  it('账号规模统计走 user.count（停用 / 迁移前的提示数据源）', async () => {
    const { client } = createFakeClient(seedRows(), 7);
    const store = new PrismaTenantAdminStore(client);
    await expect(store.countTenantUsers('1')).resolves.toBe(7);
  });

  it('密文可解密自检：encryptDbUrl 产物能被 decryptDbUrl 还原', async () => {
    const { client } = createFakeClient(seedRows());
    const store = new PrismaTenantAdminStore(client);
    const created = await store.createTenant({
      code: 'crypto-co',
      name: '加解密',
      isolation: 'dedicated',
      dbUrl: 'postgresql://u:p@h:5432/db',
    });
    // 经真实 store 写入的密文行可直接解密（加密与解密同密钥单例）
    const row = (client as unknown as { tenant: { findFirst: (a: unknown) => Promise<FakeTenantRow | null> } }).tenant;
    const stored = await row.findFirst({ where: { code: 'crypto-co' } });
    expect(stored?.dbUrlEnc).toContain('v1.');
    expect(decryptDbUrl(stored?.dbUrlEnc ?? '')).toBe('postgresql://u:p@h:5432/db');
    expect(created.id).toBe('4');
  });
});
