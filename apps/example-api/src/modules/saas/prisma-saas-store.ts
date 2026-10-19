/*
 * @file SaaS 存储端口的 Prisma 实现（业务侧适配器）
 * @description 把 @fw/saas 的 SaasStore 端口映射到 M13 十表（数据字典 §3.20~3.29）。
 *   并发/幂等不变量（ADR-0030 §2.5 / ADR-0031 §2.3）在此落地：
 *   - consumeAtomic：单事务内「事件插入（幂等键唯一约束）→ 窗口行初始化（撞唯一键重读）→
 *     条件 UPDATE（used + qty <= limit）」；exceeded 时整体回滚（事件一并撤销，不留痕不扣减）；
 *   - conditionalUpdateStatus：tenants.status 条件更新（Int 映射，affected===1 才算生效）；
 *   - 一租户一生效订阅：active_marker 唯一索引兜底，服务层先行校验（ADR-0029 §3.3）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import { Inject, Injectable } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
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
} from '@fw/saas';
import type { SaasStore } from '@fw/saas';

/** 五态 ↔ tenants.status Int 映射（ADR-0029 §2.2：0 存量停用 → frozen，1 → active） */
const STATUS_TO_INT: Record<LifecycleStatus, number> = { pending: 0, active: 1, grace: 2, frozen: 3, terminated: 4 };
const INT_TO_STATUS: Record<number, LifecycleStatus> = { 0: 'frozen', 1: 'active', 2: 'grace', 3: 'frozen', 4: 'terminated' };

/** Prisma 唯一约束冲突（P2002）判定 */
function isUniqueViolation(e: unknown): boolean {
  return typeof e === 'object' && e !== null && (e as { code?: string }).code === 'P2002';
}

/** 事务内超限信号：抛出使 $transaction 整体回滚（事件一并撤销），外层转 exceeded 结果 */
class QuotaExceededSignal extends Error {
  constructor(readonly used: bigint, readonly limit: bigint) {
    super('QUOTA_EXCEEDED');
  }
}

/** 事务句柄的本地投影（避免直接依赖 @prisma/client 泛型） */
interface SaasTx {
  plan: {
    findUnique(args: { where: { id?: string; code?: string } }): Promise<(PlanView & { deletedAt: Date | null }) | null>;
    findMany(args: { where: Record<string, unknown> }): Promise<Array<PlanView & { deletedAt: Date | null }>>;
    create(args: { data: { code: string; name: string; description?: string | null } }): Promise<PlanView>;
  };
  planVersion: {
    findMany(args: { where: { planId: string }; orderBy?: Array<Record<string, string>> }): Promise<PlanVersionView[]>;
    findUnique(args: { where: { id?: string; planId_version?: { planId: string; version: number } } }): Promise<PlanVersionView | null>;
    create(args: { data: { planId: string; version: number; remark?: string | null; status?: string; publishedAt: Date } }): Promise<PlanVersionView>;
  };
  planQuota: {
    findUnique(args: { where: { planVersionId_quotaKey: { planVersionId: string; quotaKey: string } } }): Promise<PlanQuotaView | null>;
    findMany(args: { where: { planVersionId: string } }): Promise<PlanQuotaView[]>;
    upsert(args: { where: { planVersionId_quotaKey: { planVersionId: string; quotaKey: string } }; create: { planVersionId: string; quotaKey: string; limitValue: bigint; execution: string | null }; update: { limitValue: bigint; execution: string | null } }): Promise<unknown>;
  };
  quotaDefinition: {
    findUnique(args: { where: { key: string } }): Promise<QuotaDefinitionView | null>;
    upsert(args: { where: { key: string }; create: QuotaDefinitionView; update: Partial<QuotaDefinitionView> }): Promise<unknown>;
  };
  tenantSubscription: {
    findFirst(args: { where: Record<string, unknown> }): Promise<(SubscriptionView & { activeMarker: string | null }) | null>;
    findUnique(args: { where: { id: string } }): Promise<(SubscriptionView & { activeMarker: string | null }) | null>;
    findMany(args: { where: Record<string, unknown>; orderBy?: Array<Record<string, string>> }): Promise<SubscriptionView[]>;
    create(args: { data: { tenantId: string; planId: string; planVersionId: string; effectiveAt: Date; expireAt?: Date | null; activeMarker: string | null } }): Promise<SubscriptionView>;
    update(args: { where: { id: string }; data: Record<string, unknown> }): Promise<unknown>;
  };
  tenantQuota: {
    findUnique(args: { where: { tenantId_quotaKey: { tenantId: string; quotaKey: string } } }): Promise<TenantQuotaOverride | null>;
    findMany(args: { where: { tenantId: string } }): Promise<TenantQuotaOverride[]>;
    upsert(args: { where: { tenantId_quotaKey: { tenantId: string; quotaKey: string } }; create: TenantQuotaOverride; update: { overrideValue: bigint; execution: string | null; source: string } }): Promise<unknown>;
  };
  tenantQuotaWindow: {
    findUnique(args: { where: { tenantId_quotaKey_windowType_windowStart: { tenantId: string; quotaKey: string; windowType: string; windowStart: Date } } }): Promise<{ used: bigint; limitValue: bigint; execution: string; warnedAt: Date | null } | null>;
    create(args: { data: { tenantId: string; quotaKey: string; windowType: string; windowStart: Date; limitValue: bigint; execution: string } }): Promise<unknown>;
    updateMany(args: { where: { tenantId: string; quotaKey: string; windowType: string; windowStart: Date; used?: { lte: bigint }; warnedAt?: { isSet: false } | null }; data: { used?: { increment: bigint }; warnedAt?: Date } }): Promise<{ count: number }>;
  };
  usageEvent: {
    create(args: { data: { tenantId: string; quotaKey: string; quantity: bigint; occurredAt: Date; source: string; idempotencyKey: string } }): Promise<unknown>;
    findMany(args: { where: { tenantId: string; quotaKey: string; occurredAt: { gte: Date; lt: Date } }; orderBy?: Array<Record<string, string>> }): Promise<Array<{ quantity: bigint; occurredAt: Date }>>;
  };
  usageRollup: {
    findUnique(args: { where: { tenantId_quotaKey_windowType_windowStart: { tenantId: string; quotaKey: string; windowType: string; windowStart: Date } } }): Promise<UsageRollupView | null>;
    upsert(args: { where: { tenantId_quotaKey_windowType_windowStart: { tenantId: string; quotaKey: string; windowType: string; windowStart: Date } }; create: UsageRollupView; update: { totalQuantity: bigint; eventCount: number } }): Promise<unknown>;
  };
  tenant: {
    findUnique(args: { where: { id: string } }): Promise<{ status: number } | null>;
    updateMany(args: { where: { id: string; status: number }; data: { status: number } }): Promise<{ count: number }>;
  };
  tenantLifecycleLog: {
    create(args: { data: { tenantId: string; fromStatus: string | null; toStatus: string; action: string; actorType: string; actorId?: string | null; reason?: string | null; ip?: string | null; userAgent?: string | null; traceId?: string | null; requestId?: string | null } }): Promise<unknown>;
    findMany(args: { where: { tenantId: string }; orderBy?: Array<Record<string, string>> }): Promise<Array<Omit<LifecycleLog, 'at'> & { createdAt: Date }>>;
  };
}

type ClientLike = Omit<PrismaClientLike, '$transaction'> & {
  /** 事务回调参数收窄为 SaasTx（覆盖 PrismaClientLike 的 Record<string, ModelDelegate> 宽签名） */
  $transaction<R>(fn: (tx: SaasTx) => Promise<R>, options?: { timeout?: number }): Promise<R>;
};

@Injectable()
export class PrismaSaasStore implements SaasStore {
  constructor(@Inject(DB_CLIENT) private readonly client: PrismaClientLike) {}

  private get tx(): SaasTx {
    return this.client as unknown as SaasTx;
  }

  // ---- PlanStore ----
  async listPlans(): Promise<PlanView[]> {
    return this.tx.plan.findMany({ where: { deletedAt: null } }) as unknown as Promise<PlanView[]>;
  }
  async findPlanByCode(code: string): Promise<PlanView | null> {
    const row = await this.tx.plan.findUnique({ where: { code } });
    return row && row.deletedAt === null ? row : null;
  }

  async findPlanById(id: string): Promise<PlanView | null> {
    const row = await this.tx.plan.findUnique({ where: { id } });
    return row && row.deletedAt === null ? row : null;
  }

  async createPlan(plan: { code: string; name: string; description?: string | null }): Promise<PlanView> {
    try {
      return await this.tx.plan.create({ data: plan });
    } catch (e) {
      if (isUniqueViolation(e)) throw new BizError(ErrorCode.CONFLICT, `套餐编码已存在：${plan.code}`);
      throw e;
    }
  }

  async listVersions(planId: string): Promise<PlanVersionView[]> {
    return this.tx.planVersion.findMany({ where: { planId }, orderBy: [{ version: 'asc' }] });
  }

  async findVersionById(id: string): Promise<PlanVersionView | null> {
    return this.tx.planVersion.findUnique({ where: { id } });
  }

  async findVersion(planId: string, version: number): Promise<PlanVersionView | null> {
    return this.tx.planVersion.findUnique({ where: { planId_version: { planId, version } } });
  }

  async createVersion(v: { planId: string; version: number; remark?: string | null; publishedAt: Date }): Promise<PlanVersionView> {
    try {
      return await this.tx.planVersion.create({ data: { planId: v.planId, version: v.version, remark: v.remark ?? null, status: 'published', publishedAt: v.publishedAt } });
    } catch (e) {
      if (isUniqueViolation(e)) throw new BizError(ErrorCode.CONFLICT, `套餐版本已存在：v${v.version}`);
      throw e;
    }
  }

  async listPlanQuotas(planVersionId: string): Promise<PlanQuotaView[]> {
    return this.tx.planQuota.findMany({ where: { planVersionId } });
  }

  async findPlanQuota(planVersionId: string, quotaKey: string): Promise<PlanQuotaView | null> {
    return this.tx.planQuota.findUnique({ where: { planVersionId_quotaKey: { planVersionId, quotaKey } } });
  }

  async upsertPlanQuota(q: { planVersionId: string; quotaKey: string; limitValue: bigint; execution: PlanQuotaView['execution'] }): Promise<void> {
    await this.tx.planQuota.upsert({
      where: { planVersionId_quotaKey: { planVersionId: q.planVersionId, quotaKey: q.quotaKey } },
      create: { planVersionId: q.planVersionId, quotaKey: q.quotaKey, limitValue: q.limitValue, execution: q.execution ?? null },
      update: { limitValue: q.limitValue, execution: q.execution ?? null },
    });
  }

  async upsertQuotaDefinition(d: QuotaDefinitionView): Promise<void> {
    await this.tx.quotaDefinition.upsert({ where: { key: d.key }, create: d, update: { name: d.name, unit: d.unit, windowType: d.windowType, execution: d.execution, description: d.description } });
  }

  async findQuotaDefinition(key: string): Promise<QuotaDefinitionView | null> {
    return this.tx.quotaDefinition.findUnique({ where: { key } });
  }

  // ---- SubscriptionStore ----
  async findActiveSubscription(tenantId: string): Promise<SubscriptionView | null> {
    return this.tx.tenantSubscription.findFirst({ where: { tenantId, status: 'active' } });
  }

  async findSubscriptionById(id: string): Promise<SubscriptionView | null> {
    return this.tx.tenantSubscription.findUnique({ where: { id } });
  }

  async createSubscription(s: { tenantId: string; planId: string; planVersionId: string; effectiveAt: Date; expireAt?: Date | null; activeMarker: string | null }): Promise<SubscriptionView> {
    try {
      return await this.tx.tenantSubscription.create({
        data: { tenantId: s.tenantId, planId: s.planId, planVersionId: s.planVersionId, effectiveAt: s.effectiveAt, expireAt: s.expireAt ?? null, activeMarker: s.activeMarker },
      });
    } catch (e) {
      if (isUniqueViolation(e)) throw new BizError(ErrorCode.CONFLICT, `租户已有生效订阅（active_marker 唯一冲突）`);
      throw e;
    }
  }

  async closeSubscription(id: string, patch: { status: 'expired' | 'cancelled'; reason?: string | null; closedAt: Date }): Promise<void> {
    await this.tx.tenantSubscription.update({ where: { id }, data: { status: patch.status, closedAt: patch.closedAt, reason: patch.reason ?? null, activeMarker: null } });
  }

  async listActiveSubscriptionsExpiredAt(cutoff: Date): Promise<Array<{ id: string; tenantId: string; expireAt: Date | null }>> {
    return this.tx.tenantSubscription.findMany({
      where: { status: 'active', expireAt: { lt: cutoff } },
    }) as unknown as Promise<Array<{ id: string; tenantId: string; expireAt: Date | null }>>;
  }

  async listGraceTenantsPastGrace(cutoff: Date): Promise<Array<{ id: string; tenantId: string }>> {
    const subs = await this.tx.tenantSubscription.findMany({ where: { status: 'expired', expireAt: { lt: cutoff } } });
    const out: Array<{ id: string; tenantId: string }> = [];
    for (const s of subs) {
      const status = await this.findTenantStatus(s.tenantId);
      if (status === 'grace') out.push({ id: s.id, tenantId: s.tenantId });
    }
    return out;
  }

  // ---- QuotaStore ----
  async findTenantQuotaOverride(tenantId: string, quotaKey: string): Promise<TenantQuotaOverride | null> {
    return this.tx.tenantQuota.findUnique({ where: { tenantId_quotaKey: { tenantId, quotaKey } } });
  }

  async upsertTenantQuota(o: TenantQuotaOverride): Promise<void> {
    await this.tx.tenantQuota.upsert({
      where: { tenantId_quotaKey: { tenantId: o.tenantId, quotaKey: o.quotaKey } },
      create: o,
      update: { overrideValue: o.overrideValue, execution: o.execution ?? null, source: o.source },
    });
  }

  async listTenantQuotaOverrides(tenantId: string): Promise<TenantQuotaOverride[]> {
    return this.tx.tenantQuota.findMany({ where: { tenantId } });
  }

  async consumeAtomic(event: UsageEventInput, limit: bigint, execution: 'soft' | 'hard' | 'observe'): Promise<ConsumeOutcome> {
    try {
      return await (this.client as unknown as ClientLike).$transaction(
        async (tx) => {
          // ① 事件插入：幂等键唯一约束冲突 → deduped（不触碰窗口，不扣减）
          try {
            await tx.usageEvent.create({
              data: { tenantId: event.tenantId, quotaKey: event.quotaKey, quantity: event.quantity, occurredAt: event.occurredAt, source: event.source, idempotencyKey: event.idempotencyKey },
            });
          } catch (e) {
            if (isUniqueViolation(e)) return { result: 'deduped' } as ConsumeOutcome;
            throw e;
          }
          if (execution === 'observe') {
            // 仅统计：留痕即止（ADR-0030 §2.4）
            return { result: 'ok', used: 0n, limit } as ConsumeOutcome;
          }

          // ② 窗口行：按字典窗口类型切片（无字典默认 day）；不存在则初始化，撞唯一键（并发初始化）→ 重读
          const def = await tx.quotaDefinition.findUnique({ where: { key: event.quotaKey } });
          const windowType = def?.windowType ?? 'day';
          const windowStart = this.windowStartFor(windowType, event.occurredAt);
          const where = { tenantId_quotaKey_windowType_windowStart: { tenantId: event.tenantId, quotaKey: event.quotaKey, windowType, windowStart } };
          let row = await tx.tenantQuotaWindow.findUnique({ where });
          if (!row) {
            try {
              await tx.tenantQuotaWindow.create({ data: { tenantId: event.tenantId, quotaKey: event.quotaKey, windowType, windowStart, limitValue: limit, execution } });
            } catch (e) {
              if (!isUniqueViolation(e)) throw e;
            }
            row = await tx.tenantQuotaWindow.findUnique({ where });
          }
          if (!row) throw new Error('窗口行初始化失败'); // fw-allow-raw-throw: ②类内部信号——事务内防御分支（撞唯一键重读后仍缺失，理论不可达）

          // ③ 条件扣减：used + qty <= limit 才生效；affected=0 → 抛信号回滚（事件一并撤销）
          const res = await tx.tenantQuotaWindow.updateMany({
            where: { tenantId: event.tenantId, quotaKey: event.quotaKey, windowType, windowStart, used: { lte: limit - event.quantity } },
            data: { used: { increment: event.quantity } },
          });
          if (res.count === 0) throw new QuotaExceededSignal(row.used, limit);
          const after = await tx.tenantQuotaWindow.findUnique({ where });
          return { result: 'ok', used: after!.used, limit } as ConsumeOutcome;
        },
        { timeout: 10_000 },
      );
    } catch (e) {
      if (e instanceof QuotaExceededSignal) {
        return { result: 'exceeded', used: e.used, limit: e.limit };
      }
      throw e;
    }
  }

  async findWindow(tenantId: string, quotaKey: string, windowType: string, windowStart: Date) {
    const row = await this.tx.tenantQuotaWindow.findUnique({ where: { tenantId_quotaKey_windowType_windowStart: { tenantId, quotaKey, windowType, windowStart } } });
    return row ? { used: row.used, limitValue: row.limitValue, execution: row.execution, warnedAt: row.warnedAt } : null;
  }

  async markWarned(tenantId: string, quotaKey: string, windowType: string, windowStart: Date, at: Date): Promise<boolean> {
    const res = await this.tx.tenantQuotaWindow.updateMany({
      where: { tenantId, quotaKey, windowType, windowStart, warnedAt: null },
      data: { warnedAt: at },
    });
    return res.count === 1;
  }

  // ---- UsageStore ----
  async listEvents(tenantId: string, quotaKey: string, from: Date, to: Date) {
    return this.tx.usageEvent.findMany({ where: { tenantId, quotaKey, occurredAt: { gte: from, lt: to } }, orderBy: [{ occurredAt: 'asc' }] });
  }

  async upsertRollup(r: UsageRollupView): Promise<void> {
    await this.tx.usageRollup.upsert({
      where: { tenantId_quotaKey_windowType_windowStart: { tenantId: r.tenantId, quotaKey: r.quotaKey, windowType: r.windowType, windowStart: r.windowStart } },
      create: r,
      update: { totalQuantity: r.totalQuantity, eventCount: r.eventCount },
    });
  }

  async findRollup(tenantId: string, quotaKey: string, windowType: string, windowStart: Date): Promise<UsageRollupView | null> {
    return this.tx.usageRollup.findUnique({ where: { tenantId_quotaKey_windowType_windowStart: { tenantId, quotaKey, windowType, windowStart } } });
  }

  // ---- LifecycleStore ----
  async findTenantStatus(tenantId: string): Promise<LifecycleStatus | null> {
    const row = await this.tx.tenant.findUnique({ where: { id: tenantId } });
    return row ? (INT_TO_STATUS[row.status] ?? null) : null;
  }

  async conditionalUpdateStatus(tenantId: string, from: LifecycleStatus, to: LifecycleStatus): Promise<boolean> {
    const res = await this.tx.tenant.updateMany({
      where: { id: tenantId, status: STATUS_TO_INT[from] },
      data: { status: STATUS_TO_INT[to] },
    });
    return res.count === 1;
  }

  async appendLifecycleLog(log: LifecycleLog): Promise<void> {
    await this.tx.tenantLifecycleLog.create({
      data: {
        tenantId: log.tenantId,
        fromStatus: log.fromStatus ?? null,
        toStatus: log.toStatus,
        action: log.action,
        actorType: log.actorType,
        actorId: log.actorId ?? null,
        reason: log.reason ?? null,
        ip: log.ip ?? null,
        userAgent: log.userAgent ?? null,
        traceId: log.traceId ?? null,
        requestId: log.requestId ?? null,
      },
    });
  }

  async listLifecycleLogs(tenantId: string): Promise<LifecycleLog[]> {
    const rows = await this.tx.tenantLifecycleLog.findMany({ where: { tenantId }, orderBy: [{ createdAt: 'asc' }] });
    return rows.map((r) => ({ ...r, at: r.createdAt }));
  }

  /** 窗口起点（UTC 切片：day 当日 / month 当月 1 日 / total epoch 永不翻转，ADR-0030 §2.1） */
  private windowStartFor(windowType: string, at: Date): Date {
    if (windowType === 'total') return new Date(0);
    if (windowType === 'month') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
}
