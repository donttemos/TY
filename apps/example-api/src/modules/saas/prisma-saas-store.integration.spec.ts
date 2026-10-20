/*
 * @file 集成测试：SaaS 存储端口的 Prisma 驱动（M13）
 * @description 用 example-api 主 schema（SQLite，含 M13 十表迁移）对真实 PrismaClient 验证
 *   ADR-0030/0031 的并发与幂等不变量：consumeAtomic 事件回滚语义（exceeded 不留痕）、
 *   并发扣减零超发（N 线程逼近限额，成功数恰为余量，AC-13-04）、幂等键去重不重复计量、
 *   软限额同窗幂等告警、active_marker 唯一（1003）、生命周期条件更新幂等。
 *   本地模式：全新临时 SQLite 按序执行全量迁移 DDL（不与 migrate deploy 部分应用态混跑）；
 *   CI 矩阵（SAAS_TEST_DB_URL）直连 service DB，迁移由 CI 步骤以对应方言预先 deploy。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-19 donttemo 本地建库改为全量 DDL 直建（deploy 部分应用混合态依赖断裂）
 * @module example-api/saas
 */

/**
 * 全量迁移 DDL 直建（本地临时库专用）：按目录序执行全部迁移 SQL。语句级忽略
 * already exists / duplicate column（防御性；全新库不应触发）。仅 sqlite 方言——
 * mysql/pg 走 CI 矩阵的 service DB（SAAS_TEST_DB_URL + CI 步骤 deploy）。
 */
async function applyAllMigrationsDdl(): Promise<void> {
  const migrationsDir = path.join(process.cwd(), 'prisma', 'migrations');
  const dirs = fs.readdirSync(migrationsDir).filter((d) => /^\d+_/.test(d)).sort();
  const client = new PrismaClient({ datasources: { db: { url: LOCAL_DB_URL } } });
  try {
    for (const dir of dirs) {
      const sql = fs.readFileSync(path.join(migrationsDir, dir, 'migration.sql'), 'utf8');
      // 分号切分 + 逐行剥注释行（Prisma 迁移 SQL 的注释行与语句同段——整段以 -- 开头
      // 不能整段丢弃，否则 CREATE TABLE 会被吞掉、后续索引报 no such table）
      const stmts = sql
        .split(';')
        .map((seg) => seg.split('\n').filter((line) => !line.trim().startsWith('--')).join('\n').trim())
        .filter((seg) => seg.length > 0);
      for (const stmt of stmts) {
        try {
          // @sql('sqlite') 迁移 DDL 直建（迁移文件本身即 sqlite 方言）
          await client.$executeRawUnsafe(stmt);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes('already exists') || msg.includes('duplicate column')) continue;
          throw e;
        }
      }
    }
  } finally {
    await client.$disconnect();
  }
}

/*
 * @file 集成测试：SaaS 存储端口的 Prisma 驱动（M13）
 * @description 用 example-api 主 schema（SQLite，含 M13 十表迁移）对真实 PrismaClient 验证
 *   ADR-0030/0031 的并发与幂等不变量：consumeAtomic 事件回滚语义（exceeded 不留痕）、
 *   并发扣减零超发（N 线程逼近限额，成功数恰为余量）、幂等键去重不重复计量、
 *   软限额同窗幂等告警、active_marker 唯一（1003）、生命周期条件更新幂等。
 *   运行模式与 refresh-rotation 集成同款：本地自建独立临时 SQLite + migrate deploy；
 *   CI 矩阵设 SAAS_TEST_DB_URL 直连 service DB（迁移由 CI 步骤预先 deploy）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-21 donttemo P1（PRD-015 FR-15-10 收口）：补 findTenantName 真实库断言
 * @module example-api/saas
 */

import 'reflect-metadata';
import { describe, beforeAll, afterAll, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import type { PrismaClientLike } from '@fw/db';
import { PrismaSaasStore } from './prisma-saas-store.js';
import { QuotaExceededError, TenantLifecycleService, type TenantQuotaOverride } from '@fw/saas';

const execFileAsync = promisify(execFile);

const EXTERNAL_DB_URL = process.env.SAAS_TEST_DB_URL ?? '';
const DB_FILE = path.join(process.cwd(), 'prisma', 'test-saas.db');
const LOCAL_DB_URL = `file:${DB_FILE.replace(/\\/g, '/')}`;
const TARGET_DB_URL = EXTERNAL_DB_URL || LOCAL_DB_URL;

let prisma: PrismaClient | null = null;
let store: PrismaSaasStore | null = null;
let lifecycle: TenantLifecycleService | null = null;

/** 造一套完整领域数据：套餐 v1（api_calls 日窗 hard / storage_gb 总窗 soft）+ 两个租户订阅 */
async function seedDomain(): Promise<void> {
  await prisma.plan.create({ data: { id: 'plan-1', code: 'default', name: '基础版' } });
  await prisma.planVersion.create({ data: { id: 'pv-1', planId: 'plan-1', version: 1, status: 'published', publishedAt: new Date() } });
  await prisma.quotaDefinition.createMany({
    data: [
      { key: 'api_calls', name: 'API 调用数', unit: 'count', windowType: 'day', execution: 'hard' },
      { key: 'storage_gb', name: '存储', unit: 'gb', windowType: 'total', execution: 'soft' },
    ],
  });
  await prisma.planQuota.createMany({
    data: [
      { planVersionId: 'pv-1', quotaKey: 'api_calls', limitValue: 12n, execution: 'hard' },
      { planVersionId: 'pv-1', quotaKey: 'storage_gb', limitValue: 5n, execution: 'soft' },
    ],
  });
  await prisma.tenantSubscription.create({ data: { tenantId: 't1', planId: 'plan-1', planVersionId: 'pv-1', activeMarker: 't1' } });
  await prisma.tenantSubscription.create({ data: { tenantId: 't2', planId: 'plan-1', planVersionId: 'pv-1', activeMarker: 't2' } });
  await prisma.tenantQuota.createMany({
    data: [
      { tenantId: 't1', quotaKey: 'api_calls', overrideValue: 12n, execution: 'hard', source: 'plan_snapshot' },
      { tenantId: 't2', quotaKey: 'api_calls', overrideValue: 12n, execution: 'hard', source: 'plan_snapshot' },
      { tenantId: 't1', quotaKey: 'storage_gb', overrideValue: 5n, execution: 'soft', source: 'plan_snapshot' },
      { tenantId: 't2', quotaKey: 'storage_gb', overrideValue: 5n, execution: 'soft', source: 'plan_snapshot' },
    ],
  });
  await prisma.tenant.createMany({
    data: [
      { id: 't1', code: 't1', name: '租户一', status: 1 },
      { id: 't2', code: 't2', name: '租户二', status: 1 },
    ],
  });
}

beforeAll(async () => {
  if (!EXTERNAL_DB_URL) {
    // 本地模式：全新空库直接按序执行全量迁移 DDL——不与 migrate deploy 的「部分应用」
    // 混合续跑（受限环境 deploy 可能中途静默停止，混合态会出现 no such table 依赖断裂）。
    // 一次性测试库无需 _prisma_migrations 登记；CI 矩阵（SAAS_TEST_DB_URL）仍由 deploy 负责。
    fs.rmSync(DB_FILE, { force: true });
    fs.closeSync(fs.openSync(DB_FILE, 'w'));
    await applyAllMigrationsDdl();
  }
  prisma = new PrismaClient({ datasources: { db: { url: TARGET_DB_URL } } });
  await prisma.$connect();
  store = new PrismaSaasStore(prisma);
  lifecycle = new TenantLifecycleService(store);
  await seedDomain();
}, 60_000);

afterAll(async () => {
  await prisma?.$disconnect();
  if (!EXTERNAL_DB_URL) fs.rmSync(DB_FILE, { force: true });
});

describe('PrismaSaasStore.consumeAtomic（ADR-0030 不变量）', () => {
  const at = new Date(Date.UTC(2026, 9, 19, 12, 0, 0));

  it('额度内 ok + 重复幂等键 deduped 不重复计量', async () => {
    const r1 = await store.consumeAtomic({ tenantId: 't1', quotaKey: 'api_calls', quantity: 5n, occurredAt: at, source: 'api', idempotencyKey: 'it:e1' }, 12n, 'hard');
    expect(r1).toMatchObject({ result: 'ok', used: 5n, limit: 12n });
    const dup = await store.consumeAtomic({ tenantId: 't1', quotaKey: 'api_calls', quantity: 5n, occurredAt: at, source: 'api', idempotencyKey: 'it:e1' }, 12n, 'hard');
    expect(dup).toEqual({ result: 'deduped' });
    const win = await store.findWindow('t1', 'api_calls', 'day', new Date(Date.UTC(2026, 9, 19)));
    expect(win?.used).toBe(5n); // 重复投递未扣减
    expect(await prisma.usageEvent.count({ where: { idempotencyKey: 'it:e1' } })).toBe(1);
  });

  it('超限 exceeded：事件一并回滚（不留痕不扣减，AC-13-04 前置语义）', async () => {
    const r = await store.consumeAtomic({ tenantId: 't1', quotaKey: 'api_calls', quantity: 10n, occurredAt: at, source: 'api', idempotencyKey: 'it:e2' }, 12n, 'hard');
    expect(r).toMatchObject({ result: 'exceeded', used: 5n, limit: 12n });
    expect(await prisma.usageEvent.count({ where: { idempotencyKey: 'it:e2' } })).toBe(0);
    const win = await store.findWindow('t1', 'api_calls', 'day', new Date(Date.UTC(2026, 9, 19)));
    expect(win?.used).toBe(5n);
  });

  it('并发逼近硬限额：12 线程扣 limit=12，成功恰 12 次、零超发（AC-13-04）', async () => {
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, i) =>
        store.consumeAtomic({ tenantId: 't2', quotaKey: 'api_calls', quantity: 1n, occurredAt: at, source: 'api', idempotencyKey: `race:${i}` }, 12n, 'hard'),
      ),
    );
    const ok = results.filter((r) => r.result === 'ok');
    const exceeded = results.filter((r) => r.result === 'exceeded');
    expect(ok).toHaveLength(12);
    expect(exceeded).toHaveLength(0);
    const win = await store.findWindow('t2', 'api_calls', 'day', new Date(Date.UTC(2026, 9, 19)));
    expect(win?.used).toBe(12n);
    // 第 13 次：必 exceeded，且事件不存在
    const r13 = await store.consumeAtomic({ tenantId: 't2', quotaKey: 'api_calls', quantity: 1n, occurredAt: at, source: 'api', idempotencyKey: 'race:13' }, 12n, 'hard');
    expect(r13).toMatchObject({ result: 'exceeded', used: 12n });
    expect(await prisma.usageEvent.count({ where: { idempotencyKey: 'race:13' } })).toBe(0);
    expect(await prisma.usageEvent.count({ where: { tenantId: 't2', quotaKey: 'api_calls' } })).toBe(12);
  });

  it('软限额：markWarned 同窗幂等（第二次返回 false）', async () => {
    // 先消费一次建窗口行（total 窗口），再验证告警标记幂等
    const r = await store.consumeAtomic({ tenantId: 't1', quotaKey: 'storage_gb', quantity: 1n, occurredAt: at, source: 'api', idempotencyKey: 'it:soft1' }, 5n, 'soft');
    expect(r.result).toBe('ok');
    const epoch = new Date(0); // total 窗口起点
    expect(await store.markWarned('t1', 'storage_gb', 'total', epoch, at)).toBe(true);
    expect(await store.markWarned('t1', 'storage_gb', 'total', epoch, at)).toBe(false);
  });

  it('observe：仅留痕不建窗口行', async () => {
    await prisma.quotaDefinition.create({ data: { key: 'audit_rows', name: '审计导出', unit: 'count', windowType: 'day', execution: 'observe' } });
    await prisma.planQuota.create({ data: { planVersionId: 'pv-1', quotaKey: 'audit_rows', limitValue: 1n, execution: 'observe' } });
    const r = await store.consumeAtomic({ tenantId: 't1', quotaKey: 'audit_rows', quantity: 100n, occurredAt: at, source: 'api', idempotencyKey: 'it:obs1' }, 1n, 'observe');
    expect(r.result).toBe('ok');
    expect(await store.findWindow('t1', 'audit_rows', 'day', new Date(Date.UTC(2026, 9, 19)))).toBeNull();
    expect(await prisma.usageEvent.count({ where: { idempotencyKey: 'it:obs1' } })).toBe(1);
  });
});

describe('PrismaSaasStore 订阅与生命周期（ADR-0029/0031 不变量）', () => {
  it('active_marker 唯一：重复创建生效订阅 → 1003', async () => {
    await expect(
      store.createSubscriptionWithSnapshot({ tenantId: 't1', planId: 'plan-1', planVersionId: 'pv-1', effectiveAt: new Date(), activeMarker: 't1' }, []),
    ).rejects.toMatchObject({ code: 1003 });
  });

  it('closeSubscription 置 activeMarker=NULL 后可重新创建', async () => {
    const sub = await store.createSubscriptionWithSnapshot({ tenantId: 't9', planId: 'plan-1', planVersionId: 'pv-1', effectiveAt: new Date(), activeMarker: 't9' }, []);
    await store.closeSubscription(sub.id, { status: 'cancelled', closedAt: new Date(), reason: '测试' });
    await expect(
      store.createSubscriptionWithSnapshot({ tenantId: 't9', planId: 'plan-1', planVersionId: 'pv-1', effectiveAt: new Date(), activeMarker: 't9' }, []),
    ).resolves.toMatchObject({ tenantId: 't9', status: 'active' });
  });

  it('conditionalUpdateStatus：条件更新幂等 + 生命周期服务全链（日志逐条）', async () => {
    // tenants.status Int = 1（active）
    expect(await store.findTenantStatus('t1')).toBe('active');
    const r1 = await lifecycle.transition('t1', 'freeze', { actorType: 'system', reason: '到期' });
    expect(r1).toMatchObject({ from: 'active', to: 'frozen', alreadyApplied: false });
    // 重复 freeze：幂等 alreadyApplied，不重复记日志
    const r2 = await lifecycle.transition('t1', 'freeze', { actorType: 'system' });
    expect(r2.alreadyApplied).toBe(true);
    expect(await store.listLifecycleLogs('t1')).toHaveLength(1);
    // 状态写库：Int=3（frozen）
    expect((await prisma.tenant.findUnique({ where: { id: 't1' } }))?.status).toBe(3);
    // resume 回 active
    await lifecycle.transition('t1', 'resume', { actorType: 'user', reason: '恢复' });
    expect(await store.findTenantStatus('t1')).toBe('active');
    // 迁移历史 2 条
    expect((await store.listLifecycleLogs('t1')).map((l) => l.action)).toEqual(['freeze', 'resume']);
  });

  it('findTenantName：租户名快照查询（PRD-015 FR-15-10，审计 target_label 的数据源）', async () => {
    expect(await store!.findTenantName('t1')).toBe('租户一');
    expect(await store!.findTenantName('t2')).toBe('租户二');
    expect(await store!.findTenantName('no-such-tenant')).toBeNull(); // 端口契约：null 仅表示租户不存在
  });

  it('QuotaExceededError 契约：4029/429 + details 三字段', () => {
    const e = new QuotaExceededError('api_calls', 12n, 12n);
    expect(e.code).toBe(4029);
    expect(e.http).toBe(429);
    expect(e.details).toEqual([
      { field: 'metricKey', message: 'api_calls' },
      { field: 'used', message: '12' },
      { field: 'limit', message: '12' },
    ]);
  });
});

/*
 * 订阅开通原子性（ADR-0029 §2.5）：真实库上验证「订阅行 + 全部配额快照行」同成同败。
 * 故障注入不靠 mock：用 Prisma query extension 包住 tenantQuota.upsert，在第 n 次调用抛错——
 * 这正是旧实现（先 createSubscription、再逐条 upsertTenantQuota 两次独立写）留下半成品的时点。
 */
describe('PrismaSaasStore 订阅开通原子性（ADR-0029 §2.5，真实事务 + 故障注入）', () => {
  const SUB = {
    tenantId: 'atom1',
    planId: 'plan-1',
    planVersionId: 'pv-1',
    effectiveAt: new Date(Date.UTC(2026, 9, 20, 10, 0, 0)),
    expireAt: null,
    activeMarker: 'atom1',
  };
  const QUOTAS: TenantQuotaOverride[] = [
    { tenantId: 'atom1', quotaKey: 'api_calls', overrideValue: 10n, execution: 'hard', source: 'plan_snapshot' },
    { tenantId: 'atom1', quotaKey: 'storage_gb', overrideValue: 2n, execution: 'soft', source: 'plan_snapshot' },
    { tenantId: 'atom1', quotaKey: 'audit_rows', overrideValue: 100n, execution: 'observe', source: 'plan_snapshot' },
  ];

  /** fault.at = 第几次 tenantQuota.upsert 抛错（null=关闭）；reset() 归零计数器（重试场景） */
  function faultyStore(fault: { at: number | null }): { store: PrismaSaasStore; reset: () => void } {
    let writes = 0;
    const extended = prisma!.$extends({
      query: {
        tenantQuota: {
          async upsert({ args, query }) {
            writes += 1;
            if (fault.at !== null && writes === fault.at) {
              throw new Error('FAULT_INJECTED：配额快照写入失败'); // fw-allow-raw-throw: ②类测试信号——故障注入点，仅测试使用
            }
            return query(args);
          },
        },
      },
    });
    return { store: new PrismaSaasStore(extended as unknown as PrismaClientLike), reset: () => { writes = 0; } };
  }

  it('快照第 2 条失败 → 订阅行与已写的第 1 条一并回滚（无半成品订阅）', async () => {
    const fault = { at: 2 as number | null };
    const { store: faulty } = faultyStore(fault);
    await expect(faulty.createSubscriptionWithSnapshot(SUB, QUOTAS)).rejects.toThrow(/FAULT_INJECTED/);

    // ① 订阅行不存在 ② active_marker 不残留（否则该租户重试恒 1003）③ 任何快照行都未落库
    expect(await prisma!.tenantSubscription.count({ where: { tenantId: 'atom1' } })).toBe(0);
    expect(await prisma!.tenantSubscription.count({ where: { activeMarker: 'atom1' } })).toBe(0);
    expect(await prisma!.tenantQuota.count({ where: { tenantId: 'atom1' } })).toBe(0);
  });

  it('故障消除后同参数重试：一次写全 3 条快照，常规驱动可读回同一订阅', async () => {
    const fault = { at: 1 as number | null };
    const { store: faulty, reset } = faultyStore(fault);
    await expect(faulty.createSubscriptionWithSnapshot(SUB, QUOTAS)).rejects.toThrow(/FAULT_INJECTED/);
    expect(await prisma!.tenantQuota.count({ where: { tenantId: 'atom1' } })).toBe(0); // 首条也回滚

    fault.at = null;
    reset();
    const sub = await faulty.createSubscriptionWithSnapshot(SUB, QUOTAS);
    expect(sub.status).toBe('active');
    expect(await prisma!.tenantQuota.count({ where: { tenantId: 'atom1' } })).toBe(3);
    expect((await store!.findActiveSubscription('atom1'))?.id).toBe(sub.id);

    // 清理，避免污染后续 describe 的列表/计数断言
    await prisma!.tenantQuota.deleteMany({ where: { tenantId: 'atom1' } });
    await prisma!.tenantSubscription.deleteMany({ where: { tenantId: 'atom1' } });
  });
});

describe('PrismaSaasStore 订阅列表查询（M14/PRD-014 FR-14-07 端口语义）', () => {
  it('过滤/分页/排序与 tie-breaker（effectiveAt desc + id asc）+ 租户历史', async () => {
    const t1sub = await store!.findActiveSubscription('t1');
    const t2sub = await store!.findActiveSubscription('t2');
    expect(t1sub).toBeTruthy();
    expect(t2sub).toBeTruthy();
    // 确定性排序：用相对时间保证 t2 是全表最晚（其他 describe 建的订阅至多 now）
    const base = new Date();
    await prisma!.tenantSubscription.update({ where: { id: t1sub!.id }, data: { effectiveAt: base, expireAt: new Date(base.getTime() + 10 * 86_400_000) } });
    await prisma!.tenantSubscription.update({ where: { id: t2sub!.id }, data: { effectiveAt: new Date(base.getTime() + 86_400_000) } });

    const all = await store!.listSubscriptions({}, { page: 1, pageSize: 50 });
    expect(all.total).toBeGreaterThanOrEqual(2);
    expect(all.items[0].id).toBe(t2sub!.id); // effectiveAt desc（全表最晚）

    const page1 = await store!.listSubscriptions({}, { page: 1, pageSize: 1 });
    const page2 = await store!.listSubscriptions({}, { page: 2, pageSize: 1 });
    expect(page1.items).toHaveLength(1);
    expect(page1.items[0].id).not.toBe(page2.items[0].id);

    expect((await store!.listSubscriptions({ tenantId: 't1' }, { page: 1, pageSize: 10 })).total).toBe(1);

    // 到期范围命中 t1（base+10d）；其余订阅 expireAt 为 null 不命中（与 Fake 实现同语义）
    const inRange = await store!.listSubscriptions(
      { expireFrom: new Date(base.getTime() + 9 * 86_400_000), expireTo: new Date(base.getTime() + 11 * 86_400_000) },
      { page: 1, pageSize: 50 },
    );
    expect(inRange.items.map((s) => s.id)).toEqual([t1sub!.id]);

    // 状态过滤 + 租户历史（关闭 t2 订阅）
    await store!.closeSubscription(t2sub!.id, { status: 'cancelled', reason: '测试', closedAt: new Date() });
    const cancelled = await store!.listSubscriptions({ status: 'cancelled' }, { page: 1, pageSize: 50 });
    expect(cancelled.items.map((s) => s.id)).toContain(t2sub!.id); // 此前 describe 亦有 cancelled 行，断言包含
    const history = await store!.listSubscriptionsByTenant('t2');
    expect(history.map((s) => s.id)).toEqual([t2sub!.id]);
  });
});

/*
 * 五态 Int 编码的真实库回归（ADR-0029 §2.4，P0 修正）。
 * 全部用例在真实 SQLite（全量迁移 DDL 直建）上跑，不用 Fake——编码缺陷只会在驱动层暴露：
 * 旧实现「读 0 → frozen、写 pending → 0、frozen 条件更新按 3 匹配」，使存量停用租户
 * 永远 resume/terminate 不了（4030 死锁），并把存量停用误计为 pending。
 */
describe('PrismaSaasStore 五态 Int 编码（0 = 存量停用 → frozen，pending 独占 5）', () => {
  it('status = 0 直读为 frozen，且不计入 pending 计数', async () => {
    const frozenBefore = await store!.countTenantsByStatus('frozen');
    const pendingBefore = await store!.countTenantsByStatus('pending');
    await prisma!.tenant.create({ data: { id: 'lg-disabled', code: 'lg-disabled', name: '存量停用租户', status: 0 } });

    // 0 是存量停用（M8 语义：管理端停用与历史数据都写 0），按 frozen 读
    expect(await store!.findTenantStatus('lg-disabled')).toBe('frozen');
    // 存量 0 属冻结：frozen 计数 +1；pending 计数不得变化（旧实现把 0 当 pending 记）
    expect(await store!.countTenantsByStatus('frozen')).toBe(frozenBefore + 1);
    expect(await store!.countTenantsByStatus('pending')).toBe(pendingBefore);
  });

  it('存量 0 可经 resume 迁移为 active（条件更新须匹配 0，否则 4030 死锁）', async () => {
    await prisma!.tenant.create({ data: { id: 'lg-resume', code: 'lg-resume', name: '存量停用待恢复', status: 0 } });
    // 旧实现：读 0 得 frozen → 条件更新按 status=3 匹配不到 → 重读仍 frozen ≠ active → 4030
    await expect(lifecycle!.transition('lg-resume', 'resume', { actorType: 'user', reason: '存量恢复' })).resolves.toEqual({
      from: 'frozen',
      to: 'active',
      alreadyApplied: false,
    });
    // 写码恒为规范值：库里由存量 0 归一为 1
    expect((await prisma!.tenant.findUnique({ where: { id: 'lg-resume' } }))?.status).toBe(1);
    const logs = await store!.listLifecycleLogs('lg-resume');
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({ fromStatus: 'frozen', toStatus: 'active', action: 'resume', reason: '存量恢复' });
  });

  it('存量 0 在布尔拦截口径下仍按冻结拒绝（4031），不因 0/3 双码漏拦', async () => {
    await prisma!.tenant.create({ data: { id: 'lg-blocked', code: 'lg-blocked', name: '存量停用待拦截', status: 0 } });
    expect(await store!.findTenantStatus('lg-blocked')).toBe('frozen');
    await expect(lifecycle!.assertNotSuspended('lg-blocked')).rejects.toMatchObject({ code: 4031 });
  });

  it('pending 读写一致：落库 5 → 读回 pending，且 pending → active 可开通', async () => {
    const pendingBefore = await store!.countTenantsByStatus('pending');
    // 模拟开通流程落库的待开通租户（旧实现该态写 0，读回即 frozen，此后 activate 恒 4030）
    await prisma!.tenant.create({ data: { id: 'pd-new', code: 'pd-new', name: '待开通租户', status: 5 } });

    expect(await store!.findTenantStatus('pd-new')).toBe('pending');
    expect(await store!.countTenantsByStatus('pending')).toBe(pendingBefore + 1);

    await expect(lifecycle!.transition('pd-new', 'activate', { actorType: 'user' })).resolves.toEqual({
      from: 'pending',
      to: 'active',
      alreadyApplied: false,
    });
    expect((await prisma!.tenant.findUnique({ where: { id: 'pd-new' } }))?.status).toBe(1);
  });

  it('写路径只产生规范码：全链迁移落库值依次为 2/3/1/4，永不写存量码 0', async () => {
    await prisma!.tenant.create({ data: { id: 'chain', code: 'chain', name: '全链租户', status: 1 } });
    const steps = [
      ['expire', 2], // active → grace
      ['freeze', 3], // grace  → frozen
      ['resume', 1], // frozen → active
      ['terminate', 4], // active → terminated
    ] as const;
    for (const [action, expected] of steps) {
      await lifecycle!.transition('chain', action, { actorType: 'system' });
      const row = await prisma!.tenant.findUnique({ where: { id: 'chain' } });
      expect(row?.status).toBe(expected);
      // 关键不变量：领域写路径绝不产生 0（0 只作为存量读码存在）
      expect(row?.status).not.toBe(0);
    }
  });

  it('未知编码 fail-closed 按 frozen 兜底（null 仅表示租户不存在），并可经 terminate 归一', async () => {
    const frozenBefore = await store!.countTenantsByStatus('frozen');
    await prisma!.tenant.create({ data: { id: 'dirty', code: 'dirty', name: '脏编码租户', status: 9 } });

    // 脏值不得被读成 null（旧实现 → 生命周期服务误报 404 租户不存在）
    expect(await store!.findTenantStatus('dirty')).toBe('frozen');
    expect(await store!.findTenantStatus('no-such-tenant')).toBeNull();
    // 计数与直读同口径
    expect(await store!.countTenantsByStatus('frozen')).toBe(frozenBefore + 1);

    await expect(lifecycle!.transition('dirty', 'terminate', { actorType: 'user' })).resolves.toEqual({
      from: 'frozen',
      to: 'terminated',
      alreadyApplied: false,
    });
    expect((await prisma!.tenant.findUnique({ where: { id: 'dirty' } }))?.status).toBe(4);
  });
});

describe('PrismaSaasStore 运营看板端口（M14/PRD-014 FR-14-12/14）', () => {
  it('listWindows（day 当前窗口）/ countTenantsByStatus / listRecentLifecycleLogs', async () => {
    // t1 产生 day 窗口行（limit=12，消耗 6）
    await store!.consumeAtomic(
      { tenantId: 't1', quotaKey: 'api_calls', quantity: 6n, occurredAt: new Date(), source: 'test', idempotencyKey: 'ov-int-1' },
      12n,
      'hard',
    );
    const dayStart = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    const wins = await store!.listWindows('day', dayStart);
    expect(wins.some((w) => w.tenantId === 't1' && w.used === 6n && w.limitValue === 12n)).toBe(true);

    // 五态计数（seedDomain：t2 保持 Int=1 → active；前序 describe 改过 t1/t9，故用相对断言）
    expect(await store!.countTenantsByStatus('active')).toBeGreaterThanOrEqual(1);

    // 最近迁移：跨租户 desc + take（t2 冻结 → frozen 计数 +1）
    await lifecycle!.transition('t2', 'freeze', { actorType: 'system', reason: '看板测试' });
    expect(await store!.countTenantsByStatus('frozen')).toBeGreaterThanOrEqual(1);
    const recent = await store!.listRecentLifecycleLogs(5);
    expect(recent.length).toBeGreaterThanOrEqual(1);
    expect(recent[0].action).toBe('freeze');
    for (let i = 1; i < recent.length; i++) expect(recent[i].at.getTime()).toBeLessThanOrEqual(recent[i - 1].at.getTime());
  });
});
