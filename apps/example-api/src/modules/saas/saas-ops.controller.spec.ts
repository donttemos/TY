/*
 * @file 单测：SaaS 运营端点（M14/PRD-014 FR-14-03/05/06/07/12/14）
 * @description 直接实例化 SaasOpsController（不经 HTTP 层）验证端点契约：
 *   GET lifecycle/status —— status 直读 store.findTenantStatus，allowedActions 由 @fw/saas TRANSITIONS
 *   迁移表派生（单一权威），租户不存在 → { status: null, allowedActions: [] }；
 *   POST plans / POST plans/:id/versions —— 入参校验（1001 信封）、limitValue 归一 BigInt、审计事件、
 *   发布返回配额默认项（limitValue 转 string）；GET tenant-subscriptions —— 分页/状态白名单/planCode
 *   解析/到期范围校验 + planCode/planName/planVersion 补全；GET tenants/:id/subscriptions/history；
 *   GET usage/trend —— hours 白名单 + UTC 桶聚合填零；GET usage/events —— 内存分页；
 *   GET usage/overview —— 风险 ≥80% TOP20 + 7 天到期 + 五态计数 + 最近迁移。
 *   权限装饰器、领域服务内部语义（状态机/发布不可变/唯一冲突）由 @fw/saas 包内测试与守卫测试覆盖。
 * @author donttemo
 * @created 2026-10-20
 * @module example-api/saas
 */
import 'reflect-metadata';
import { ErrorCode } from '@fw/core';
import { describe, expect, it, vi } from 'vitest';
import { SaasOpsController } from './saas-ops.controller.js';
import type { SaasStore, SubscriptionView } from '@fw/saas';

/** 可按用例覆写的 store 桩（只实现控制器直读的方法面） */
function makeStore(overrides: Partial<Record<string, unknown>> = {}): SaasStore {
  return {
    findTenantStatus: vi.fn(async () => null),
    findPlanByCode: vi.fn(async () => null),
    findPlanById: vi.fn(async () => null),
    findVersionById: vi.fn(async () => null),
    listSubscriptions: vi.fn(async () => ({ items: [], total: 0 })),
    listSubscriptionsByTenant: vi.fn(async () => []),
    listEvents: vi.fn(async () => []),
    listWindows: vi.fn(async () => []),
    countTenantsByStatus: vi.fn(async () => 0),
    listRecentLifecycleLogs: vi.fn(async () => []),
    listActiveSubscriptionsExpiredAt: vi.fn(async () => []),
    ...overrides,
  } as unknown as SaasStore;
}

/** PlanService 桩（写端点用） */
function makePlans(overrides: Record<string, unknown> = {}) {
  return {
    createPlan: vi.fn(async (input: { code: string; name: string; description?: string | null }) => ({ id: 'plan-1', ...input })),
    publishVersion: vi.fn(async () => ({ id: 'pv-9', planId: 'plan-1', version: 3, status: 'published', remark: null, publishedAt: new Date() })),
    listPlanQuotas: vi.fn(async () => [{ planVersionId: 'pv-9', quotaKey: 'api_calls', limitValue: 500n, execution: 'hard' }]),
    ...overrides,
  };
}

const AUDIT = { record: vi.fn() };

/** 通用订阅行（列表/历史用例共享） */
const sub = { id: 'sub-1', tenantId: 't1', planId: 'plan-1', planVersionId: 'pv-1', status: 'active', effectiveAt: new Date(), expireAt: null, closedAt: null, reason: null } as SubscriptionView;

function makeController(store: SaasStore, plans: ReturnType<typeof makePlans>) {
  return new SaasOpsController(store, plans as never, {} as never, {} as never, {} as never, {} as never, AUDIT as never);
}

describe('SaasOpsController GET tenants/:id/lifecycle/status（M14 FR-14-03）', () => {
  it('active 租户：allowedActions = 迁移表 active 行（expire/freeze/terminate）', async () => {
    const controller = makeController(makeStore({ findTenantStatus: vi.fn(async () => 'active') }), makePlans());
    const r = await controller.lifecycleStatus('t1');
    expect(r.status).toBe('active');
    expect(r.allowedActions).toEqual(['expire', 'freeze', 'terminate']);
  });

  it('frozen 租户：出口仅 resume/terminate（ADR-0031 §3.2 冻结仍可恢复）', async () => {
    const controller = makeController(makeStore({ findTenantStatus: vi.fn(async () => 'frozen') }), makePlans());
    const r = await controller.lifecycleStatus('t1');
    expect(r).toEqual({ status: 'frozen', allowedActions: ['resume', 'terminate'] });
  });

  it('租户不存在：status=null 且 allowedActions 为空（前端据此渲染空态）', async () => {
    const r = await makeController(makeStore(), makePlans()).lifecycleStatus('missing');
    expect(r).toEqual({ status: null, allowedActions: [] });
  });
});

describe('SaasOpsController POST /saas/plans（M14 FR-14-05）', () => {
  it('缺 code/name → 1001 信封，不触达领域服务', async () => {
    const plans = makePlans();
    await expect(makeController(makeStore(), plans).createPlan({ name: 'x' })).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(plans.createPlan).not.toHaveBeenCalled();
  });

  it('正常创建：trim 透传 + 审计事件 saas.plan.create（after 快照）', async () => {
    const plans = makePlans();
    const r = await makeController(makeStore(), plans).createPlan({ code: ' pro ', name: ' 专业版 ', description: null });
    expect(plans.createPlan).toHaveBeenCalledWith({ code: 'pro', name: '专业版', description: null });
    expect(r).toMatchObject({ id: 'plan-1', code: 'pro' });
    expect(AUDIT.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'saas.plan.create', targetType: 'plan', after: { code: 'pro', name: '专业版', description: null } }));
  });
});

describe('SaasOpsController POST /saas/plans/:id/versions（M14 FR-14-06）', () => {
  it('quotas 缺失/空数组 → 1001，不触达领域服务', async () => {
    const plans = makePlans();
    await expect(makeController(makeStore(), plans).publishPlanVersion('plan-1', {})).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    await expect(makeController(makeStore(), plans).publishPlanVersion('plan-1', { quotas: [] })).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(plans.publishVersion).not.toHaveBeenCalled();
  });

  it('limitValue 字符串归一 BigInt + 审计 + 返回配额默认项（limitValue 转 string）', async () => {
    const plans = makePlans();
    const r = await makeController(makeStore(), plans).publishPlanVersion('plan-1', {
      remark: 'v3',
      quotas: [{ quotaKey: ' api_calls ', limitValue: '500', execution: 'hard' }],
    });
    expect(plans.publishVersion).toHaveBeenCalledWith('plan-1', { remark: 'v3', quotas: [{ quotaKey: 'api_calls', limitValue: 500n, execution: 'hard' }] });
    expect(r).toMatchObject({ version: 3, quotas: [{ quotaKey: 'api_calls', limitValue: '500', execution: 'hard' }] });
    expect(AUDIT.record).toHaveBeenCalledWith(expect.objectContaining({ event: 'saas.plan.publish', after: { planId: 'plan-1', version: 3, remark: 'v3', quotaCount: 1 } }));
  });

  it('limitValue 非法（负数/非数）→ 1001', async () => {
    const plans = makePlans();
    await expect(makeController(makeStore(), plans).publishPlanVersion('plan-1', { quotas: [{ quotaKey: 'a', limitValue: -1 }] })).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    await expect(makeController(makeStore(), plans).publishPlanVersion('plan-1', { quotas: [{ quotaKey: 'a', limitValue: 'abc' }] })).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(plans.publishVersion).not.toHaveBeenCalled();
  });
});

describe('SaasOpsController GET /saas/tenant-subscriptions（M14 FR-14-07）', () => {
  it('status 白名单外 → 1001；pageSize 超 200 → 1001', async () => {
    const store = makeStore();
    await expect(makeController(store, makePlans()).listSubscriptions('1', '20', undefined, undefined, 'bogus')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    await expect(makeController(store, makePlans()).listSubscriptions('1', '201')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('planCode 过滤解析为 planId；套餐不存在 → 空页（不触达列表查询）', async () => {
    const store = makeStore({ findPlanByCode: vi.fn(async () => null) });
    const r = await makeController(store, makePlans()).listSubscriptions('1', '20', undefined, 'ghost');
    expect(r).toMatchObject({ items: [], total: 0 });
    expect(store.listSubscriptions).not.toHaveBeenCalled();
  });

  it('正常查询：过滤透传 + planCode/planName/planVersion 补全', async () => {
    const store = makeStore({
      findPlanByCode: vi.fn(async (code: string) => (code === 'default' ? { id: 'plan-1', code, name: '基础版' } : null)),
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'default', name: '基础版' })),
      findVersionById: vi.fn(async () => ({ id: 'pv-1', version: 2 })),
      listSubscriptions: vi.fn(async () => ({ items: [sub], total: 1 })),
    });
    const r = await makeController(store, makePlans()).listSubscriptions('2', '50', 't1', 'default', 'active');
    expect(store.listSubscriptions).toHaveBeenCalledWith(
      { tenantId: 't1', planId: 'plan-1', status: 'active' },
      { page: 2, pageSize: 50 },
    );
    expect(r).toMatchObject({ total: 1, page: 2, pageSize: 50, items: [{ planCode: 'default', planName: '基础版', planVersion: 2 }] });
  });
});

describe('SaasOpsController GET /saas/tenants/:id/subscriptions/history（M14 FR-14-07）', () => {
  it('返回补全后的完整历史', async () => {
    const sub2 = { ...sub, id: 'sub-2', status: 'cancelled' as const };
    const store = makeStore({
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'default', name: '基础版' })),
      findVersionById: vi.fn(async () => ({ id: 'pv-1', version: 1 })),
      listSubscriptionsByTenant: vi.fn(async () => [sub, sub2]),
    });
    const r = await makeController(store, makePlans()).subscriptionHistory('t1');
    expect(store.listSubscriptionsByTenant).toHaveBeenCalledWith('t1');
    expect(r).toHaveLength(2);
    expect(r[0]).toMatchObject({ planCode: 'default', planVersion: 1 });
  });
});

describe('SaasOpsController GET usage/trend（M14 FR-14-12）', () => {
  it('quotaKey 缺失 → 1001', async () => {
    await expect(makeController(makeStore(), makePlans()).usageTrend('t1', '')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('hours 白名单外 → 1001', async () => {
    await expect(makeController(makeStore(), makePlans()).usageTrend('t1', 'api_calls', '12')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('分桶聚合 + 填零序列：24h → 小时桶 UTC 对齐', async () => {
    const now = new Date();
    const hour = (h: number) => new Date(now.getTime() - h * 3_600_000);
    const store = makeStore({
      listEvents: vi.fn(async () => [
        { quantity: 5n, occurredAt: hour(1) },
        { quantity: 3n, occurredAt: hour(1) }, // 同一小时桶合并
        { quantity: 2n, occurredAt: hour(3) },
      ]),
    });
    const r = (await makeController(store, makePlans()).usageTrend('t1', 'api_calls', '24')) as { bucketType: string; points: Array<{ bucketStart: string; quantity: string; eventCount: number }> };
    expect(r.bucketType).toBe('hour');
    expect(r.points).toHaveLength(25); // 24h 窗口 → 25 个整点桶（含两端）
    // hour(1) 所在整点桶合并两条事件（5+3=8）
    const h1 = hour(1);
    const bucket1 = new Date(Date.UTC(h1.getUTCFullYear(), h1.getUTCMonth(), h1.getUTCDate(), h1.getUTCHours())).toISOString();
    expect(r.points.find((p) => p.bucketStart === bucket1)).toMatchObject({ quantity: '8', eventCount: 2 });
    // hour(3) 所在整点桶
    const h3 = hour(3);
    const bucket3 = new Date(Date.UTC(h3.getUTCFullYear(), h3.getUTCMonth(), h3.getUTCDate(), h3.getUTCHours())).toISOString();
    expect(r.points.find((p) => p.bucketStart === bucket3)?.quantity).toBe('2');
    // 填零：远离事件的桶数量为 0
    expect(r.points.filter((p) => p.quantity === '0').length).toBeGreaterThan(0);
  });

  it('168h → 天桶', async () => {
    const r = (await makeController(makeStore(), makePlans()).usageTrend('t1', 'api_calls', '168')) as { bucketType: string; points: unknown[] };
    expect(r.bucketType).toBe('day');
    expect(r.points).toHaveLength(8); // 168h 窗口 → 8 个 UTC 日桶
  });
});

describe('SaasOpsController GET usage/events（M14 FR-14-12）', () => {
  it('白名单校验 + 内存分页（occurredAt desc）', async () => {
    const now = new Date();
    const store = makeStore({
      listEvents: vi.fn(async () => [
        { quantity: 1n, occurredAt: new Date(now.getTime() - 3_600_000) },
        { quantity: 2n, occurredAt: new Date(now.getTime() - 7_200_000) },
        { quantity: 3n, occurredAt: new Date(now.getTime() - 10_800_000) },
      ]),
    });
    await expect(makeController(store, makePlans()).usageEventList('t1', 'api_calls', '12')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });

    const page1 = (await makeController(store, makePlans()).usageEventList('t1', 'api_calls', '24', '1', '2')) as { items: Array<{ quantity: string }>; total: number };
    expect(page1.total).toBe(3);
    expect(page1.items.map((i) => i.quantity)).toEqual(['1', '2']); // 最新在前
  });

  it('pageSize 超 200 → 1001', async () => {
    await expect(makeController(makeStore(), makePlans()).usageEventList('t1', 'api_calls', '24', '1', '201')).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });
});

describe('SaasOpsController GET /saas/usage/overview（M14 FR-14-14）', () => {
  it('风险 ≥80% TOP20 + 五态计数 + 最近迁移 + 到期过滤', async () => {
    const now = new Date();
    const store = makeStore({
      listWindows: vi.fn(async (windowType: string) =>
        windowType === 'day'
          ? [
              { tenantId: 't1', quotaKey: 'api_calls', used: 90n, limitValue: 100n, execution: 'hard' }, // 90%
              { tenantId: 't2', quotaKey: 'api_calls', used: 10n, limitValue: 100n, execution: 'hard' }, // 10% 不入选
              { tenantId: 't3', quotaKey: 'storage_gb', used: 0n, limitValue: 0n, execution: 'observe' }, // limit=0 排除
            ]
          : [{ tenantId: 't4', quotaKey: 'api_calls', used: 85n, limitValue: 100n, execution: 'hard' }],
      ),
      countTenantsByStatus: vi.fn(async (s: string) => (s === 'active' ? 3 : s === 'frozen' ? 1 : 0)),
      listRecentLifecycleLogs: vi.fn(async () => [{ tenantId: 't1', toStatus: 'frozen', action: 'freeze', actorType: 'user', at: now }]),
      listActiveSubscriptionsExpiredAt: vi.fn(async () => [
        { id: 's1', tenantId: 't9', expireAt: new Date(now.getTime() + 3 * 86_400_000) },
        { id: 's2', tenantId: 't10', expireAt: new Date(now.getTime() - 3 * 86_400_000) }, // 已过期，不在「即将到期」
      ]),
    });
    const r = (await makeController(store, makePlans()).opsOverview()) as {
      quotaRisks: Array<{ tenantId: string; windowType: string; ratio: number }>;
      expiringSubscriptions: Array<{ subscriptionId: string }>;
      tenantCounts: Record<string, number>;
      recentTransitions: Array<{ action: string }>;
    };
    expect(r.quotaRisks.map((x) => x.tenantId)).toEqual(['t1', 't4']); // 90 排在 85 前
    expect(r.quotaRisks[0].windowType).toBe('day');
    expect(r.quotaRisks[1].windowType).toBe('month');
    expect(r.expiringSubscriptions.map((x) => x.subscriptionId)).toEqual(['s1']);
    expect(r.tenantCounts).toMatchObject({ active: 3, frozen: 1, terminated: 0 });
    expect(r.recentTransitions[0].action).toBe('freeze');
  });
});
