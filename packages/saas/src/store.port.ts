/*
 * @file SaasStore 端口
 * @description M13 持久化端口（ADR-0029~0031）：领域服务只依赖本端口，具体驱动由接入方提供
 *   （example-api 接 Prisma 实现 + 事务；测试用内存 Fake）。方法面按「一方法一不变量」设计：
 *   涉及并发/幂等语义的方法在注释中写明驱动必须遵守的约束（与 ADR 逐条对应）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-20 donttemo 订阅开通收敛为 createSubscriptionWithSnapshot（订阅 + 配额快照单事务），
 *   移除可被误用的单步 createSubscription
 * @modified 2026-10-21 donttemo P1（PRD-015 FR-15-10 收口）：LifecycleStore 新增 findTenantName
 *   （租户名称快照查询），供审计写入点把 tenantId 还原为租户名
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
  /**
   * 订阅创建 + 版本配额快照（**单事务原子**，ADR-0029 §2.5）：
   * 驱动必须在同一事务内写入 ① 订阅行 ② quotas 的全部 tenant_quotas 行；
   * 任一写入失败 → 整体回滚，**不得**留下「订阅已生效、快照缺失/不完整」的半程状态。
   * active_marker 唯一冲突 → CONFLICT 1003（与既有「一租户一生效订阅」口径一致）。
   * quotas 由服务层按 plan_quotas 快照生成（source=plan_snapshot）；空数组表示该版本无配额项。
   *
   * 端口故意**不提供**「只写订阅、稍后补快照」的入口：订阅生效与权益快照是同一不变量，
   * 拆两步就必然存在可观测的中间态（旧实现即在此基础上留下半成品订阅）。
   */
  createSubscriptionWithSnapshot(
    s: {
      tenantId: string;
      planId: string;
      planVersionId: string;
      effectiveAt: Date;
      expireAt?: Date | null;
      activeMarker: string | null;
    },
    quotas: TenantQuotaOverride[],
  ): Promise<SubscriptionView>;
  /** 关闭订阅：status ∈ {expired, cancelled}，同时置 activeMarker=NULL 与 closedAt */
  closeSubscription(id: string, patch: { status: 'expired' | 'cancelled'; reason?: string | null; closedAt: Date }): Promise<void>;
  /** 到期扫描（ADR-0031 §2.3）：status=active 且 expireAt < cutoff 的订阅（含 tenantId，供任务逐条迁移） */
  listActiveSubscriptionsExpiredAt(cutoff: Date): Promise<Array<{ id: string; tenantId: string; expireAt: Date | null }>>;
  /** 宽限期满扫描：status=expired 且租户当前态为 grace 且 expireAt < cutoff 的订阅 */
  listGraceTenantsPastGrace(cutoff: Date): Promise<Array<{ id: string; tenantId: string }>>;
  /**
   * 订阅分页列表（M14/PRD-014 FR-14-07，运营面）：过滤参数全部可选；
   * 排序固定 effectiveAt desc + id asc（主键 tie-breaker，分页稳定）；过滤字段白名单见控制器。
   */
  listSubscriptions(
    filter: {
      tenantId?: string;
      planId?: string;
      status?: SubscriptionView['status'];
      /** expireAt >= expireFrom（expireAt 为 null 的行不命中范围过滤） */
      expireFrom?: Date | null;
      /** expireAt <= expireTo */
      expireTo?: Date | null;
    },
    page: { page: number; pageSize: number },
  ): Promise<{ items: SubscriptionView[]; total: number }>;
  /** 租户订阅历史（完整列表，含 cancelled/expired；排序同上） */
  listSubscriptionsByTenant(tenantId: string): Promise<SubscriptionView[]>;
}

/** 配额存储面（生效值解析与窗口扣减；字典查询同时挂在 PlanStore 与本面，SaasStore 聚合去重） */
export interface QuotaStore {
  findQuotaDefinition(key: string): Promise<QuotaDefinitionView | null>;
  findTenantQuotaOverride(tenantId: string, quotaKey: string): Promise<TenantQuotaOverride | null>;
  /** 单行覆盖写入（手工覆盖 / 后台改额）；**订阅开通的快照写入不走这里**——必须随订阅同事务 */
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
  /**
   * 运营看板（M14/PRD-014 FR-14-12/14）：指定窗口类型与起点下的全部窗口行
   * （基数 = 租户×指标，量级可控；OQ-14-3 定案：查询时聚合，不建聚合表）。
   */
  listWindows(windowType: string, windowStart: Date): Promise<Array<{ tenantId: string; quotaKey: string; used: bigint; limitValue: bigint; execution: string }>>;
}

/** 用量汇总存储面（rollup 与 events 的重算闭环，AC-13-06） */
export interface UsageStore {
  listEvents(tenantId: string, quotaKey: string, from: Date, to: Date): Promise<Array<{ quantity: bigint; occurredAt: Date }>>;
  upsertRollup(r: UsageRollupView): Promise<void>;
  findRollup(tenantId: string, quotaKey: string, windowType: string, windowStart: Date): Promise<UsageRollupView | null>;
}

/** 生命周期存储面（条件更新即幂等：正确性不依赖分布式锁，ADR-0031 §2.3） */
export interface LifecycleStore {
  /**
   * 租户当前态；**null 仅表示租户不存在**。驱动须按 ADR-0029 §2.4 的 Int 编码读：
   * 存量停用 0 读作 frozen，未知编码 fail-closed 亦按 frozen 兜底（不得返回 null 冒充不存在）。
   */
  findTenantStatus(tenantId: string): Promise<LifecycleStatus | null>;
  /**
   * 租户名称查询（PRD-015 FR-15-10）：审计等只读面把租户 ID 还原为**可读名称快照**，
   * 杜绝 `target_label` 落成裸 ID（运营把 `t1` 当租户名）。null 仅表示租户不存在；
   * 软删行仍返回名称——审计要的是历史可读性，不是存在性判定（与 findTenantStatus 的
   * null 语义分工：那个回答「还在不在/什么状态」，这个回答「当时叫什么」）。
   */
  findTenantName(tenantId: string): Promise<string | null>;
  /**
   * UPDATE tenants SET status=:to WHERE id=:id AND status=:from —— 返回 affected === 1。
   * `from='frozen'` 须同时匹配存量停用 0 与规范 3（驱动用「非冻结码的补集」表达最佳），
   * 否则存量停用租户永远 resume/terminate 不了（4030 死锁）；写入值须恒为规范码（frozen→3）。
   */
  conditionalUpdateStatus(tenantId: string, from: LifecycleStatus, to: LifecycleStatus): Promise<boolean>;
  appendLifecycleLog(log: LifecycleLog): Promise<void>;
  listLifecycleLogs(tenantId: string): Promise<LifecycleLog[]>;
  /** 运营看板（M14 FR-14-14）：按状态计数的租户数（口径须与 findTenantStatus 一致：frozen 含存量 0） */
  countTenantsByStatus(status: LifecycleStatus): Promise<number>;
  /** 运营看板：跨租户最近迁移日志（createdAt desc，take N；at=createdAt 映射） */
  listRecentLifecycleLogs(limit: number): Promise<LifecycleLog[]>;
}

/** SaaS 运营基础存储端口聚合 */
export interface SaasStore extends PlanStore, SubscriptionStore, QuotaStore, UsageStore, LifecycleStore {}
