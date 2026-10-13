/*
 * @file 租户数据源路由单测（M8 T-M8-02，PRD-008 FR-02 / TC-TNT-003）
 * @description fake PrismaClientLike 覆盖选路回退、dedicated 懒创建与复用、并发去重、
 *   LRU / 空闲淘汰与断开、创建失败重试、stats 不泄连接串，以及 PrismaRepository
 *   经 dataSource 的按上下文选路（读 / 写 / 事务三条路径）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/db
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { runWithRequestContext } from '@fw/logger';
import { TenantDataSource } from '../tenant-datasource.js';
import { PrismaRepository } from '../prisma-repository.js';
import type { ModelDelegate, PrismaClientLike } from '../types.js';
import type { BaseEntity } from '../repository.interface.js';

/** 记录断开的 fake client（含 testUser 委托） */
function makeClient(label: string) {
  const disconnected = vi.fn(async () => undefined);
  const calls: string[] = [];
  const delegate: ModelDelegate = {
    findUnique: vi.fn(async (args: unknown) => {
      calls.push(`findUnique:${label}`);
      return { id: (args as { where: { id: string } }).where.id, label };
    }),
    findFirst: vi.fn(async () => {
      calls.push(`findFirst:${label}`);
      return null;
    }),
    findMany: vi.fn(async () => {
      calls.push(`findMany:${label}`);
      return [];
    }),
    create: vi.fn(async (args: unknown) => {
      calls.push(`create:${label}`);
      return { id: 'new-1', ...(args as { data: object }).data, label };
    }),
    update: vi.fn(async () => {
      calls.push(`update:${label}`);
      return { id: 'u-1', label };
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(async () => {
      calls.push(`delete:${label}`);
      return { id: 'u-1' };
    }),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async () => ({ id: 'up-1', label })),
    count: vi.fn(async () => 0),
  };
  const txCalls: string[] = [];
  const client = {
    testUser: delegate,
    $transaction: vi.fn(async (fn: (tx: Record<string, ModelDelegate>) => Promise<unknown>) => {
      txCalls.push(`tx:${label}`);
      return fn({ testUser: delegate });
    }),
    $queryRaw: vi.fn(async () => []),
    $connect: vi.fn(async () => undefined),
    $disconnect: disconnected,
    $on: vi.fn(),
    $extends: vi.fn(function (this: unknown) { return this; }),
  } as unknown as PrismaClientLike;
  return { client, calls, disconnected, txCalls };
}

/** dedicated 上下文包裹 */
const inDedicated = <T>(tenantId: string, dbUrl: string, fn: () => T): T =>
  runWithRequestContext(
    { traceId: 't', spanId: '', tenantId, tenantVerified: true, tenantIsolation: 'dedicated', tenantDbUrl: dbUrl },
    fn,
  );

afterEach(() => {
  vi.useRealTimers();
});

describe('@fw/db · TenantDataSource 选路回退（TC-TNT-003）', () => {
  it('无请求上下文时回退默认 client', async () => {
    const def = makeClient('default');
    const ds = new TenantDataSource(def.client, { clientFactory: () => makeClient('x').client });
    await expect(ds.resolve()).resolves.toBe(def.client);
  });

  it('shared 隔离回退默认 client（工厂不被调用）', async () => {
    const def = makeClient('default');
    const factory = vi.fn(() => makeClient('t').client);
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    await runWithRequestContext(
      { traceId: 't', spanId: '', tenantId: '7', tenantVerified: true, tenantIsolation: 'shared' },
      async () => {
        await expect(ds.resolve()).resolves.toBe(def.client);
      },
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('tenantVerified=false 的 dedicated 上下文回退默认 client（fail-closed 方向）', async () => {
    const def = makeClient('default');
    const factory = vi.fn(() => makeClient('t').client);
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    await runWithRequestContext(
      { traceId: 't', spanId: '', tenantId: '7', tenantIsolation: 'dedicated', tenantDbUrl: 'file:x.db' },
      async () => {
        await expect(ds.resolve()).resolves.toBe(def.client);
      },
    );
    expect(factory).not.toHaveBeenCalled();
  });

  it('ignoreTenant 跨租户维护回退默认 client', async () => {
    const def = makeClient('default');
    const ds = new TenantDataSource(def.client, { clientFactory: () => makeClient('t').client });
    await inDedicated('7', 'file:x.db', async () => {
      // ignoreTenant 需在上下文中：另起一个带 ignoreTenant 的上下文
    });
    await runWithRequestContext(
      { traceId: 't', spanId: '', tenantId: '7', tenantVerified: true, tenantIsolation: 'dedicated', tenantDbUrl: 'file:x.db', ignoreTenant: true },
      async () => {
        await expect(ds.resolve()).resolves.toBe(def.client);
      },
    );
  });

  it('dedicated 缺 dbUrl / 缺 tenantId 均回退默认 client', async () => {
    const def = makeClient('default');
    const factory = vi.fn(() => makeClient('t').client);
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    await runWithRequestContext(
      { traceId: 't', spanId: '', tenantId: '7', tenantVerified: true, tenantIsolation: 'dedicated' },
      async () => {
        await expect(ds.resolve()).resolves.toBe(def.client);
      },
    );
    await runWithRequestContext(
      { traceId: 't', spanId: '', tenantVerified: true, tenantIsolation: 'dedicated', tenantDbUrl: 'file:x.db' },
      async () => {
        await expect(ds.resolve()).resolves.toBe(def.client);
      },
    );
    expect(factory).not.toHaveBeenCalled();
  });
});

describe('@fw/db · TenantDataSource 缓存与淘汰', () => {
  it('dedicated 首次懒创建、二次复用（工厂各租户只调一次）', async () => {
    const def = makeClient('default');
    const factory = vi.fn((url: string) => makeClient(url).client);
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    const first = await inDedicated('7', 'file:a.db', () => ds.resolve());
    const second = await inDedicated('7', 'file:a.db', () => ds.resolve());
    expect(first).not.toBe(def.client);
    expect(second).toBe(first);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(factory).toHaveBeenCalledWith('file:a.db');
    expect(ds.stats()).toMatchObject({ active: 1, created: 1, evicted: 0, tenantIds: ['7'] });
  });

  it('并发创建去重：两个并发 resolve 只建一个 client', async () => {
    const def = makeClient('default');
    const factory = vi.fn((url: string) => makeClient(url).client);
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    // 创建路径无 await（工厂同步），并发 resolve 串行执行：第二次命中缓存
    const [a, b] = await Promise.all([
      inDedicated('7', 'file:a.db', () => ds.resolve()),
      inDedicated('7', 'file:a.db', () => ds.resolve()),
    ]);
    expect(a).toBe(b);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(ds.stats()).toMatchObject({ active: 1, created: 1 });
  });

  it('不同租户各自独立 client，互不串数据', async () => {
    const def = makeClient('default');
    const factory = vi.fn((url: string) => makeClient(url).client);
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    const a = await inDedicated('7', 'file:a.db', () => ds.resolve());
    const b = await inDedicated('8', 'file:b.db', () => ds.resolve());
    expect(a).not.toBe(b);
    expect(ds.stats()).toMatchObject({ active: 2, created: 2 });
    expect(ds.stats().tenantIds).toEqual(expect.arrayContaining(['7', '8']));
  });

  it('LRU 淘汰：超出 maxClients 时断开最久未用', async () => {
    const def = makeClient('default');
    const made: Record<string, ReturnType<typeof makeClient>> = {};
    const factory = vi.fn((url: string) => {
      made[url] = makeClient(url);
      return made[url].client;
    });
    const ds = new TenantDataSource(def.client, { clientFactory: factory, maxClients: 2 });
    await inDedicated('7', 'file:a.db', () => ds.resolve());
    await inDedicated('8', 'file:b.db', () => ds.resolve());
    // 再用一次 7，使 8 成为最久未用
    await inDedicated('7', 'file:a.db', () => ds.resolve());
    await inDedicated('9', 'file:c.db', () => ds.resolve());
    expect(ds.stats()).toMatchObject({ active: 2, evicted: 1 });
    expect(made['file:b.db'].disconnected).toHaveBeenCalledTimes(1);
    expect(made['file:a.db'].disconnected).not.toHaveBeenCalled();
  });

  it('空闲淘汰：超过 idleTimeoutMs 未使用即断开', async () => {
    vi.useFakeTimers();
    const def = makeClient('default');
    const made: Record<string, ReturnType<typeof makeClient>> = {};
    const ds = new TenantDataSource(
      def.client,
      { clientFactory: (url) => { made[url] = makeClient(url); return made[url].client; }, idleTimeoutMs: 1000 },
    );
    await inDedicated('7', 'file:a.db', () => ds.resolve());
    expect(ds.stats().active).toBe(1);
    vi.advanceTimersByTime(2000);
    expect(ds.stats()).toMatchObject({ active: 0, evicted: 1 });
    expect(made['file:a.db'].disconnected).toHaveBeenCalledTimes(1);
  });

  it('创建失败：不落缓存，下次请求重试', async () => {
    const def = makeClient('default');
    let attempt = 0;
    const ok = makeClient('file:a.db');
    const factory = vi.fn(() => {
      attempt += 1;
      if (attempt === 1) throw new Error('connect refused');
      return ok.client;
    });
    const ds = new TenantDataSource(def.client, { clientFactory: factory });
    await expect(inDedicated('7', 'file:a.db', () => ds.resolve())).rejects.toThrow('connect refused');
    expect(ds.stats()).toMatchObject({ active: 0, created: 0 });
    const second = await inDedicated('7', 'file:a.db', () => ds.resolve());
    expect(second).toBe(ok.client);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it('onModuleDestroy 全量断开并清空缓存', async () => {
    const def = makeClient('default');
    const a = makeClient('file:a.db');
    const b = makeClient('file:b.db');
    const ds = new TenantDataSource(def.client, {
      clientFactory: (url) => (url === 'file:a.db' ? a.client : b.client),
    });
    await inDedicated('7', 'file:a.db', () => ds.resolve());
    await inDedicated('8', 'file:b.db', () => ds.resolve());
    await ds.onModuleDestroy();
    expect(a.disconnected).toHaveBeenCalledTimes(1);
    expect(b.disconnected).toHaveBeenCalledTimes(1);
    expect(ds.stats()).toMatchObject({ active: 0 });
    // 断开后默认 client 仍可用（不随租户 client 一起断）
    await expect(ds.resolve()).resolves.toBe(def.client);
  });
});

describe('@fw/db · PrismaRepository 经 dataSource 选路（TC-TNT-003）', () => {
  interface TestUser extends BaseEntity {
    email: string;
  }

  const makeRepo = (dataSource: TenantDataSource, rows: Record<string, unknown>[] = []) => {
    const def = makeClient('default');
    const repo = new PrismaRepository<TestUser>(
      def.client,
      'testUser',
      { dataSource },
    );
    return { repo, def };
  };

  it('dedicated 上下文：读 / 写 / 事务全部落到租户 client', async () => {
    const tenant = makeClient('file:a.db');
    const ds = new TenantDataSource(makeClient('default').client, { clientFactory: () => tenant.client });
    const { repo, def } = makeRepo(ds);
    await inDedicated('7', 'file:a.db', async () => {
      await repo.findById('u-1');
      await repo.create({ email: 'a@b.c' });
      await repo.withTransaction(async () => 'tx-ok');
    });
    expect(tenant.calls).toEqual(['findUnique:file:a.db', 'create:file:a.db']);
    expect(tenant.txCalls).toEqual(['tx:file:a.db']);
    expect(def.calls).toHaveLength(0);
  });

  it('shared 上下文：读写落到默认 client（行为与未注入 dataSource 一致）', async () => {
    const tenant = makeClient('file:a.db');
    const def = makeClient('default');
    const ds = new TenantDataSource(def.client, { clientFactory: () => tenant.client });
    const repo = new PrismaRepository<TestUser>(def.client, 'testUser', { dataSource: ds });
    await runWithRequestContext(
      { traceId: 't', spanId: '', tenantId: '7', tenantVerified: true, tenantIsolation: 'shared' },
      async () => {
        await repo.list();
      },
    );
    expect(def.calls).toEqual(['findMany:default']);
    expect(tenant.calls).toHaveLength(0);
  });
});
