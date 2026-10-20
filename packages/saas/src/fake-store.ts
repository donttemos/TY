/*
 * @file 内存 Fake 驱动（测试用 SaasStore 实现）
 * @description 以内存结构实现 store.port 的全部语义不变量：幂等键去重、条件更新、
 *   active_marker 唯一、窗口行唯一初始化、订阅与配额快照的单事务原子性（含故障注入点）。
 *   用于领域逻辑单测；真竞态语义由 Prisma 驱动在集成层验证（ADR-0030 竞态测试随 example-api 批次入 CI）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 donttemo createSubscriptionWithSnapshot 落地「全成/全败」语义 + faultQuotaWriteAt 故障注入
 * @modified 2026-10-21 donttemo P1（PRD-015 FR-15-10 收口）：补 findTenantName（tenantNames 映射）
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
  /** 租户名（审计名称快照查询用；与 tenantStatus 分工：状态回答「在不在」，名称回答「叫什么」） */
  tenantNames = new Map<string, string>();
  logs: LifecycleLog[] = [];

  private planSeq = 0;
  private versionSeq = 0;
  private subSeq = 0;

  /**
   * 故障注入点（仅测试用）：原子写第 n 条配额快照行时抛错（n 从 1 计，null=关闭）。
   * 语义 = 驱动事务里「订阅行已 INSERT、前 n-1 条快照已 upsert」后失败——
   * 断言用：异常抛出后必须整体回滚（无订阅行、无任何快照行、active_marker 不残留）。
   */
  faultQuotaWriteAt: number | null = null;

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
  async createSubscriptionWithSnapshot(
    s: { tenantId: string; planId: string; planVersionId: string; effectiveAt: Date; expireAt?: Date | null; activeMarker: string | null },
    quotas: TenantQuotaOverride[],
  ): Promise<SubscriptionView> {
    // 事务前像：任一步失败即整体回滚（与 Prisma 驱动 $transaction 的全成/全败同语义）
    const subsBefore = this.subscriptions.slice();
    const quotasBefore = new Map(this.tenantQuotas);
    const subSeqBefore = this.subSeq;
    try {
      const view = this.insertSubscriptionRow(s);
      let written = 0;
      for (const q of quotas) {
        written += 1;
        if (this.faultQuotaWriteAt === written) {
          throw new Error(`FAULT_INJECTED：配额快照第 ${written} 条（${q.quotaKey}）写入失败`); // fw-allow-raw-throw: ②类测试信号——故障注入点，仅测试开启
        }
        this.tenantQuotas.set(`${q.tenantId}|${q.quotaKey}`, q);
      }
      return view;
    } catch (e) {
      this.subscriptions = subsBefore;
      this.tenantQuotas = quotasBefore;
      this.subSeq = subSeqBefore;
      throw e;
    }
  }

  /** 订阅行追加（唯一写入 active 订阅的内存入口；active_marker 唯一校验在服务层之前兜底） */
  private insertSubscriptionRow(s: {
    tenantId: string;
    planId: string;
    planVersionId: string;
    effectiveAt: Date;
    expireAt?: Date | null;
    activeMarker: string | null;
  }): SubscriptionView {
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
  async listSubscriptions(
    filter: {
      tenantId?: string;
      planId?: string;
      status?: SubscriptionView['status'];
      expireFrom?: Date | null;
      expireTo?: Date | null;
    },
    page: { page: number; pageSize: number },
  ): Promise<{ items: SubscriptionView[]; total: number }> {
    const rows = this.filterSubscriptions(filter);
    const sorted = this.sortSubscriptions(rows);
    const start = (page.page - 1) * page.pageSize;
    return { items: sorted.slice(start, start + page.pageSize), total: sorted.length };
  }
  async listSubscriptionsByTenant(tenantId: string): Promise<SubscriptionView[]> {
    return this.sortSubscriptions(this.filterSubscriptions({ tenantId }));
  }
  /** 列表过滤（与 Prisma 实现同语义：过滤字段白名单内的等值 + 到期范围） */
  private filterSubscriptions(filter: { tenantId?: string; planId?: string; status?: SubscriptionView['status']; expireFrom?: Date | null; expireTo?: Date | null }) {
    return this.subscriptions.filter((s) => {
      if (filter.tenantId !== undefined && s.tenantId !== filter.tenantId) return false;
      if (filter.planId !== undefined && s.planId !== filter.planId) return false;
      if (filter.status !== undefined && s.status !== filter.status) return false;
      if (filter.expireFrom != null && (s.expireAt == null || s.expireAt < filter.expireFrom)) return false;
      if (filter.expireTo != null && (s.expireAt == null || s.expireAt > filter.expireTo)) return false;
      return true;
    });
  }
  /** 排序固定：effectiveAt desc + id asc（主键 tie-breaker，与 Prisma 实现一致） */
  private sortSubscriptions(rows: Array<SubscriptionView & { activeMarker: string | null }>) {
    return [...rows].sort((a, b) => {
      const t = b.effectiveAt.getTime() - a.effectiveAt.getTime();
      return t !== 0 ? t : a.id.localeCompare(b.id);
    });
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
  async listWindows(windowType: string, windowStart: Date): Promise<Array<{ tenantId: string; quotaKey: string; used: bigint; limitValue: bigint; execution: string }>> {
    return [...this.windows.values()]
      .filter((w) => w.windowType === windowType && w.windowStart === windowStart.getTime())
      .map((w) => ({ tenantId: w.tenantId, quotaKey: w.quotaKey, used: w.used, limitValue: w.limitValue, execution: w.execution }));
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

  async findTenantName(tenantId: string): Promise<string | null> {
    return this.tenantNames.get(tenantId) ?? null;
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
  async countTenantsByStatus(status: LifecycleStatus): Promise<number> {
    let n = 0;
    for (const s of this.tenantStatus.values()) if (s === status) n++;
    return n;
  }
  async listRecentLifecycleLogs(limit: number): Promise<LifecycleLog[]> {
    return [...this.logs].sort((a, b) => b.at.getTime() - a.at.getTime()).slice(0, limit);
  }

  private dayStart(at: Date, windowType: string): Date {
    if (windowType === 'total') return new Date(0);
    if (windowType === 'month') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
}
