/*
 * @file SaaS 存储端口的 Prisma 实现（业务侧适配器）
 * @description 把 @fw/saas 的 SaasStore 端口映射到 M13 十表（数据字典 §3.20~3.29）。
 *   并发/幂等不变量（ADR-0030 §2.5 / ADR-0031 §2.3）在此落地：
 *   - consumeAtomic：单事务内「事件插入（幂等键唯一约束）→ 窗口行初始化（撞唯一键重读）→
 *     条件 UPDATE（used + qty <= limit）」；exceeded 时整体回滚（事件一并撤销，不留痕不扣减）；
 *   - conditionalUpdateStatus：tenants.status 条件更新（Int 映射，affected===1 才算生效）；
 *     存量停用的 0 与规范的 3 同读作 frozen（见下方编码表），写路径只产生规范码；
 *   - 一租户一生效订阅：active_marker 唯一索引兜底，服务层先行校验（ADR-0029 §3.3）。
 * @author donttemo
 * @created 2026-10-19
 * @modified 2026-10-21 donttemo P0：修正五态 Int 映射不对称——0 归还「存量停用」只读语义，
 *   pending 改占独立编码 5（原写 pending=0 / 读 0=frozen，写 pending 即落成停用且永久卡死）
 * @modified 2026-10-20 donttemo 订阅开通落地为单事务（createSubscriptionWithSnapshot：订阅行 +
 *   全部配额快照行同成同败），移除独立 createSubscription
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

/**
 * 五态 ↔ tenants.status Int 编码（ADR-0029 §2.4，2026-10-21 修正）。
 *
 * **写码**（唯一权威，写路径只产生这五个值）：
 *   pending=5 / active=1 / grace=2 / frozen=3 / terminated=4。
 *
 * **读码**（兼容存量，0 与 3 同为 frozen）：
 *   0 = 存量停用（M8 既有语义：租户管理端停用、历史数据均为 0）→ 读作 frozen；
 *   1/2/3/4 = 同写码；5 = pending。
 *
 * 为什么 pending 不复用 0（本次修正的 P0 起因）：0 自 M8 起就是「停用」的既有语义，且被三处强依赖——
 *   ① `@fw/tenant` 的 assertUsable 仅拒 0（4001 fail-closed）；② 租户管理端 disableTenant 写 0；
 *   ③ ADR-0029 回填脚本把 0 读作 frozen 并落 cancelled 订阅。
 * 旧实现「写 pending=0 / 读 0=frozen」因此**非双射**，已可达的后果有两个：
 *   ① frozen 的条件更新按 3 匹配不到存量 0 → 经生命周期服务 resume/terminate 恒 4030（只能绕道
 *      租户管理端直写 status，而那是 ADR-0031 §2.3 禁止的写路径；错误码还误导排障方向）；
 *   ② 0 横跨两个领域态 → countTenantsByStatus('pending') 把存量停用误计为待开通、'frozen' 又漏计，
 *      同一行还会被 findTenantStatus 读作 frozen 却被统计成 pending（读路径与统计自相矛盾）。
 *   另有契约地雷：未来任何开通流程按旧表写 pending 都会落成停用（4001/4031 双拒且 activate 恒 4030）。
 * 故 0 只读不写（存量兼容），pending 独占 5——读写双射。
 * 0 不需要数据迁移：5 是 Int 列上从未使用过的空闲值，存量 0 语义不变（旧环境零破坏）。
 */
const STATUS_TO_INT: Record<LifecycleStatus, number> = { pending: 5, active: 1, grace: 2, frozen: 3, terminated: 4 };

/** 读码 → 领域态：登记存量 0 → frozen；未登记编码（脏值）由调用方兜底，见 findTenantStatus */
const INT_TO_STATUS: Readonly<Record<number, LifecycleStatus>> = {
  0: 'frozen',
  1: 'active',
  2: 'grace',
  3: 'frozen',
  4: 'terminated',
  5: 'pending',
};

/**
 * 非冻结态的规范编码集。frozen 的匹配集取其**补集**（`notIn`）而非枚举 [0, 3]：
 * 既覆盖存量 0 与规范 3，也把未登记的脏值一并按冻结处理（fail-closed —— 未知状态绝不放行为可用），
 * 使 findTenantStatus / countTenantsByStatus / conditionalUpdateStatus 三者口径完全一致；
 * 且脏值租户仍可经 resume / terminate 归一到规范码，不会卡在无法迁移的死态。
 */
const NON_FROZEN_INTS: readonly number[] = [
  STATUS_TO_INT.pending,
  STATUS_TO_INT.active,
  STATUS_TO_INT.grace,
  STATUS_TO_INT.terminated,
];

/** tenants.status 的条件形态：等值 / 集合（frozen 用补集表达，见 NON_FROZEN_INTS） */
type StatusFilter = number | { notIn: number[] };

/** 某领域态「来源」匹配条件：frozen 匹配全部非冻结码的补集，其余为等值 */
function statusMatchFilter(status: LifecycleStatus): StatusFilter {
  return status === 'frozen' ? { notIn: [...NON_FROZEN_INTS] } : STATUS_TO_INT[status];
}

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
    findMany(args: { where: Record<string, unknown>; orderBy?: Array<Record<string, string>>; skip?: number; take?: number }): Promise<SubscriptionView[]>;
    count(args: { where: Record<string, unknown> }): Promise<number>;
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
    findMany(args: { where: { windowType: string; windowStart: Date } }): Promise<Array<{ tenantId: string; quotaKey: string; used: bigint; limitValue: bigint; execution: string }>>;
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
    updateMany(args: { where: { id: string; status: StatusFilter }; data: { status: number } }): Promise<{ count: number }>;
    count(args: { where: { status: StatusFilter } }): Promise<number>;
  };
  tenantLifecycleLog: {
    create(args: { data: { tenantId: string; fromStatus: string | null; toStatus: string; action: string; actorType: string; actorId?: string | null; reason?: string | null; ip?: string | null; userAgent?: string | null; traceId?: string | null; requestId?: string | null } }): Promise<unknown>;
    findMany(args: { where?: { tenantId?: string }; orderBy?: Array<Record<string, string>>; take?: number }): Promise<Array<Omit<LifecycleLog, 'at'> & { createdAt: Date }>>;
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

  /**
   * 订阅创建 + 配额快照：**单事务**（ADR-0029 §2.5）。订阅行与全部 tenant_quotas 行同成同败——
   * 快照第 k 条写失败时，前 k-1 条与订阅行一并回滚，不会留下「已生效但权益不完整」的订阅。
   * 超时与 consumeAtomic 同档（10s）：批量快照条数为量级可控的小集合（套餐配额项数个位数）。
   */
  async createSubscriptionWithSnapshot(
    s: { tenantId: string; planId: string; planVersionId: string; effectiveAt: Date; expireAt?: Date | null; activeMarker: string | null },
    quotas: TenantQuotaOverride[],
  ): Promise<SubscriptionView> {
    return (this.client as unknown as ClientLike).$transaction(
      async (tx) => {
        let sub: SubscriptionView;
        try {
          sub = await tx.tenantSubscription.create({
            data: { tenantId: s.tenantId, planId: s.planId, planVersionId: s.planVersionId, effectiveAt: s.effectiveAt, expireAt: s.expireAt ?? null, activeMarker: s.activeMarker },
          });
        } catch (e) {
          // 抛在事务内：唯一冲突即整体回滚（无任何快照行落库）
          if (isUniqueViolation(e)) throw new BizError(ErrorCode.CONFLICT, `租户已有生效订阅（active_marker 唯一冲突）`);
          throw e;
        }
        for (const q of quotas) {
          await tx.tenantQuota.upsert({
            where: { tenantId_quotaKey: { tenantId: q.tenantId, quotaKey: q.quotaKey } },
            create: q,
            update: { overrideValue: q.overrideValue, execution: q.execution ?? null, source: q.source },
          });
        }
        return sub;
      },
      { timeout: 10_000 },
    );
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
    const where: Record<string, unknown> = {};
    if (filter.tenantId !== undefined) where.tenantId = filter.tenantId;
    if (filter.planId !== undefined) where.planId = filter.planId;
    if (filter.status !== undefined) where.status = filter.status;
    if (filter.expireFrom != null || filter.expireTo != null) {
      where.expireAt = {
        ...(filter.expireFrom != null ? { gte: filter.expireFrom } : {}),
        ...(filter.expireTo != null ? { lte: filter.expireTo } : {}),
      };
    }
    const [items, total] = await Promise.all([
      this.tx.tenantSubscription.findMany({
        where,
        orderBy: [{ effectiveAt: 'desc' }, { id: 'asc' }],
        skip: (page.page - 1) * page.pageSize,
        take: page.pageSize,
      }),
      this.tx.tenantSubscription.count({ where }),
    ]);
    return { items, total };
  }

  async listSubscriptionsByTenant(tenantId: string): Promise<SubscriptionView[]> {
    return this.tx.tenantSubscription.findMany({
      where: { tenantId },
      orderBy: [{ effectiveAt: 'desc' }, { id: 'asc' }],
    });
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

  async listWindows(windowType: string, windowStart: Date): Promise<Array<{ tenantId: string; quotaKey: string; used: bigint; limitValue: bigint; execution: string }>> {
    return this.tx.tenantQuotaWindow.findMany({ where: { windowType, windowStart } });
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
    if (!row) return null; // 端口契约：null 仅表示「租户不存在」，不与未知编码混淆
    // 存量 0 → frozen（见编码表）；未登记脏值 fail-closed 按 frozen 处理（未知状态绝不放行为可用）
    return INT_TO_STATUS[row.status] ?? 'frozen';
  }

  async conditionalUpdateStatus(tenantId: string, from: LifecycleStatus, to: LifecycleStatus): Promise<boolean> {
    const res = await this.tx.tenant.updateMany({
      // from='frozen' 匹配 0 与 3 两码（含脏值）——存量停用租户据此可被 resume/terminate 迁移，
      // 不再出现「读作 frozen、条件更新匹配不到 3、重读仍是 frozen → 4030」的永久死锁
      where: { id: tenantId, status: statusMatchFilter(from) },
      data: { status: STATUS_TO_INT[to] }, // 写码恒为规范值：存量 0 被迁移时归一为 3
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

  async countTenantsByStatus(status: LifecycleStatus): Promise<number> {
    // 与 findTenantStatus 同口径：'frozen' 计 {0, 3, 脏值}（存量停用属冻结，不再漏计）；
    // 'pending' 只计 5（存量 0 不会再被误计为待开通）
    return this.tx.tenant.count({ where: { status: statusMatchFilter(status) } });
  }

  async listRecentLifecycleLogs(limit: number): Promise<LifecycleLog[]> {
    const rows = await this.tx.tenantLifecycleLog.findMany({ orderBy: [{ createdAt: 'desc' }], take: limit });
    return rows.map((r) => ({ ...r, at: r.createdAt }));
  }

  /** 窗口起点（UTC 切片：day 当日 / month 当月 1 日 / total epoch 永不翻转，ADR-0030 §2.1） */
  private windowStartFor(windowType: string, at: Date): Date {
    if (windowType === 'total') return new Date(0);
    if (windowType === 'month') return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), 1));
    return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
  }
}
