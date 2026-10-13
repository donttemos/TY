/*
 * @file PrismaRepository 集成测试（真实 SQLite）
 * @description 用 prisma/test-client 对真实数据库执行：CRUD、软删、分页、事务回滚、
 *   upsert（TC-ORM-001/002/003/004）。三库一致性由 CI 矩阵（T-M2-07）在 MySQL/PG 上复跑同一用例。
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo 迁移准备改异步 execFile：同步 spawn 在受限宿主（沙箱/部分 CI）返回 EBUSY
 * @module @fw/db
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '../../prisma/test-client/index.js';
import { PrismaRepository } from '../prisma-repository.js';
import type { BaseEntity } from '../repository.interface.js';
import type { PrismaClientLike } from '../types.js';

const execFileAsync = promisify(execFile);

/** 与 schema 对齐的实体 */
interface TestUser extends BaseEntity {
  email: string;
  name: string;
}

/** 测试库路径（独立文件，避免与开发库交叉） */
const DB_FILE = path.join(process.cwd(), 'prisma', 'test-int.db');
const DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;

let prisma: PrismaClient;

/** 带重试的迁移应用：Windows 下 pnpm exec + prisma 偶发文件锁竞态（CI 防抖） */
async function migrateDeployWithRetry(): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      // Windows 下 pnpm.cmd 需经 shell 执行；异步执行避免同步 spawn 在受限宿主返回 EBUSY
      await execFileAsync('pnpm exec prisma migrate deploy --schema prisma/test-schema.prisma', {
        cwd: process.cwd(),
        shell: true,
        env: { ...process.env, TEST_DATABASE_URL: DB_URL },
      });
      return;
    } catch (error) {
      lastError = error;
      // 退避 200ms 后重试
      await new Promise((resolve) => setTimeout(resolve, 200));
    }
  }
  throw lastError;
}

beforeAll(async () => {
  // 保证表结构最新（幂等）
  fs.rmSync(DB_FILE, { force: true });
  await migrateDeployWithRetry();
  prisma = new PrismaClient({ datasources: { db: { url: DB_URL } } });
});

afterAll(async () => {
  await prisma.$disconnect();
  fs.rmSync(DB_FILE, { force: true });
});

/** 每个用例前清表，保证用例间隔离（工程规范：禁止顺序依赖） */
beforeEach(async () => {
  await prisma.testUser.deleteMany();
});

function repo(): PrismaRepository<TestUser> {
  return new PrismaRepository<TestUser>(prisma as unknown as PrismaClientLike, 'testUser');
}

/** 造数：n 条用户 */
async function seedUsers(n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    await prisma.testUser.create({ data: { email: `u${i}@test.local`, name: `用户${i}` } });
  }
}

describe('@fw/db · CRUD 与软删（TC-ORM-001/004）', () => {
  it('create 返回含审计字段的完整实体', async () => {
    const r = repo();
    const created = await r.create({ email: 'a@test.local', name: '甲' });
    expect(created.id).toBeTruthy();
    expect(created.createdBy).toBe('system');
    expect(created.updatedBy).toBe('system');
    expect(created.deletedAt).toBeNull();
    expect(created.createdAt).toBeInstanceOf(Date);
  });

  it('findById 命中/未命中', async () => {
    const r = repo();
    const created = await r.create({ email: 'b@test.local', name: '乙' });
    expect((await r.findById(created.id))?.name).toBe('乙');
    expect(await r.findById('不存在')).toBeNull();
  });

  it('softDelete 后默认查询不可见，硬删才物理消失', async () => {
    const r = repo();
    const created = await r.create({ email: 'c@test.local', name: '丙' });
    await r.softDelete(created.id);
    expect(await r.findById(created.id)).toBeNull();
    expect(await r.count()).toBe(0);
    // 绕过 Repository 直接查库：软删数据仍在（deletedAt 有值）
    const raw = await prisma.testUser.findUnique({ where: { id: created.id } });
    expect(raw?.deletedAt).toBeInstanceOf(Date);
    // 物理删
    await r.hardDelete(created.id);
    expect(await prisma.testUser.findUnique({ where: { id: created.id } })).toBeNull();
  });

  it('update 局部更新并刷新 updatedAt/updatedBy', async () => {
    const r = repo();
    const created = await r.create({ email: 'd@test.local', name: '丁' });
    await new Promise((res) => setTimeout(res, 10));
    const updated = await r.update(created.id, { name: '丁改' });
    expect(updated.name).toBe('丁改');
    expect(updated.updatedAt.getTime()).toBeGreaterThan(created.updatedAt.getTime());
  });
});

describe('@fw/db · 分页（TC-ORM-002）', () => {
  it('128 条取第 3 页：20 条、total=128、无跨页重复/遗漏', async () => {
    await seedUsers(128);
    const r = repo();
    const page3 = await r.page({ page: 3, pageSize: 20 });
    expect(page3.items).toHaveLength(20);
    expect(page3.total).toBe(128);
    expect(page3.hasMore).toBe(true);

    // 翻完 7 页收集全部 id：应恰好 128 个不重复
    const seen = new Set<string>();
    for (let p = 1; p <= 7; p++) {
      const res = await r.page({ page: p, pageSize: 20 });
      res.items.forEach((u) => seen.add(String(u.id)));
    }
    expect(seen.size).toBe(128);
  });

  it('排序稳定性：同 createdAt 记录按 id tie-breaker 分页不抖', async () => {
    // 同一毫秒内批量创建（createdAt 相同概率高），验证 id 兜底
    await prisma.testUser.createMany({
      data: Array.from({ length: 30 }, (_, i) => ({ email: `s${i}@test.local`, name: `排${i}` })),
    });
    const r = repo();
    const p1 = (await r.page({ page: 1, pageSize: 10 })).items.map((u) => u.id);
    const p2 = (await r.page({ page: 2, pageSize: 10 })).items.map((u) => u.id);
    expect(p1.filter((id) => p2.includes(id))).toHaveLength(0);
  });

  it('游标分页：翻到底且与页码模式总量一致', async () => {
    await seedUsers(25);
    const r = repo();
    const seen: string[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 20; guard++) {
      const res = await r.pageByCursor({ pageSize: 10, cursor });
      seen.push(...res.items.map((u) => String(u.id)));
      if (!res.hasMore) break;
      cursor = String(res.items[res.items.length - 1].id);
    }
    expect(seen).toHaveLength(25);
    expect(new Set(seen).size).toBe(25);
  });
});

describe('@fw/db · 事务（TC-ORM-003）', () => {
  it('fn 抛错整体回滚', async () => {
    const r = repo();
    await expect(
      r.withTransaction(async () => {
        await r.create({ email: 'tx@test.local', name: '事务' });
        throw new Error('主动回滚');
      }),
    ).rejects.toThrow('主动回滚');
    expect(await r.count()).toBe(0);
  });

  it('fn 正常提交', async () => {
    const r = repo();
    await r.withTransaction(async () => {
      await r.create({ email: 'tx2@test.local', name: '事务2' });
    });
    expect(await r.count()).toBe(1);
  });

  it('事务内软删对外不可见（提交前）', async () => {
    const r = repo();
    const created = await r.create({ email: 'tx3@test.local', name: '事务3' });
    await r.withTransaction(async () => {
      await r.softDelete(created.id);
      // 事务内查：同一连接看到已软删
      expect(await r.findById(created.id)).toBeNull();
    });
    // 提交后持久
    expect(await r.findById(created.id)).toBeNull();
  });
});

describe('@fw/db · upsert（FR-05 方言公共子集）', () => {
  it('同键二次调用走 update 分支', async () => {
    const r = repo();
    const first = await r.upsert({ email: 'up@test.local' }, { email: 'up@test.local', name: '初' }, { name: '改' });
    expect(first.name).toBe('初');
    const second = await r.upsert({ email: 'up@test.local' }, { email: 'up@test.local', name: '不应' }, { name: '改' });
    expect(second.name).toBe('改');
    expect(await r.count()).toBe(1);
  });
});
