/*
 * @file SaasStore 端口
 * @description M13 持久化端口（ADR-0029~0031）：领域服务只依赖本端口，具体驱动由接入方提供
 *   （example-api 接 Prisma 实现 + 事务；测试用内存 Fake）。方法面按「一方法一不变量」设计：
 *   涉及并发/幂等语义的方法在注释中写明驱动必须遵守的约束（与 ADR 逐条对应）。
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

/** 套餐与版本存储面（版本发布后不可变：本端口故意不提供版本更新方法） */
export interface PlanStore {
  listPlans(): Promise<PlanView[]>;
  findPlanByCode(code: string): Promise<PlanView | null>;
  findPlanById(id: string): Promise<PlanView | null>;
  createPlan(plan: { code: string; name: string; description?: string | null }): Promise<PlanView>;
  listVersions(planId: string): Promise<PlanVersionView[]>;
  findVersionById(id: string): Promise<PlanVersionView | null>;
  findVersion(planId: string, version: number): Promise<PlanVersionView | null>;
  createVersion(v: { planId: string; version: number; remark?: string | null; publishedAt: Date }): Promise<PlanVersionView>;
  listPlanQuotas(planVersionId: string): Promise<PlanQuotaView[]>;
  findPlanQuota(planVersionId: string, quotaKey: string): Promise<PlanQuotaView | null>;
  upsertPlanQuota(q: { planVersionId: string; quotaKey: string; limitValue: bigint; execution: PlanQuotaView['execution'] }): Promise<void>;
  upsertQuotaDefinition(d: QuotaDefinitionView): Promise<void>;
  findQuotaDefinition(key: string): Promise<QuotaDefinitionView | null>;
}

/** 订阅存储面（一租户至多一个 active 由 active_marker 唯一索引兜底，服务层先行校验） */
export interface SubscriptionStore {
  findActiveSubscription(tenantId: string): Promise<SubscriptionView | null>;
  findSubscriptionById(id: string): Promise<SubscriptionView | null>;
  createSubscription(s: {
    tenantId: string;
    planId: string;
    planVersionId: string;
    effectiveAt: Date;
    expireAt?: Date | null;
    activeMarker: string | null;
  }): Promise<SubscriptionView>;
  /** 关闭订阅：status ∈ {expired, cancelled}，同时置 activeMarker=NULL 与 closedAt */
  closeSubscription(id: string, patch: { status: 'expired' | 'cancelled'; reason?: string | null; closedAt: Date }): Promise<void>;
  /** 到期扫描（ADR-0031 §2.3）：status=active 且 expireAt < cutoff 的订阅（含 tenantId，供任务逐条迁移） */
  listActiveSubscriptionsExpiredAt(cutoff: Date): Promise<Array<{ id: string; tenantId: string; expireAt: Date | null }>>;
  /** 宽限期满扫描：status=expired 且租户当前态为 grace 且 expireAt < cutoff 的订阅 */
  listGraceTenantsPastGrace(cutoff: Date): Promise<Array<{ id: string; tenantId: string }>>;
}

/** 配额存储面（生效值解析与窗口扣减；字典查询同时挂在 PlanStore 与本面，SaasStore 聚合去重） */
export interface QuotaStore {
  findQuotaDefinition(key: string): Promise<QuotaDefinitionView | null>;
  findTenantQuotaOverride(tenantId: string, quotaKey: string): Promise<TenantQuotaOverride | null>;
  upsertTenantQuota(o: TenantQuotaOverride): Promise<void>;
  listTenantQuotaOverrides(tenantId: string): Promise<TenantQuotaOverride[]>;

  /**
   * 原子扣减（ADR-0030 §2.1/§2.5，驱动实现不变量）：
   * ① INSERT usage_events（idempotency_key 唯一约束）→ 冲突即 {result:'deduped'}（不扣减）；
   * ② execution=observe 时仅①（留痕不判限不建窗口行）；
   * ③ 窗口行不存在则初始化（撞唯一键 → 重读重试一次）；
   * ④ UPDATE ... SET used = used + qty WHERE used + qty <= limit_value——affected=0 即 {result:'exceeded'}；
   * ③④① 须在同一事务：exceeded 时事件一并回滚（不留痕不扣减），deduped 时不触碰窗口。
   */
  consumeAtomic(event: UsageEventInput, limit: bigint, execution: 'soft' | 'hard' | 'observe'): Promise<ConsumeOutcome>;

  findWindow(tenantId: string, quotaKey: string, windowType: string, windowStart: Date): Promise<
    { used: bigint; limitValue: bigint; execution: string; warnedAt: Date | null } | null
  >;
  /** 软限额同窗幂等告警标记：仅当 warned_at IS NULL 时写入并返回 true */
  markWarned(tenantId: string, quotaKey: string, windowType: string, windowStart: Date, at: Date): Promise<boolean>;
}

/** 用量汇总存储面（rollup 与 events 的重算闭环，AC-13-06） */
export interface UsageStore {
  listEvents(tenantId: string, quotaKey: string, from: Date, to: Date): Promise<Array<{ quantity: bigint; occurredAt: Date }>>;
  upsertRollup(r: UsageRollupView): Promise<void>;
  findRollup(tenantId: string, quotaKey: string, windowType: string, windowStart: Date): Promise<UsageRollupView | null>;
}

/** 生命周期存储面（条件更新即幂等：正确性不依赖分布式锁，ADR-0031 §2.3） */
export interface LifecycleStore {
  findTenantStatus(tenantId: string): Promise<LifecycleStatus | null>;
  /** UPDATE tenants SET status=:to WHERE id=:id AND status=:from —— 返回 affected === 1 */
  conditionalUpdateStatus(tenantId: string, from: LifecycleStatus, to: LifecycleStatus): Promise<boolean>;
  appendLifecycleLog(log: LifecycleLog): Promise<void>;
  listLifecycleLogs(tenantId: string): Promise<LifecycleLog[]>;
}

/** SaaS 运营基础存储端口聚合 */
export interface SaasStore extends PlanStore, SubscriptionStore, QuotaStore, UsageStore, LifecycleStore {}
