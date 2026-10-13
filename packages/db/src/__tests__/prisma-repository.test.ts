/*
 * @file PrismaRepository 逻辑单测（fake delegate，不依赖真实数据库）
 * @description 覆盖软删过滤、审计字段填充、排序 tie-breaker、分页计算、游标 hasMore、
 *   upsert 审计、jsonContains 方言分支（TC-ORM-001/002/004 的适配逻辑部分）
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PrismaRepository } from '../prisma-repository.js';
import type { BaseEntity, PageQuery } from '../repository.interface.js';
import type { ModelDelegate, PrismaClientLike } from '../types.js';

/** 测试实体：与 prisma/test-schema.prisma 的 TestUser 对齐 */
interface TestUser extends BaseEntity {
  email: string;
  name: string;
}

/** 记录调用的 fake delegate */
function makeDelegate(rows: Record<string, unknown>[] = []) {
  const calls: { method: string; args: unknown }[] = [];
  const delegate: ModelDelegate = {
    findUnique: vi.fn(async (args: unknown) => {
      calls.push({ method: 'findUnique', args });
      return rows[0] ?? null;
    }),
    findFirst: vi.fn(async (args: unknown) => {
      calls.push({ method: 'findFirst', args });
      return rows[0] ?? null;
    }),
    findMany: vi.fn(async (args: unknown) => {
      calls.push({ method: 'findMany', args });
      return rows;
    }),
    create: vi.fn(async (args: unknown) => {
      calls.push({ method: 'create', args });
      return { id: 'new-1', ...(args as { data: object }).data };
    }),
    update: vi.fn(async (args: unknown) => {
      calls.push({ method: 'update', args });
      return { id: (args as { where: { id: string } }).where.id, ...(args as { data: object }).data };
    }),
    updateMany: vi.fn(async () => ({ count: 1 })),
    delete: vi.fn(async (args: unknown) => {
      calls.push({ method: 'delete', args });
      return { id: (args as { where: { id: string } }).where.id };
    }),
    deleteMany: vi.fn(async () => ({ count: 1 })),
    upsert: vi.fn(async (args: unknown) => {
      calls.push({ method: 'upsert', args });
      return { id: 'up-1', ...(args as { create: object }).create };
    }),
    count: vi.fn(async (args: unknown) => {
      calls.push({ method: 'count', args });
      return 128; // 固定总数供分页断言
    }),
  };
  return { delegate, calls };
}

function makeRepo(rows: Record<string, unknown>[] = []) {
  const { delegate, calls } = makeDelegate(rows);
  const client = {
    testUser: delegate,
    $transaction: vi.fn(async (fn: (tx: Record<string, ModelDelegate>) => Promise<unknown>) => fn({ testUser: delegate })),
    $queryRaw: vi.fn(async () => []),
    $connect: vi.fn(async () => undefined),
    $disconnect: vi.fn(async () => undefined),
    $on: vi.fn(),
    $extends: vi.fn(function (this: unknown) { return this; }),
  } as unknown as PrismaClientLike;
  const repo = new PrismaRepository<TestUser>(client, 'testUser');
  return { repo, calls, client };
}

describe('@fw/db · 查询强制软删过滤（TC-ORM-004）', () => {
  it('findById 追加 deletedAt IS NULL', async () => {
    const { repo, calls } = makeRepo();
    await repo.findById('u-1');
    expect(calls[0].args).toMatchObject({ where: { id: 'u-1', deletedAt: null } });
  });

  it('findOne 合并调用方 where 与软删条件', async () => {
    const { repo, calls } = makeRepo();
    await repo.findOne({ email: 'a@b.c' });
    expect(calls[0].args).toMatchObject({ where: { email: 'a@b.c', deletedAt: null } });
  });

  it('count 同样过滤软删', async () => {
    const { repo, calls } = makeRepo();
    await repo.count();
    expect(calls[0].args).toMatchObject({ where: { deletedAt: null } });
  });
});

describe('@fw/db · 排序 tie-breaker（TC-ORM-002）', () => {
  it('未传 sort 时按 id 升序', async () => {
    const { repo, calls } = makeRepo();
    await repo.list();
    expect(calls[0].args).toMatchObject({ orderBy: [{ id: 'asc' }] });
  });

  it('多字段排序后追加 id asc', async () => {
    const { repo, calls } = makeRepo();
    await repo.list(undefined, { createdAt: 'desc' });
    expect(calls[0].args).toMatchObject({ orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] });
  });
});

describe('@fw/db · 分页计算（TC-ORM-002）', () => {
  const query: PageQuery<TestUser> = { page: 3, pageSize: 20 };

  it('第 3 页：skip=40、take=20、total=128、hasMore=true', async () => {
    const { repo, calls } = makeRepo([{ id: 'x' }]);
    const result = await repo.page(query);
    expect(calls.find((c) => c.method === 'findMany')?.args).toMatchObject({ skip: 40, take: 20 });
    expect(result.total).toBe(128);
    expect(result.page).toBe(3);
    expect(result.pageSize).toBe(20);
    expect(result.hasMore).toBe(true);
  });

  it('末页 hasMore=false', async () => {
    const { repo } = makeRepo();
    // 128 条 / pageSize 50 → 第 3 页为末页（100..128）
    const result = await repo.page({ page: 3, pageSize: 50 });
    expect(result.hasMore).toBe(false);
  });

  it('pageSize 超上限截断为 100', async () => {
    const { repo, calls } = makeRepo();
    await repo.page({ page: 1, pageSize: 500 });
    expect(calls.find((c) => c.method === 'findMany')?.args).toMatchObject({ take: 100 });
  });

  it('页码小于 1 归一到 1', async () => {
    const { repo, calls } = makeRepo();
    await repo.page({ page: 0, pageSize: 20 });
    expect(calls.find((c) => c.method === 'findMany')?.args).toMatchObject({ skip: 0 });
  });
});

describe('@fw/db · 游标分页', () => {
  it('带 cursor 时按 id gt 过滤并多取一条探 hasMore', async () => {
    const rows = Array.from({ length: 3 }, (_, i) => ({ id: `u-${i}` }));
    const { repo, calls } = makeRepo(rows);
    const result = await repo.pageByCursor({ pageSize: 2, cursor: 'u-0' });
    expect(calls[0].args).toMatchObject({ where: { deletedAt: null, id: { gt: 'u-0' } }, take: 3 });
    expect(result.items).toHaveLength(2);
    expect(result.hasMore).toBe(true);
  });

  it('结果不足一页时 hasMore=false', async () => {
    const { repo } = makeRepo([{ id: 'u-9' }]);
    const result = await repo.pageByCursor({ pageSize: 5 });
    expect(result.items).toHaveLength(1);
    expect(result.hasMore).toBe(false);
  });
});

describe('@fw/db · 写操作审计字段（FR-03）', () => {
  it('create 自动填 createdBy/updatedBy（无上下文时 system）', async () => {
    const { repo, calls } = makeRepo();
    await repo.create({ email: 'a@b.c', name: 'A' });
    expect(calls[0].args).toMatchObject({
      data: { email: 'a@b.c', name: 'A', createdBy: 'system', updatedBy: 'system' },
    });
  });

  it('update 局部更新 + updatedBy', async () => {
    const { repo, calls } = makeRepo();
    await repo.update('u-1', { name: 'B' });
    expect(calls[0].args).toMatchObject({ where: { id: 'u-1' }, data: { name: 'B', updatedBy: 'system' } });
  });

  it('softDelete 置 deletedAt 而非物理删除', async () => {
    const { repo, calls } = makeRepo();
    await repo.softDelete('u-1');
    expect(calls[0].method).toBe('update');
    expect((calls[0].args as { data: { deletedAt: Date } }).data.deletedAt).toBeInstanceOf(Date);
  });

  it('hardDelete 才走物理删除', async () => {
    const { repo, calls } = makeRepo();
    await repo.hardDelete('u-1');
    expect(calls[0].method).toBe('delete');
  });

  it('upsert 的 create/update 均带审计字段', async () => {
    const { repo, calls } = makeRepo();
    await repo.upsert({ email: 'a@b.c' }, { email: 'a@b.c', name: 'A' }, { name: 'A2' });
    expect(calls[0].args).toMatchObject({
      create: { email: 'a@b.c', name: 'A', createdBy: 'system', updatedBy: 'system' },
      update: { name: 'A2', updatedBy: 'system' },
    });
  });
});

describe('@fw/db · 方言差异适配（FR-05）', () => {
  it('sqlite 驱动 jsonContains 明确抛错（白名单外能力不静默失败）', async () => {
    const { repo } = makeRepo();
    await expect(repo.jsonContains('sqlite', 'tags', { a: 1 })).rejects.toThrow(/SQLite/);
  });

  it('非法 SQL 标识符被拒绝（防注入）', async () => {
    const { repo } = makeRepo();
    await expect(repo.jsonContains('postgresql', 'tags; DROP TABLE x', { a: 1 })).rejects.toThrow(/非法 SQL 标识符/);
  });

  it('postgresql 驱动走 @> 参数化查询', async () => {
    const { repo, client } = makeRepo();
    await repo.jsonContains('postgresql', 'tags', { role: 'admin' });
    expect(client.$queryRaw).toHaveBeenCalledOnce();
    // tagged template：mock.calls[0] = [strings, ...插值]，插值含表名/字段名/参数化值
    const call = (client.$queryRaw as unknown as { mock: { calls: unknown[][] } }).mock.calls[0];
    expect(call).toContain('testUser');
    expect(call).toContain('tags');
    expect(call).toContain(JSON.stringify({ role: 'admin' }));
  });
});

describe('@fw/db · 事务（TC-ORM-003）', () => {
  it('withTransaction 内操作走 tx 委托，退出后恢复原委托', async () => {
    const { repo, calls } = makeRepo();
    await repo.withTransaction(async () => {
      await repo.findById('u-1');
    });
    expect(calls).toHaveLength(1);
    // 退出后再次操作仍可用（delegate 已恢复）
    await repo.findById('u-2');
    expect(calls).toHaveLength(2);
  });

  it('fn 抛错时事务整体回滚（client.$transaction 语义）', async () => {
    const { repo, client } = makeRepo();
    await expect(
      repo.withTransaction(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(client.$transaction).toHaveBeenCalledOnce();
  });

  it('指定隔离级别时透传 Prisma 枚举', async () => {
    const { repo, client } = makeRepo();
    await repo.withTransaction(async () => undefined, 'serializable');
    expect((client.$transaction as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][1]).toEqual({
      isolationLevel: 'Serializable',
    });
  });
});
