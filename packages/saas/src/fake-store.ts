/*
 * @file 内存 Fake 驱动（测试用 SaasStore 实现）
 * @description 以内存结构实现 store.port 的全部语义不变量：幂等键去重、条件更新、
 *   active_marker 唯一、窗口行唯一初始化。用于领域逻辑单测；真竞态语义由 Prisma 驱动在
 *   集成层验证（ADR-0030 竞态测试随 example-api 批次入 CI）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import type {
  ConsumeOutcome,
  LifecycleLog,
  LifecycleStatus,
  PlanQuotaView,
  PlanView,
  PlanVersionView,
  QuotaDefinitionView,
  SubscriptionView,
  TenantQuotaOverride,
  UsageEventInput,
  UsageRollupView,
} from './types.js';
import type { SaasStore } from './store.port.js';

interface WindowRow {
  tenantId: string;
  quotaKey: string;
  windowType: string;
  windowStart: number;
  used: bigint;
  limitValue: bigint;
  execution: string;
  warnedAt: Date | null;
}

export class FakeSaasStore implements SaasStore {
  plans = new Map<string, PlanView>();
  versions = new Map<string, PlanVersionView>();
  planQuotas: PlanQuotaView[] = [];
  quotaDefs = new Map<string, QuotaDefinitionView>();
  subscriptions: Array<SubscriptionView & { activeMarker: string | null }> = [];
  tenantQuotas = new Map<string, TenantQuotaOverride>(); // key: tenantId|quotaKey
  windows = new Map<string, WindowRow>(); // key: tenantId|quotaKey|windowType|windowStart
  events = new Map<string, UsageEventInput>(); // key: idempotencyKey
  rollups = new Map<string, UsageRollupView>();
  tenantStatus = new Map<string, LifecycleStatus>();
  logs: LifecycleLog[] = [];

  private planSeq = 0;
  private versionSeq = 0;
  private subSeq = 0;
  private windowKey(t: string, q: string, w: string, s: Date): string {
    return `${t}|${q}|${w}|${s.getTime()}`;
  }

  // ---- PlanStore ----
  async listPlans(): Promise<PlanView[]> {
    return [...this.plans.values()];
  }
  async findPlanByCode(code: string): Promise<PlanView | null> {
    return [...this.plans.values()].find((p) => p.code === code) ?? null;
  }
  async findPlanById(id: string): Promise<PlanView | null> {
    return this.plans.get(id) ?? null;
  }
  async createPlan(plan: { code: string; name: string; description?: string | null }): Promise<PlanView> {
    const id = `plan-${++this.planSeq}`;
    const view: PlanView = { id, code: plan.code, name: plan.name, description: plan.description ?? null };
    this.plans.set(id, view);
    return view;
  }
  async listVersions(planId: string): Promise<PlanVersionView[]> {
    return [...this.versions.values()].filter((v) => v.planId === planId);
  }
  async findVersionById(id: string): Promise<PlanVersionView | null> {
    return this.versions.get(id) ?? null;
  }
  async findVersion(planId: string, version: number): Promise<PlanVersionView | null> {
    return [...this.versions.values()].find((v) => v.planId === planId && v.version === version) ?? null;
  }
  async createVersion(v: { planId: string; version: number; remark?: string | null; publishedAt: Date }): Promise<PlanVersionView> {
    const id = `pv-${++this.versionSeq}`;
    const view: PlanVersionView = { id, planId: v.planId, version: v.version, status: 'published', remark: v.remark ?? null, publishedAt: v.publishedAt };
    this.versions.set(id, view);
    return view;
  }
  async listPlanQuotas(planVersionId: string): Promise<PlanQuotaView[]> {
    return this.planQuotas.filter((q) => q.planVersionId === planVersionId);
  }
  async findPlanQuota(planVersionId: string, quotaKey: string): Promise<PlanQuotaView | null> {
    return this.planQuotas.find((q) => q.planVersionId === planVersionId && q.quotaKey === quotaKey) ?? null;
  }
  async upsertPlanQuota(q: { planVersionId: string; quotaKey: string; limitValue: bigint; execution: PlanQuotaView['execution'] }): Promise<void> {
    const idx = this.planQuotas.findIndex((x) => x.planVersionId === q.planVersionId && x.quotaKey === q.quotaKey);
    const row: PlanQuotaView = { planVersionId: q.planVersionId, quotaKey: q.quotaKey, limitValue: q.limitValue, execution: q.execution };
    if (idx >= 0) this.planQuotas[idx] = row;
    else this.planQuotas.push(row);
  }
  async upsertQuotaDefinition(d: QuotaDefinitionView): Promise<void> {
    this.quotaDefs.set(d.key, d);
  }
  async findQuotaDefinition(key: string): Promise<QuotaDefinitionView | null> {
    return this.quotaDefs.get(key) ?? null;
  }

  // ---- SubscriptionStore ----
  async findActiveSubscription(tenantId: string): Promise<SubscriptionView | null> {
    return this.subscriptions.find((s) => s.tenantId === tenantId && s.status === 'active') ?? null;
  }
  async findSubscriptionById(id: string): Promise<SubscriptionView | null> {
    return this.subscriptions.find((s) => s.id === id) ?? null;
  }
  async createSubscription(s: { tenantId: string; planId: string; planVersionId: string; effectiveAt: Date; expireAt?: Date | null; activeMarker: string | null }): Promise<SubscriptionView> {
    if (s.activeMarker !== null && this.subscriptions.some((x) => x.activeMarker === s.activeMarker)) {
      throw new Error('UNIQUE(active_marker)'); // fw-allow-raw-throw: ②类内部信号——active_marker 唯一约束模拟（服务层先行校验，此为兜底）
    }
    const view = {
      id: `sub-${++this.subSeq}`,
      tenantId: s.tenantId,
      planId: s.planId,
      planVersionId: s.planVersionId,
      status: 'active' as const,
      effectiveAt: s.effectiveAt,
      expireAt: s.expireAt ?? null,
      closedAt: null as Date | null,
      reason: null as string | null,
      activeMarker: s.activeMarker,
    };
    this.subscriptions.push(view);
    return view;
  }
  async closeSubscription(id: string, patch: { status: 'expired' | 'cancelled'; reason?: string | null; closedAt: Date }): Promise<void> {
    const sub = this.subscriptions.find((s) => s.id === id);
    if (sub) {
      sub.status = patch.status;
      sub.closedAt = patch.closedAt;
      sub.reason = patch.reason ?? null;
      sub.activeMarker = null;
    }
  }
  async listActiveSubscriptionsExpiredAt(cutoff: Date): Promise<Array<{ id: string; tenantId: string; expireAt: Date | null }>> {
    return this.subscriptions
      .filter((s) => s.status === 'active' && s.expireAt != null && s.expireAt < cutoff)
      .map((s) => ({ id: s.id, tenantId: s.tenantId, expireAt: s.expireAt ?? null }));
  }
  async listGraceTenantsPastGrace(cutoff: Date): Promise<Array<{ id: string; tenantId: string }>> {
    return this.subscriptions
      .filter((s) => s.status === 'expired' && s.expireAt != null && s.expireAt < cutoff && this.tenantStatus.get(s.tenantId) === 'grace')
      .map((s) => ({ id: s.id, tenantId: s.tenantId }));
  }

  // ---- QuotaStore ----
  async findTenantQuotaOverride(tenantId: string, quotaKey: string): Promise<TenantQuotaOverride | null> {
    return this.tenantQuotas.get(`${tenantId}|${quotaKey}`) ?? null;
  }
  async upsertTenantQuota(o: TenantQuotaOverride): Promise<void> {
    this.tenantQuotas.set(`${o.tenantId}|${o.quotaKey}`, o);
  }
  async listTenantQuotaOverrides(tenantId: string): Promise<TenantQuotaOverride[]> {
    return [...this.tenantQuotas.values()].filter((o) => o.tenantId === tenantId);
  }
  async consumeAtomic(event: UsageEventInput, limit: bigint, execution: 'soft' | 'hard' | 'observe'): Promise<ConsumeOutcome> {
    // ① 幂等去重：唯一键冲突 → deduped，不扣减
    if (this.events.has(event.idempotencyKey)) return { result: 'deduped' };
    if (execution === 'observe') {
      this.events.set(event.idempotencyKey, event);
      return { result: 'ok', used: 0n, limit };
    }
    const def = this.quotaDefs.get(event.quotaKey);
    const windowType = def?.windowType ?? 'day';
    const ws = this.dayStart(event.occurredAt, windowType);
    const key = this.windowKey(event.tenantId, event.quotaKey, windowType, ws);
    let row = this.windows.get(key);
    if (!row) {
      row = { tenantId: event.tenantId, quotaKey: event.quotaKey, windowType, windowStart: ws.getTime(), used: 0n, limitValue: limit, execution, warnedAt: null };
      this.windows.set(key, row);
    }
    // ③ 条件更新：used + qty <= limit 才生效
    if (row.used + event.quantity > limit) {
      return { result: 'exceeded', used: row.used, limit };
    }
    row.used += event.quantity;
    this.events.set(event.idempotencyKey, event);
    return { result: 'ok', used: row.used, limit };
  }
  async findWindow(tenantId: string, quotaKey: string, windowType: string, windowStart: Date) {
    const row = this.windows.get(this.windowKey(tenantId, quotaKey, windowType, windowStart));
    return row ? { used: row.used, limitValue: row.limitValue, execution: row.execution, warnedAt: row.warnedAt } : null;
  }
  async markWarned(tenantId: string, quotaKey: string, windowType: string, windowStart: Date, at: Date): Promise<boolean> {
    const row = this.windows.get(this.windowKey(tenantId, quotaKey, windowType, windowStart));
    if (!row || row.warnedAt !== null) return false;
    row.warnedAt = at;
    return true;
  }

  // ---- UsageStore ----
  async listEvents(tenantId: string, quotaKey: string, from: Date, to: Date) {
    return [...this.events.values()]
      .filter((e) => e.tenantId === tenantId && e.quotaKey === quotaKey && e.occurredAt >= from && e.occurredAt < to)
      .map((e) => ({ quantity: e.quantity, occurredAt: e.occurredAt }));
  }
  async upsertRollup(r: UsageRollupView): Promise<void> {
    this.rollups.set(`${r.tenantId}|${r.quotaKey}|${r.windowType}|${r.windowStart.getTime()}`, r);
  }
  async findRollup(tenantId: string, quotaKey: string, windowType: string, windowStart: Date): Promise<UsageRollupView | null> {
    return this.rollups.get(`${tenantId}|${quotaKey}|${windowType}|${windowStart.getTime()}`) ?? null;
  }

  // ---- LifecycleStore ----
  async findTenantStatus(tenantId: string): Promise<LifecycleStatus | null> {
    return this.tenantStatus.get(tenantId) ?? null;
  }
  async conditionalUpdateStatus(tenantId: string, from: LifecycleStatus, to: LifecycleStatus): Promise<boolean> {
    if (this.tenantStatus.get(tenantId) !== from) return false;
    this.tenantStatus.set(tenantId, to);
    return true;
  }
  async appendLifecycleLog(log: LifecycleLog): Promise<void> {
    this.logs.push(log);
  }
  async listLifecycleLogs(tenantId: string): Promise<LifecycleLog[]> {
    return this.logs.filter((l) => l.tenantId === tenantId);
  }

  private dayStart(at: Date, windowType: string): Date {
    if (windowType === 'total') return new Date(0);
    if (windowType === 'month') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
}
