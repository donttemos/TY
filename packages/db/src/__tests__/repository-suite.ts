/*
 * @file Repository 通用测试套件（三库矩阵复用）
 * @description 把 PRD-002 的功能用例（CRUD / 软删 / 分页 / 游标 / 事务 / upsert）抽为与驱动无关的
 *   注册函数，供 sqlite 集成测试与 MySQL/PostgreSQL 矩阵测试复用同一份断言。
 *   意义：T-M2-07「三库一致性」的证明方式就是**同一套用例**在三个驱动上全部通过，
 *   切换数据库只改 datasource 两行，业务代码（PrismaRepository）diff = 0。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/db
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { PrismaRepository } from '../prisma-repository.js';
import type { BaseEntity } from '../repository.interface.js';
import type { PrismaClientLike } from '../types.js';

/** 与测试 schema 对齐的实体 */
export interface TestUserEntity extends BaseEntity {
  email: string;
  name: string;
}

/** 测试中直接使用的委托子集（三库生成的 client 结构完全一致） */
export interface MatrixTestClient {
  testUser: {
    deleteMany(args?: unknown): Promise<unknown>;
    create(args: { data: Record<string, unknown> }): Promise<TestUserEntity>;
    createMany(args: { data: Array<Record<string, unknown>> }): Promise<unknown>;
    findUnique(args: { where: { id: string } }): Promise<(TestUserEntity & { deletedAt?: Date | null }) | null>;
  };
  $disconnect(): Promise<void>;
}

/** 套件注册参数 */
export interface RepositorySuiteOptions {
  /** 驱动标签，出现在用例标题里（sqlite / mysql / postgresql） */
  label: string;
  /** 取已连接的客户端（beforeAll 里创建，故用访问器而非直接传值） */
  getClient: () => MatrixTestClient;
}

/**
 * 注册仓库契约用例（与驱动无关，三库共用同一份断言）
 * @param options 驱动标签 + 客户端访问器
 */
export function defineRepositorySuite(options: RepositorySuiteOptions): void {
  const { label, getClient } = options;
  const tag = `@fw/db[${label}]`;

  const repo = (): PrismaRepository<TestUserEntity> =>
    new PrismaRepository<TestUserEntity>(getClient() as unknown as PrismaClientLike, 'testUser');

  /** 造数：n 条用户（批量插入 —— 远端 MySQL/PG 逐条建连会拖垮默认用例超时） */
  const seedUsers = async (n: number): Promise<void> => {
    await getClient().testUser.createMany({
      data: Array.from({ length: n }, (_, i) => ({ email: `u${i}@test.local`, name: `用户${i}` })),
    });
  };

  /** 每个用例前清表，保证用例间隔离（工程规范：禁止顺序依赖） */
  beforeEach(async () => {
    await getClient().testUser.deleteMany();
  });

  describe(`${tag} · CRUD 与软删（TC-ORM-001/004）`, () => {
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
      const raw = await getClient().testUser.findUnique({ where: { id: created.id } });
      expect(raw?.deletedAt).toBeInstanceOf(Date);
      // 物理删
      await r.hardDelete(created.id);
      expect(await getClient().testUser.findUnique({ where: { id: created.id } })).toBeNull();
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

  describe(`${tag} · 分页（TC-ORM-002）`, () => {
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
      await getClient().testUser.createMany({
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

  describe(`${tag} · 事务（TC-ORM-003）`, () => {
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

  describe(`${tag} · upsert（FR-05 方言公共子集）`, () => {
    it('同键二次调用走 update 分支', async () => {
      const r = repo();
      const first = await r.upsert({ email: 'up@test.local' }, { email: 'up@test.local', name: '初' }, { name: '改' });
      expect(first.name).toBe('初');
      const second = await r.upsert({ email: 'up@test.local' }, { email: 'up@test.local', name: '不应' }, { name: '改' });
      expect(second.name).toBe('改');
      expect(await r.count()).toBe(1);
    });
  });
}
