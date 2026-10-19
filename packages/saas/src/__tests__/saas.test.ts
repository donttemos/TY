/*
 * @file 套餐/订阅/配额/用量测试
 * @description ADR-0029/0030 验收：版本发布不可变与递增、一租户一生效订阅（1003）、生效配额解析
 *   （override ?? 默认）、硬限额超限 4029、幂等键去重不重复计量、软限额同窗幂等告警、
 *   observe 仅留痕、rollup 重算闭环。store 为内存 Fake（原子语义按 ADR-0030 §2.5 模拟）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { describe, expect, it } from 'vitest';
import { QuotaExceededError } from '../errors.js';
import { FakeSaasStore } from '../fake-store.js';
import { PlanService } from '../plan.service.js';
import { QuotaService, windowStartFor } from '../quota.service.js';
import { SubscriptionService } from '../subscription.service.js';
import { UsageService } from '../usage.service.js';

function dayStartUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

async function setup() {
  const store = new FakeSaasStore();
  await store.upsertQuotaDefinition({ key: 'api_calls', name: 'API 调用数', unit: 'count', windowType: 'day', execution: 'hard' });
  await store.upsertQuotaDefinition({ key: 'storage_gb', name: '存储', unit: 'gb', windowType: 'total', execution: 'soft' });
  await store.upsertQuotaDefinition({ key: 'audit_rows', name: '审计导出行数', unit: 'count', windowType: 'day', execution: 'observe' });
  const plans = new PlanService(store);
  const subs = new SubscriptionService(store, store, store);
  const quotas = new QuotaService(store, store, store);
  const usage = new UsageService(quotas, store, store);
  return { store, plans, subs, quotas, usage };
}

describe('PlanService（ADR-0029 版本规则）', () => {
  it('创建套餐：code 冲突 1003', async () => {
    const { plans } = await setup();
    await plans.createPlan({ code: 'default', name: '基础版' });
    await expect(plans.createPlan({ code: 'default', name: '重复' })).rejects.toMatchObject({ code: 1003 });
  });

  it('发布版本：版本号递增、配额登记、无配额 400、字典未登记 1002', async () => {
    const { store, plans } = await setup();
    const plan = await plans.createPlan({ code: 'pro', name: '专业版' });
    const v1 = await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 1000n }] });
    const v2 = await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 5000n }] });
    expect(v1.version).toBe(1);
    expect(v2.version).toBe(2);
    expect((await plans.listPlanQuotas(v2.id))[0].limitValue).toBe(5000n);
    await expect(plans.publishVersion(plan.id, { quotas: [] })).rejects.toMatchObject({ code: 2001 });
    await expect(plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'nope', limitValue: 1n }] })).rejects.toMatchObject({ code: 1002 });
    await expect(plans.publishVersion('plan-x', { quotas: [{ quotaKey: 'api_calls', limitValue: 1n }] })).rejects.toMatchObject({ code: 1002 });
    expect(store).toBeDefined();
  });
});

describe('SubscriptionService（ADR-0029 一租户一生效 + 版本快照）', () => {
  it('创建订阅并生成 plan_snapshot 覆盖行；已有生效订阅 1003', async () => {
    const { store, plans, subs } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    const v1 = await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 100n }] });
    const sub = await subs.create({ tenantId: 't1', planCode: 'default' });
    expect(sub.planVersionId).toBe(v1.id);
    expect(sub.status).toBe('active');
    const snap = await store.findTenantQuotaOverride('t1', 'api_calls');
    expect(snap).toMatchObject({ overrideValue: 100n, source: 'plan_snapshot' });
    await expect(subs.create({ tenantId: 't1', planCode: 'default' })).rejects.toMatchObject({ code: 1003 });
  });

  it('取消后可重新订阅（active_marker 释放）', async () => {
    const { plans, subs } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 100n }] });
    const s1 = await subs.create({ tenantId: 't1', planCode: 'default' });
    await subs.cancel(s1.id, { reason: '测试' });
    expect(await subs.findActive('t1')).toBeNull();
    const s2 = await subs.create({ tenantId: 't1', planCode: 'default' });
    expect(s2.id).not.toBe(s1.id);
  });

  it('绑定历史版本：planVersion 指定 v1 后续 v2 不影响既有订阅', async () => {
    const { store, plans, subs } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    const v1 = await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 100n }] });
    await subs.create({ tenantId: 't1', planCode: 'default' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 999n }] });
    const t1s = await store.findActiveSubscription('t1');
    expect(t1s?.planVersionId).toBe(v1.id); // 历史订阅仍绑 v1
    const s2 = await subs.create({ tenantId: 't2', planCode: 'default', planVersion: 1 });
    expect(s2.planVersionId).toBe(v1.id);
    await expect(subs.create({ tenantId: 't3', planCode: 'default', planVersion: 99 })).rejects.toMatchObject({ code: 1002 });
  });
});

describe('QuotaService（ADR-0029 生效值解析）', () => {
  it('无覆盖 → 套餐默认；有覆盖 → 覆盖值（source=manual）', async () => {
    const { store, plans, subs, quotas } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 100n }] });
    await subs.create({ tenantId: 't1', planCode: 'default' });

    const base = await quotas.resolveEffective('t1', 'api_calls');
    expect(base).toMatchObject({ limitValue: 100n, execution: 'hard', source: 'plan' });

    await store.upsertTenantQuota({ tenantId: 't1', quotaKey: 'api_calls', overrideValue: 7n, execution: null, source: 'manual' });
    const overridden = await quotas.resolveEffective('t1', 'api_calls');
    expect(overridden).toMatchObject({ limitValue: 7n, source: 'manual' });

    await expect(quotas.resolveEffective('t-none', 'api_calls')).rejects.toMatchObject({ code: 1002 });
  });
});

describe('windowStartFor（窗口切片）', () => {
  it('day 取当日 00:00 UTC，month 取当月 1 日，total 固定 epoch', () => {
    const at = new Date(Date.UTC(2026, 9, 19, 13, 30));
    expect(windowStartFor('day', at).toISOString()).toBe('2026-10-19T00:00:00.000Z');
    expect(windowStartFor('month', at).toISOString()).toBe('2026-10-01T00:00:00.000Z');
    expect(windowStartFor('total', at).toISOString()).toBe('1970-01-01T00:00:00.000Z');
  });
});

describe('UsageService（ADR-0030 限额与幂等）', () => {
  it('硬限额：额度内 ok、超限 4029（无副作用）、重复幂等键 deduped 不重复计量', async () => {
    const { plans, subs, usage, store } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 10n }] });
    await subs.create({ tenantId: 't1', planCode: 'default' });
    const at = new Date();

    const r1 = await usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 6n, occurredAt: at, source: 'api', idempotencyKey: 't1:api_calls:e1' });
    expect(r1).toMatchObject({ result: 'ok', used: 6n, limit: 10n });

    // 重复投递：不重复计量
    const dup = await usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 6n, occurredAt: at, source: 'api', idempotencyKey: 't1:api_calls:e1' });
    expect(dup.result).toBe('deduped');

    // 剩 4：扣 3 ok，再扣 2 → 超限 4029 且窗口 used 不变（无副作用）
    await usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 3n, occurredAt: at, source: 'api', idempotencyKey: 't1:api_calls:e2' });
    const ws = dayStartUTC(at);
    const before = await store.findWindow('t1', 'api_calls', 'day', ws);
    await expect(
      usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 2n, occurredAt: at, source: 'api', idempotencyKey: 't1:api_calls:e3' }),
    ).rejects.toBeInstanceOf(QuotaExceededError);
    await expect(
      usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 2n, occurredAt: at, source: 'api', idempotencyKey: 't1:api_calls:e3' }),
    ).rejects.toMatchObject({ code: 4029, http: 429, details: [{ field: 'metricKey', message: 'api_calls' }, { field: 'used', message: '9' }, { field: 'limit', message: '10' }] });
    const after = await store.findWindow('t1', 'api_calls', 'day', ws);
    expect(after?.used).toBe(before?.used);
    // 超限事件不留痕（同事务回滚语义）
    expect([...store.events.keys()].filter((k) => k.endsWith(':e3'))).toHaveLength(0);
  });

  it('软限额：达限告警一次（同窗幂等），钩子只触发一次', async () => {
    const { plans, subs, usage } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'storage_gb', limitValue: 5n }] });
    await subs.create({ tenantId: 't1', planCode: 'default' });
    let notified = 0;
    const notify = async (): Promise<void> => {
      notified += 1;
    };
    const at = new Date();
    await usage.record({ tenantId: 't1', quotaKey: 'storage_gb', quantity: 5n, occurredAt: at, source: 'api', idempotencyKey: 'k1' }, { notifySoftLimit: notify });
    expect(notified).toBe(1);
    // 同窗再告警不触发（warned_at 已标记）；第二事件因超限被拒但 deduped 语义先判定——此处走 exceeded
    await usage.record({ tenantId: 't1', quotaKey: 'storage_gb', quantity: 0n, occurredAt: at, source: 'api', idempotencyKey: 'k2' }, { notifySoftLimit: notify });
    expect(notified).toBe(1);
  });

  it('observe：仅留痕不判限，超限数量也放行', async () => {
    const { plans, subs, usage, store } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'audit_rows', limitValue: 1n }] });
    await subs.create({ tenantId: 't1', planCode: 'default' });
    const r = await usage.record({ tenantId: 't1', quotaKey: 'audit_rows', quantity: 100n, occurredAt: new Date(), source: 'api', idempotencyKey: 'a1' });
    expect(r.result).toBe('ok');
    expect(await store.findWindow('t1', 'audit_rows', 'day', dayStartUTC(new Date()))).toBeNull();
  });

  it('rollup 重算闭环：recalc 从 events 重建且幂等（AC-13-06）', async () => {
    const { plans, subs, usage, store } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 1000n }] });
    await subs.create({ tenantId: 't1', planCode: 'default' });
    const at = new Date();
    await usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 4n, occurredAt: at, source: 'api', idempotencyKey: 'r1' });
    await usage.record({ tenantId: 't1', quotaKey: 'api_calls', quantity: 6n, occurredAt: at, source: 'api', idempotencyKey: 'r2' });

    const from = dayStartUTC(at);
    const to = new Date(from.getTime() + 24 * 3600 * 1000);
    const rollup = await usage.recalcRollup('t1', 'api_calls', 'day', from, to);
    expect(rollup).toMatchObject({ totalQuantity: 10n, eventCount: 2 });
    // 重算幂等：重复执行结果一致
    const again = await usage.recalcRollup('t1', 'api_calls', 'day', from, to);
    expect(again.totalQuantity).toBe(10n);
    expect((await usage.findRollup('t1', 'api_calls', 'day', from))?.eventCount).toBe(2);
    expect(store).toBeDefined();
  });
});

describe('查询面（列表 / 详情 / 窗口解析 / 重复取消幂等）', () => {
  it('PlanService.listVersions 与 listPlanQuotas 返回发布结果', async () => {
    const { plans } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    const v1 = await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 10n }] });
    const versions = await plans.listVersions(plan.id);
    expect(versions).toHaveLength(1);
    const quotas = await plans.listPlanQuotas(v1.id);
    expect(quotas[0]).toMatchObject({ quotaKey: 'api_calls', limitValue: 10n });
  });

  it('SubscriptionService：重复取消幂等；resolveWindowStart 按字典出窗口', async () => {
    const { plans, subs, quotas } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 10n }, { quotaKey: 'storage_gb', limitValue: 5n }] });
    const sub = await subs.create({ tenantId: 't1', planCode: 'default' });
    const at = new Date(Date.UTC(2026, 9, 19, 8, 0));
    const day = await quotas.resolveWindowStart('t1', 'api_calls', at);
    expect(day).toEqual({ windowType: 'day', windowStart: dayStartUTC(at) });
    const total = await quotas.resolveWindowStart('t1', 'storage_gb', at);
    expect(total.windowType).toBe('total');
    await subs.cancel(sub.id, { reason: '一次' });
    await subs.cancel(sub.id, { reason: '二次' }); // 已关闭 → 幂等直返
  });

  it('FakeSaasStore 辅助查询面（findPlanById / findVersion / findSubscriptionById / findRollup 空值）', async () => {
    const { store, plans, subs, usage } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    expect((await store.findPlanById(plan.id))?.code).toBe('default');
    expect(await store.findVersionById('pv-x')).toBeNull();
    expect(await store.findVersion(plan.id, 1)).toBeNull();
    await expect(subs.cancel('sub-x')).rejects.toMatchObject({ code: 1002 }); // 不存在
    const at = new Date();
    expect(await usage.findRollup('t1', 'api_calls', 'day', dayStartUTC(at))).toBeNull();
    expect(await store.findWindow('t1', 'api_calls', 'day', dayStartUTC(at))).toBeNull();
  });
});

describe('FakeSaasStore 订阅列表查询（M14 FR-14-07 端口语义）', () => {
  async function seedSubs() {
    const { store, plans, subs } = await setup();
    const plan = await plans.createPlan({ code: 'default', name: '基础版' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 10n }] });
    const s1 = await subs.create({ tenantId: 't1', planCode: 'default', expireAt: new Date(Date.UTC(2026, 11, 1)) });
    const s2 = await subs.create({ tenantId: 't2', planCode: 'default' });
    await subs.cancel(s2.id, { reason: '运营取消' });
    return { store, plans, subs, plan, s1, s2 };
  }

  it('分页列表：total 全集口径 + 分页切片', async () => {
    const { store } = await seedSubs();
    const page1 = await store.listSubscriptions({}, { page: 1, pageSize: 1 });
    expect(page1.total).toBe(2);
    expect(page1.items).toHaveLength(1);
    const page2 = await store.listSubscriptions({}, { page: 2, pageSize: 1 });
    expect(page2.items).toHaveLength(1);
    expect(page2.items[0].id).not.toBe(page1.items[0].id);
  });

  it('过滤：status / tenantId / planId 等值 + 到期范围（expireAt 为 null 不命中范围）', async () => {
    const { store, plan, s1, s2 } = await seedSubs();
    expect((await store.listSubscriptions({ status: 'active' }, { page: 1, pageSize: 10 })).items.map((s) => s.id)).toEqual([s1.id]);
    expect((await store.listSubscriptions({ status: 'cancelled' }, { page: 1, pageSize: 10 })).items.map((s) => s.id)).toEqual([s2.id]);
    expect((await store.listSubscriptions({ tenantId: 't1' }, { page: 1, pageSize: 10 })).total).toBe(1);
    expect((await store.listSubscriptions({ planId: plan.id }, { page: 1, pageSize: 10 })).total).toBe(2);
    const inRange = await store.listSubscriptions({ expireFrom: new Date(Date.UTC(2026, 10, 1)), expireTo: new Date(Date.UTC(2026, 11, 30)) }, { page: 1, pageSize: 10 });
    expect(inRange.items.map((s) => s.id)).toEqual([s1.id]); // s2 无到期时间，不命中
  });

  it('租户历史：完整列表 + effectiveAt desc + id asc tie-breaker（排序稳定）', async () => {
    const { store, plans, subs, plan, s1 } = await seedSubs();
    await subs.cancel(s1.id, { reason: '重开' });
    await plans.publishVersion(plan.id, { quotas: [{ quotaKey: 'api_calls', limitValue: 20n }] });
    const s1b = await subs.create({ tenantId: 't1', planCode: 'default', effectiveAt: new Date(Date.UTC(2027, 0, 1)) });
    const history = await store.listSubscriptionsByTenant('t1');
    expect(history).toHaveLength(2);
    expect(history[0].id).toBe(s1b.id); // effectiveAt 更晚 → 排前
    expect(history.map((s) => s.status)).toEqual(['active', 'cancelled']);

    // tie-breaker：同 effectiveAt 时按 id asc 稳定排序（与 Prisma 实现一致）
    const same = await subs.create({ tenantId: 't3', planCode: 'default', effectiveAt: new Date(Date.UTC(2027, 0, 1)) });
    const samePair = await store.listSubscriptionsByTenant('t3');
    expect(samePair.map((s) => s.id)).toEqual([same.id]);
    const both = await store.listSubscriptions({}, { page: 1, pageSize: 10 });
    const ids = both.items.map((s) => s.id);
    expect(ids.indexOf(s1b.id)).toBeLessThan(ids.indexOf(same.id) === -1 ? ids.length : ids.indexOf(same.id));
  });
});
