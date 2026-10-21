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
 * @modified 2026-10-21 donttemo P1（PRD-015 FR-15-10 收口）：补 target_label 名称快照断言——
 *   套餐发布/订阅开通/订阅取消/配额超限/生命周期迁移解析租户名·套餐名；取不到写缺失标记。
 * @modified 2026-10-21 donttemo P1 加固（FR-15-10 评审）：补名称快照**故障注入**降级断言——
 *   名称查询抛异常时，已提交的业务操作（发布/开通/取消/迁移）照常成功，原始业务错误
 *   （4030/4029）原样抛出，审计一律落缺失标记：旁路查询不得反向决定业务成败。
 * @modified 2026-10-21 donttemo P1 订阅创建入参校验：空 / 纯空白 / 非字符串 tenantId → 1001，
 *   未知租户 → 1002，planCode 空白 → 1001；被拒请求不得查库、不得触达领域服务、不得落审计。
 *   名称快照用例同步补 findTenantStatus（存在性由状态端点回答，名称缺失是另一回事）。
 * @modified 2026-10-21 donttemo P1 业务一致性：订阅创建补生命周期状态规则——terminated → 4030
 *   （终态无迁出，不得留下「生效订阅 + 终止租户」），pending/active/grace/frozen 放行且不触发
 *   隐式迁移；存在性与状态共用同一次 findTenantStatus 读取（调用次数锁定）。
 * @modified 2026-10-21 donttemo P2 追溯补齐：terminated 拒绝改为**必须落一条 denied 审计**
 *   （`saas.subscription.create_rejected`，含操作人/租户名快照/请求套餐/租户状态/拒绝文案），
 *   同时锁定「仍不创建订阅」；名称解析抛错时照常 4030 并落缺失标记（审计是旁路）。
 * @author donttemo
 * @created 2026-10-20
 * @module example-api/saas
 */
import 'reflect-metadata';
import { BizError, ErrorCode } from '@fw/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SaasOpsController } from './saas-ops.controller.js';
import type { SaasStore, SubscriptionView } from '@fw/saas';

/** 可按用例覆写的 store 桩（只实现控制器直读的方法面） */
function makeStore(overrides: Partial<Record<string, unknown>> = {}): SaasStore {
  return {
    findTenantStatus: vi.fn(async () => null),
    findTenantName: vi.fn(async () => null),
    findPlanByCode: vi.fn(async () => null),
    findPlanById: vi.fn(async () => null),
    findVersionById: vi.fn(async () => null),
    findSubscriptionById: vi.fn(async () => null),
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

const AUDIT = { record: vi.fn(), recordEvent: vi.fn() };

// AUDIT 是模块级共享桩：不清历史会让后一个用例吃到前一个用例的调用（伪绿），
// 每个用例只应看到自己触发的 recordEvent
beforeEach(() => {
  vi.clearAllMocks();
});

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
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.plan.create',
      expect.objectContaining({ targetLabel: '专业版', after: { code: 'pro', name: '专业版', description: null } }),
    );
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
    const store = makeStore({ findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'default', name: '基础版' })) });
    const r = await makeController(store, plans).publishPlanVersion('plan-1', {
      remark: 'v3',
      quotas: [{ quotaKey: ' api_calls ', limitValue: '500', execution: 'hard' }],
    });
    expect(plans.publishVersion).toHaveBeenCalledWith('plan-1', { remark: 'v3', quotas: [{ quotaKey: 'api_calls', limitValue: 500n, execution: 'hard' }] });
    expect(r).toMatchObject({ version: 3, quotas: [{ quotaKey: 'api_calls', limitValue: '500', execution: 'hard' }] });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.plan.publish',
      expect.objectContaining({ targetId: 'plan-1', targetLabel: '基础版', after: { planId: 'plan-1', version: 3, remark: 'v3', quotaCount: 1 } }),
    );
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

describe('SaasOpsController M13 端点入参校验（信封直返修正，HTTP 400/1001）', () => {
  it('usage GET 缺 quotaKey → BAD_REQUEST', async () => {
    await expect(makeController(makeStore(), makePlans()).getUsage('t1', undefined as never)).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('usage/events POST 缺必填字段 → BAD_REQUEST', async () => {
    await expect(makeController(makeStore(), makePlans()).recordUsageEvent('t1', { action: undefined } as never, undefined as never)).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });

  it('lifecycle POST 非法动作 → BAD_REQUEST', async () => {
    await expect(makeController(makeStore(), makePlans()).transition('t1', { action: 'bogus' } as never, undefined as never)).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
  });
});

describe('SaasOpsController POST /saas/tenant-subscriptions 入参校验（P1：真机空 tenantId 缺口）', () => {
  /** 订阅领域服务桩：只记录调用参数，不落库 */
  function makeSubscriptions() {
    return {
      create: vi.fn(async (input: { tenantId: string; planCode: string; planVersion?: number; expireAt?: Date | null }) => ({
        id: 'sub-new',
        tenantId: input.tenantId,
        planId: 'plan-1',
        planVersionId: 'pv-1',
        status: 'active',
        effectiveAt: new Date(),
        expireAt: input.expireAt ?? null,
        closedAt: null,
        reason: null,
      })),
    };
  }

  /** 控制器装配（订阅点位换成桩） */
  function makeCreateController(store: SaasStore, subscriptions: ReturnType<typeof makeSubscriptions>) {
    return new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
  }

  it('空 tenantId → 1001：不查租户、不调领域服务、不落审计（不再建出 tenant_id="" 的行）', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => 'active') });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: '', planCode: 'default' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(store.findTenantStatus).not.toHaveBeenCalled();
    expect(subscriptions.create).not.toHaveBeenCalled();
    expect(AUDIT.recordEvent).not.toHaveBeenCalled();
  });

  it('纯空白 tenantId → 1001（trim 后为空，不做「兜底成某租户」的猜测）', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => 'active') });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: '   ', planCode: 'default' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(store.findTenantStatus).not.toHaveBeenCalled();
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it('tenantId 类型非字符串（null/数字）→ 1001', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => 'active') });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: null, planCode: 'default' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: 1, planCode: 'default' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it('租户不存在 → 1002：不调领域服务（避免产出入权益数据挂到不存在的租户上）', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => null) });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: 'ghost', planCode: 'default' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.NOT_FOUND });
    expect(subscriptions.create).not.toHaveBeenCalled();
    expect(AUDIT.recordEvent).not.toHaveBeenCalled();
  });

  it('planCode 空白 → 1001（不在领域层用空 code 查套餐）', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => 'active') });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: 't1', planCode: '  ' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.BAD_REQUEST });
    expect(store.findTenantStatus).not.toHaveBeenCalled();
    expect(subscriptions.create).not.toHaveBeenCalled();
  });

  it('正常创建：trim 后的 tenantId 透传领域服务，审计 after 同步使用归一值', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({
      findTenantStatus: vi.fn(async () => 'active'),
      findTenantName: vi.fn(async () => '示例企业'),
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'default', name: '基础版' })),
    });
    const sub = (await makeCreateController(store, subscriptions).createSubscription(
      { tenantId: ' t1 ', planCode: ' default ' } as never,
      undefined as never,
    )) as { id: string; tenantId: string };

    expect(store.findTenantStatus).toHaveBeenCalledWith('t1');
    expect(store.findTenantStatus).toHaveBeenCalledTimes(1); // 存在性与状态共用同一次读取
    expect(subscriptions.create).toHaveBeenCalledWith({ tenantId: 't1', planCode: 'default', planVersion: undefined, expireAt: null });
    expect(sub).toMatchObject({ id: 'sub-new', tenantId: 't1' });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create',
      expect.objectContaining({ targetLabel: '示例企业 · 基础版', after: expect.objectContaining({ tenantId: 't1', planCode: 'default' }) }),
    );
  });
});

describe('SaasOpsController POST /saas/tenant-subscriptions 生命周期状态规则（P1 业务一致性）', () => {
  /** 订阅领域服务桩：只记录调用参数，不落库 */
  function makeSubscriptions() {
    return { create: vi.fn(async (input: { tenantId: string }) => ({ id: 'sub-new', tenantId: input.tenantId, status: 'active' })) };
  }

  function makeCreateController(store: SaasStore, subscriptions: ReturnType<typeof makeSubscriptions>) {
    return new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
  }

  it('terminated → 4030（终态无迁移出口）：不创建订阅，但拒绝必须落 denied 审计', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({
      findTenantStatus: vi.fn(async () => 'terminated'),
      findTenantName: vi.fn(async () => '已注销租户'),
    });
    await expect(
      makeCreateController(store, subscriptions).createSubscription(
        { tenantId: 't-term', planCode: ' pro ' } as never,
        { id: 'u-1', username: 'alice' } as never,
      ),
    ).rejects.toMatchObject({
      code: ErrorCode.LIFECYCLE_TRANSITION_INVALID,
      http: 409,
      details: [
        { field: 'from', message: 'terminated' },
        { field: 'action', message: 'activate' },
      ],
    });
    // 拒绝发生在领域调用之前：不会留下「生效订阅 + 终止租户」的矛盾数据
    expect(subscriptions.create).not.toHaveBeenCalled();
    // 但运营追溯不能断：与 saas.lifecycle.invalid 同口径，先记录再原样抛出
    expect(AUDIT.recordEvent).toHaveBeenCalledTimes(1);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create_rejected',
      expect.objectContaining({
        // 租户维度必须显式对齐目标租户：@IgnoreTenant 请求无 x-tenant-id，靠上下文会落 0，
        // 平台审计按租户筛选就查不到这条拒绝
        tenantId: 't-term',
        userId: 'u-1',
        actorLabel: 'alice',
        targetType: 'tenant',
        targetId: 't-term',
        targetLabel: '已注销租户',
        result: 'denied',
        reason: expect.stringContaining('租户已终止'),
        after: { planCode: 'pro', tenantStatus: 'terminated', code: ErrorCode.LIFECYCLE_TRANSITION_INVALID },
      }),
    );
  });

  it('拒绝留痕不依赖名称解析：findTenantName 抛错仍 4030，targetLabel 落缺失标记（不造假名称）', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({
      findTenantStatus: vi.fn(async () => 'terminated'),
      findTenantName: vi.fn(async () => {
        throw new Error('db down');
      }),
    });
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: 't-term', planCode: 'default' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.LIFECYCLE_TRANSITION_INVALID });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create_rejected',
      expect.objectContaining({ tenantId: 't-term', targetLabel: '名称快照缺失（ID: t-term）', result: 'denied' }),
    );
  });

  it('套餐事件刻意不带 tenantId（平台级对象，且订阅相关事件必须带）', async () => {
    const plans = makePlans();
    await makeController(makeStore(), plans).createPlan({ code: 'pro', name: '专业版' });
    const payload = AUDIT.recordEvent.mock.calls.find((c) => c[0] === 'saas.plan.create')?.[1] as Record<string, unknown>;
    expect(payload).toBeDefined();
    // 带上 tenantId 会让平台套餐动作被租户维度的审计查询命中
    expect(payload.tenantId).toBeUndefined();
  });

  it.each(['pending', 'active', 'grace', 'frozen'] as const)('%s → 放行开通（frozen 的续订+恢复是合法流程，开通不做隐式迁移）', async (status) => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => status) });
    const r = (await makeCreateController(store, subscriptions).createSubscription({ tenantId: 't1', planCode: 'default' } as never, undefined as never)) as { id: string };
    expect(r).toMatchObject({ id: 'sub-new' });
    expect(subscriptions.create).toHaveBeenCalledTimes(1);
  });

  it('frozen 放行后不触发生命周期迁移（状态写权唯一归属 TenantLifecycleService）', async () => {
    const subscriptions = makeSubscriptions();
    const store = makeStore({ findTenantStatus: vi.fn(async () => 'frozen') });
    // lifecycle 点位是空桩：一旦被调用即 TypeError，能通过就证明未发生隐式 resume
    await expect(
      makeCreateController(store, subscriptions).createSubscription({ tenantId: 't1', planCode: 'default' } as never, undefined as never),
    ).resolves.toMatchObject({ id: 'sub-new' });
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

describe('SaasOpsController 生命周期事件（M15 FR-15-09）', () => {
  it('迁移成功：落独立事件码（不再用模板拼码）', async () => {
    const lifecycle = { transition: vi.fn(async () => ({ from: 'active', to: 'frozen', alreadyApplied: false })) };
    const controller = new SaasOpsController(
      makeStore(),
      makePlans() as never,
      {} as never,
      {} as never,
      {} as never,
      lifecycle as never,
      AUDIT as never,
    );
    await controller.transition('t1', { action: 'freeze', reason: '欠费' } as never, undefined as never);

    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.freeze',
      expect.objectContaining({ targetId: 't1', reason: '欠费', after: expect.objectContaining({ from: 'active', to: 'frozen' }) }),
    );
  });

  it('非法迁移（4030）：先记 denial 再原样抛出，不改变错误语义', async () => {
    const lifecycle = {
      transition: vi.fn(async () => {
        throw new BizError(ErrorCode.LIFECYCLE_TRANSITION_INVALID, '非法迁移：active -> resume');
      }),
    };
    const controller = new SaasOpsController(
      makeStore(),
      makePlans() as never,
      {} as never,
      {} as never,
      {} as never,
      lifecycle as never,
      AUDIT as never,
    );

    await expect(controller.transition('t1', { action: 'resume' } as never, undefined as never)).rejects.toMatchObject({
      code: ErrorCode.LIFECYCLE_TRANSITION_INVALID,
    });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.invalid',
      expect.objectContaining({
        targetId: 't1',
        result: 'denied',
        reason: '非法迁移：active -> resume',
        after: expect.objectContaining({ action: 'resume', code: ErrorCode.LIFECYCLE_TRANSITION_INVALID }),
      }),
    );
  });
});

describe('SaasOpsController 审计 target_label 名称快照（P1 / PRD-015 FR-15-10）', () => {
  /** 造订阅领域服务的 create 桩（返回带 tenantId/planId 的订阅行） */
  function makeSubscriptionsCreate(subId: string, tenantId: string, planId: string) {
    return {
      create: vi.fn(async () => ({ id: subId, tenantId, planId, planVersionId: 'pv-1', status: 'active', effectiveAt: new Date(), expireAt: null, closedAt: null, reason: null })),
    };
  }

  it('套餐发布：target_label = 套餐名（写入时解析，不落 planId）', async () => {
    const plans = makePlans();
    const store = makeStore({ findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'default', name: '基础版' })) });
    await makeController(store, plans).publishPlanVersion('plan-1', { quotas: [{ quotaKey: 'api_calls', limitValue: 500 }] });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.plan.publish',
      expect.objectContaining({ targetId: 'plan-1', targetLabel: '基础版' }),
    );
  });

  it('套餐发布：套餐取不到 → 显式缺失标记，不落裸 ID', async () => {
    const plans = makePlans();
    await makeController(makeStore(), plans).publishPlanVersion('plan-ghost', { quotas: [{ quotaKey: 'api_calls', limitValue: 500 }] });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.plan.publish',
      expect.objectContaining({ targetId: 'plan-ghost', targetLabel: '名称快照缺失（ID: plan-ghost）' }),
    );
  });

  it('订阅开通：target_label = 租户名 · 套餐名', async () => {
    const subscriptions = makeSubscriptionsCreate('sub-1', 't1', 'plan-1');
    const store = makeStore({
      findTenantStatus: vi.fn(async () => 'active'),
      findTenantName: vi.fn(async () => '示例企业'),
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'pro', name: '专业版' })),
    });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    await controller.createSubscription({ tenantId: 't1', planCode: 'pro' } as never, undefined as never);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create',
      expect.objectContaining({ tenantId: 't1', targetId: 'sub-1', targetLabel: '示例企业 · 专业版' }),
    );
  });

  it('订阅开通：租户名取不到 → 只标记缺失的一侧，套餐名照常', async () => {
    const subscriptions = makeSubscriptionsCreate('sub-2', 't-ghost', 'plan-1');
    const store = makeStore({
      // 名称缺失 ≠ 租户不存在（软删/改名历史行）：存在性由 findTenantStatus 回答
      findTenantStatus: vi.fn(async () => 'active'),
      findTenantName: vi.fn(async () => null),
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'pro', name: '专业版' })),
    });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    await controller.createSubscription({ tenantId: 't-ghost', planCode: 'pro' } as never, undefined as never);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create',
      expect.objectContaining({ tenantId: 't-ghost', targetId: 'sub-2', targetLabel: '名称快照缺失（ID: t-ghost） · 专业版' }),
    );
  });

  it('订阅取消：target_label = 取消后订阅行的 租户名 · 套餐名', async () => {
    const subscriptions = { cancel: vi.fn(async () => undefined) };
    const store = makeStore({
      findSubscriptionById: vi.fn(async () => ({ id: 'sub-9', tenantId: 't1', planId: 'plan-1' })),
      findTenantName: vi.fn(async () => '示例企业'),
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'pro', name: '专业版' })),
    });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    await controller.cancelSubscription('sub-9', { reason: '客户降级' } as never, undefined as never);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.cancel',
      expect.objectContaining({ tenantId: 't1', targetId: 'sub-9', targetLabel: '示例企业 · 专业版' }),
    );
  });

  it('配额超限（4029）：target_label = 租户名', async () => {
    const usage = {
      record: vi.fn(async () => {
        throw new BizError(ErrorCode.QUOTA_EXCEEDED, '配额已达上限（api_calls）');
      }),
    };
    const store = makeStore({ findTenantName: vi.fn(async () => '示例企业') });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, usage as never, {} as never, AUDIT as never);
    await expect(
      controller.recordUsageEvent('t1', { quotaKey: 'api_calls', quantity: 1, idempotencyKey: 'k1' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.quota.exceeded',
      expect.objectContaining({ tenantId: 't1', targetId: 't1', targetLabel: '示例企业', result: 'denied' }),
    );
  });

  it('配额超限（4029）：租户名取不到 → 缺失标记', async () => {
    const usage = {
      record: vi.fn(async () => {
        throw new BizError(ErrorCode.QUOTA_EXCEEDED, '配额已达上限（api_calls）');
      }),
    };
    const store = makeStore({ findTenantName: vi.fn(async () => null) });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, usage as never, {} as never, AUDIT as never);
    await expect(
      controller.recordUsageEvent('t-ghost', { quotaKey: 'api_calls', quantity: 1, idempotencyKey: 'k2' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.quota.exceeded',
      expect.objectContaining({ tenantId: 't-ghost', targetId: 't-ghost', targetLabel: '名称快照缺失（ID: t-ghost）' }),
    );
  });

  it('生命周期迁移（成功 + 非法 4030）：target_label = 租户名', async () => {
    const lifecycle = { transition: vi.fn(async () => ({ from: 'active', to: 'frozen', alreadyApplied: false })) };
    const store = makeStore({ findTenantName: vi.fn(async () => '示例企业') });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, {} as never, lifecycle as never, AUDIT as never);
    await controller.transition('t1', { action: 'freeze', reason: '欠费' } as never, undefined as never);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.freeze',
      expect.objectContaining({ tenantId: 't1', targetId: 't1', targetLabel: '示例企业' }),
    );

    const invalidLifecycle = {
      transition: vi.fn(async () => {
        throw new BizError(ErrorCode.LIFECYCLE_TRANSITION_INVALID, '非法迁移：active -> resume');
      }),
    };
    const store2 = makeStore({ findTenantName: vi.fn(async () => '示例企业') });
    const controller2 = new SaasOpsController(store2, makePlans() as never, {} as never, {} as never, {} as never, invalidLifecycle as never, AUDIT as never);
    await expect(controller2.transition('t2', { action: 'resume' } as never, undefined as never)).rejects.toMatchObject({
      code: ErrorCode.LIFECYCLE_TRANSITION_INVALID,
    });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.invalid',
      expect.objectContaining({ targetId: 't2', targetLabel: '示例企业', result: 'denied' }),
    );
  });

  it('生命周期迁移：租户名取不到 → 缺失标记', async () => {
    const lifecycle = { transition: vi.fn(async () => ({ from: 'pending', to: 'active', alreadyApplied: false })) };
    const store = makeStore({ findTenantName: vi.fn(async () => null) });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, {} as never, lifecycle as never, AUDIT as never);
    await controller.transition('t-ghost', { action: 'activate' } as never, undefined as never);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.activate',
      expect.objectContaining({ tenantId: 't-ghost', targetId: 't-ghost', targetLabel: '名称快照缺失（ID: t-ghost）' }),
    );
  });
});

describe('SaasOpsController 名称快照故障注入降级（P1 加固：旁路查询不得反向决定业务成败）', () => {
  /** 订阅领域服务 create 桩（返回带 tenantId/planId 的订阅行，与上层 describe 同型） */
  function makeSubscriptionsCreate(subId: string, tenantId: string, planId: string) {
    return {
      create: vi.fn(async () => ({ id: subId, tenantId, planId, planVersionId: 'pv-1', status: 'active', effectiveAt: new Date(), expireAt: null, closedAt: null, reason: null })),
    };
  }

  /**
   * 恒抛的 store 查询桩：模拟库抖动 / 连接池耗尽 / 驱动缺陷。
   * 与「查不到返回 null」是两回事——null 走缺失标记，抛异常必须被捕获降级，
   * 否则业务写入成功后的名称解析会把已提交操作变成失败响应。
   */
  const boom = () =>
    vi.fn(async () => {
      throw new Error('injected: db unavailable');
    });

  it('套餐发布：findPlanById 抛异常 → 发布照常成功，审计落缺失标记（已发布不变失败响应）', async () => {
    const plans = makePlans();
    const store = makeStore({ findPlanById: boom() });
    const r = (await makeController(store, plans).publishPlanVersion('plan-1', { quotas: [{ quotaKey: 'api_calls', limitValue: 500 }] })) as { version: number };
    expect(r.version).toBe(3); // 业务成功不被名称查询失败覆盖
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.plan.publish',
      expect.objectContaining({ targetId: 'plan-1', targetLabel: '名称快照缺失（ID: plan-1）' }),
    );
  });

  it('订阅开通：findTenantName 抛异常 → 开通照常成功，仅租户侧缺失标记', async () => {
    const subscriptions = makeSubscriptionsCreate('sub-1', 't1', 'plan-1');
    const store = makeStore({
      findTenantStatus: vi.fn(async () => 'active'),
      findTenantName: boom(),
      findPlanById: vi.fn(async () => ({ id: 'plan-1', code: 'pro', name: '专业版' })),
    });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    const r = (await controller.createSubscription({ tenantId: 't1', planCode: 'pro' } as never, undefined as never)) as { id: string };
    expect(r.id).toBe('sub-1');
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create',
      expect.objectContaining({ targetId: 'sub-1', targetLabel: '名称快照缺失（ID: t1） · 专业版' }),
    );
  });

  it('订阅开通：findPlanById 抛异常 → 开通照常成功，仅套餐侧缺失标记', async () => {
    const subscriptions = makeSubscriptionsCreate('sub-2', 't1', 'plan-1');
    const store = makeStore({
      findTenantStatus: vi.fn(async () => 'active'),
      findTenantName: vi.fn(async () => '示例企业'),
      findPlanById: boom(),
    });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    const r = (await controller.createSubscription({ tenantId: 't1', planCode: 'pro' } as never, undefined as never)) as { id: string };
    expect(r.id).toBe('sub-2');
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.create',
      expect.objectContaining({ targetId: 'sub-2', targetLabel: '示例企业 · 名称快照缺失（ID: plan-1）' }),
    );
  });

  it('订阅取消：findSubscriptionById 抛异常 → 取消照常成功，落缺失标记', async () => {
    const subscriptions = { cancel: vi.fn(async () => undefined) };
    const store = makeStore({ findSubscriptionById: boom() });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    const r = (await controller.cancelSubscription('sub-9', { reason: '客户降级' } as never, undefined as never)) as { cancelled: boolean };
    expect(r).toEqual({ id: 'sub-9', cancelled: true }); // 已取消是事实，重试只会重复取消
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.cancel',
      expect.objectContaining({ targetId: 'sub-9', targetLabel: '名称快照缺失（ID: sub-9）' }),
    );
  });

  it('订阅取消：两侧名称解析均抛异常 → 取消照常成功，落双侧缺失标记', async () => {
    const subscriptions = { cancel: vi.fn(async () => undefined) };
    const store = makeStore({
      findSubscriptionById: vi.fn(async () => ({ id: 'sub-9', tenantId: 't1', planId: 'plan-1' })),
      findTenantName: boom(),
      findPlanById: boom(),
    });
    const controller = new SaasOpsController(store, makePlans() as never, subscriptions as never, {} as never, {} as never, {} as never, AUDIT as never);
    const r = (await controller.cancelSubscription('sub-9', { reason: '客户降级' } as never, undefined as never)) as { cancelled: boolean };
    expect(r.cancelled).toBe(true);
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.subscription.cancel',
      expect.objectContaining({ targetLabel: '名称快照缺失（ID: t1） · 名称快照缺失（ID: plan-1）' }),
    );
  });

  it('生命周期迁移成功：findTenantName 抛异常 → 迁移照常成功，落缺失标记', async () => {
    const lifecycle = { transition: vi.fn(async () => ({ from: 'active', to: 'frozen', alreadyApplied: false })) };
    const store = makeStore({ findTenantName: boom() });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, {} as never, lifecycle as never, AUDIT as never);
    const r = (await controller.transition('t1', { action: 'freeze', reason: '欠费' } as never, undefined as never)) as { to: string };
    expect(r.to).toBe('frozen');
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.freeze',
      expect.objectContaining({ targetId: 't1', targetLabel: '名称快照缺失（ID: t1）' }),
    );
  });

  it('非法迁移 4030：findTenantName 抛异常 → 原始 4030 原样抛出（旁路不覆盖业务错误），denial 落缺失标记', async () => {
    const lifecycle = {
      transition: vi.fn(async () => {
        throw new BizError(ErrorCode.LIFECYCLE_TRANSITION_INVALID, '非法迁移：active -> resume');
      }),
    };
    const store = makeStore({ findTenantName: boom() });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, {} as never, lifecycle as never, AUDIT as never);
    await expect(controller.transition('t1', { action: 'resume' } as never, undefined as never)).rejects.toMatchObject({
      code: ErrorCode.LIFECYCLE_TRANSITION_INVALID,
      message: '非法迁移：active -> resume',
    });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.lifecycle.invalid',
      expect.objectContaining({ targetId: 't1', targetLabel: '名称快照缺失（ID: t1）', result: 'denied' }),
    );
  });

  it('配额超限 4029：findTenantName 抛异常 → 原始 4029 原样抛出，审计落缺失标记', async () => {
    const usage = {
      record: vi.fn(async () => {
        throw new BizError(ErrorCode.QUOTA_EXCEEDED, '配额已达上限（api_calls）');
      }),
    };
    const store = makeStore({ findTenantName: boom() });
    const controller = new SaasOpsController(store, makePlans() as never, {} as never, {} as never, usage as never, {} as never, AUDIT as never);
    await expect(
      controller.recordUsageEvent('t1', { quotaKey: 'api_calls', quantity: 1, idempotencyKey: 'k3' } as never, undefined as never),
    ).rejects.toMatchObject({ code: ErrorCode.QUOTA_EXCEEDED, message: '配额已达上限（api_calls）' });
    expect(AUDIT.recordEvent).toHaveBeenCalledWith(
      'saas.quota.exceeded',
      expect.objectContaining({ targetId: 't1', targetLabel: '名称快照缺失（ID: t1）', result: 'denied' }),
    );
  });
});
