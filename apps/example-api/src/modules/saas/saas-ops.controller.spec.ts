/*
 * @file 单测：SaaS 运营端点（M14/PRD-014 FR-14-03/05/06/07）
 * @description 直接实例化 SaasOpsController（不经 HTTP 层）验证端点契约：
 *   GET lifecycle/status —— status 直读 store.findTenantStatus，allowedActions 由 @fw/saas TRANSITIONS
 *   迁移表派生（单一权威），租户不存在 → { status: null, allowedActions: [] }；
 *   POST plans / POST plans/:id/versions —— 入参校验（1001 信封）、limitValue 归一 BigInt、审计事件、
 *   发布返回配额默认项（limitValue 转 string）；GET tenant-subscriptions —— 分页/状态白名单/planCode
 *   解析/到期范围校验 + planCode/planName/planVersion 补全；GET tenants/:id/subscriptions/history。
 *   权限装饰器、领域服务内部语义（状态机/发布不可变/唯一冲突）由 @fw/saas 包内测试与守卫测试覆盖。
 * @author donttemo
 * @created 2026-10-20
 * @module example-api/saas
 */
import 'reflect-metadata';
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
    const r = await makeController(makeStore(), plans).createPlan({ name: 'x' });
    expect(r).toMatchObject({ code: 1001 });
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
    const r1 = await makeController(makeStore(), plans).publishPlanVersion('plan-1', {});
    const r2 = await makeController(makeStore(), plans).publishPlanVersion('plan-1', { quotas: [] });
    expect(r1).toMatchObject({ code: 1001 });
    expect(r2).toMatchObject({ code: 1001 });
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
    const r1 = await makeController(makeStore(), plans).publishPlanVersion('plan-1', { quotas: [{ quotaKey: 'a', limitValue: -1 }] });
    const r2 = await makeController(makeStore(), plans).publishPlanVersion('plan-1', { quotas: [{ quotaKey: 'a', limitValue: 'abc' }] });
    expect(r1).toMatchObject({ code: 1001 });
    expect(r2).toMatchObject({ code: 1001 });
    expect(plans.publishVersion).not.toHaveBeenCalled();
  });
});

describe('SaasOpsController GET /saas/tenant-subscriptions（M14 FR-14-07）', () => {
  it('status 白名单外 → 1001；pageSize 超 200 → 1001', async () => {
    const store = makeStore();
    const r1 = await makeController(store, makePlans()).listSubscriptions('1', '20', undefined, undefined, 'bogus');
    const r2 = await makeController(store, makePlans()).listSubscriptions('1', '201');
    expect(r1).toMatchObject({ code: 1001 });
    expect(r2).toMatchObject({ code: 1001 });
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
