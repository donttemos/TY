/*
 * @file 领域类型定义
 * @description M13（PRD-013）SaaS 运营基础的领域词汇表：五态生命周期、迁移动作、套餐/订阅/配额/
 *   用量的领域对象与端口方法载荷。类型只承载领域语义，不绑定具体 ORM（ADR-0029~0031）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */

/** 租户生命周期五态（ADR-0031） */
export type LifecycleStatus = 'pending' | 'active' | 'grace' | 'frozen' | 'terminated';

/** 生命周期迁移动作（合法迁移表见 lifecycle.machine.ts） */
export type LifecycleAction = 'activate' | 'expire' | 'freeze' | 'resume' | 'terminate' | 'dispose';

/** 状态迁移记录者类型（ADR-0031：system=定时任务 / user=运营操作） */
export type LifecycleActorType = 'system' | 'user';

/** 生命周期迁移日志（ tenants_lifecycle_logs 领域面，只增不改不删） */
export interface LifecycleLog {
  tenantId: string;
  fromStatus: LifecycleStatus | null;
  toStatus: LifecycleStatus;
  action: LifecycleAction;
  actorType: LifecycleActorType;
  actorId?: string | null;
  reason?: string | null;
  ip?: string | null;
  userAgent?: string | null;
  traceId?: string | null;
  requestId?: string | null;
  at: Date;
}

/** 套餐定义（领域面） */
export interface PlanView {
  id: string;
  code: string;
  name: string;
  description?: string | null;
}

/** 套餐版本（领域面；发布后不可变） */
export interface PlanVersionView {
  id: string;
  planId: string;
  version: number;
  status: 'draft' | 'published' | 'deprecated';
  remark?: string | null;
  publishedAt?: Date | null;
}

/** 配额执行方式（ADR-0030 §2.4） */
export type QuotaExecution = 'soft' | 'hard' | 'observe';

/** 统计窗口类型 */
export type QuotaWindowType = 'day' | 'month' | 'total';

/** 配额字典项（领域面） */
export interface QuotaDefinitionView {
  key: string;
  name: string;
  unit: string;
  windowType: QuotaWindowType;
  execution: QuotaExecution;
  description?: string | null;
}

/** 套餐版本内的一条配额默认项 */
export interface PlanQuotaView {
  planVersionId: string;
  quotaKey: string;
  limitValue: bigint;
  execution: QuotaExecution | null;
}

/** 租户配额覆盖行（source 区分快照与手工） */
export interface TenantQuotaOverride {
  tenantId: string;
  quotaKey: string;
  overrideValue: bigint;
  execution: QuotaExecution | null;
  source: 'plan_snapshot' | 'manual';
}

/** 生效配额解析结果（resolveEffective 输出） */
export interface EffectiveQuota {
  tenantId: string;
  quotaKey: string;
  limitValue: bigint;
  execution: QuotaExecution;
  /** limit 的来源：manual=租户覆盖 / plan=套餐默认 */
  source: 'manual' | 'plan';
}

/** 订阅（领域面） */
export interface SubscriptionView {
  id: string;
  tenantId: string;
  planId: string;
  planVersionId: string;
  status: 'active' | 'expired' | 'cancelled';
  effectiveAt: Date;
  expireAt?: Date | null;
  closedAt?: Date | null;
  reason?: string | null;
}

/** 用量事件输入（idempotencyKey 由调用方按 `<tenantId>:<metricKey>:<bizEventId>` 组装） */
export interface UsageEventInput {
  tenantId: string;
  quotaKey: string;
  quantity: bigint;
  occurredAt: Date;
  source: string;
  idempotencyKey: string;
}

/** 硬限额原子扣减结果（ADR-0030 §2.5：事件写入与窗口扣减的原子语义由驱动事务保证） */
export type ConsumeOutcome =
  | { result: 'ok'; used: bigint; limit: bigint }
  | { result: 'deduped' }
  | { result: 'exceeded'; used: bigint; limit: bigint };

/** 汇总行（重算/查询领域面） */
export interface UsageRollupView {
  tenantId: string;
  quotaKey: string;
  windowType: QuotaWindowType;
  windowStart: Date;
  totalQuantity: bigint;
  eventCount: number;
}

/** 生命周期迁移结果（幂等迁移已生效时 alreadyApplied=true，不重复记日志） */
export interface TransitionResult {
  from: LifecycleStatus;
  to: LifecycleStatus;
  alreadyApplied: boolean;
}
