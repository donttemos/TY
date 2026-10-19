/*
 * @file 用量与限额服务
 * @description 硬限额原子扣减编排（ADR-0030）：consumeAtomic 语义（事件去重 → 条件更新扣减）
 *   由驱动事务保证；软限额同窗幂等告警（warned_at）；observe 仅留痕不判限。
 *   汇总重算闭环（rollup 可从 events 重建，AC-13-06）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { Injectable } from '@nestjs/common';
import { QuotaExceededError } from './errors.js';
import { QuotaService, windowStartFor } from './quota.service.js';
import { recordQuotaCheckMetric, recordQuotaExceededMetric, recordUsageDedupedMetric } from './saas-metrics.js';
import type { QuotaStore, UsageStore } from './store.port.js';
import type { ConsumeOutcome, UsageEventInput, UsageRollupView } from './types.js';

@Injectable()
export class UsageService {
  constructor(
    private readonly quota: QuotaService,
    private readonly quotaStore: QuotaStore,
    private readonly usageStore: UsageStore,
  ) {}

  /**
   * 上报用量并执行限额（ADR-0030 §2.4）：
   * - hard：原子扣减，超限抛 4029（无副作用：事件与扣减同事务回滚）；
   * - soft：正常扣减；used >= limit 时同窗幂等告警一次（markWarned 返回 true 才派发）；
   * - observe：仅留痕（deduped 语义仍生效），不判限不扣窗口。
   *
   * @param notifySoftLimit 软限额告警派发钩子（接通知面；不传则仅标记 warned_at）
   */
  async record(
    event: UsageEventInput,
    options?: { notifySoftLimit?: (e: UsageEventInput, used: bigint, limit: bigint) => Promise<void> },
  ): Promise<ConsumeOutcome> {
    const effective = await this.quota.resolveEffective(event.tenantId, event.quotaKey);
    const def = await this.quotaStore.findQuotaDefinition(event.quotaKey);
    const windowType = def?.windowType ?? 'day';
    const windowStart = windowStartFor(windowType, event.occurredAt);

    if (effective.execution === 'observe') {
      // 仅统计：走事件插入的幂等去重，不触碰窗口行
      recordQuotaCheckMetric('observe');
      const outcome = await this.quotaStore.consumeAtomic(event, effective.limitValue, 'observe');
      if (outcome.result === 'deduped') recordUsageDedupedMetric();
      return outcome.result === 'ok' ? { result: 'ok', used: 0n, limit: effective.limitValue } : outcome;
    }

    recordQuotaCheckMetric(effective.execution);
    const outcome = await this.quotaStore.consumeAtomic(event, effective.limitValue, effective.execution);
    if (outcome.result === 'exceeded') {
      recordQuotaExceededMetric();
      throw new QuotaExceededError(event.quotaKey, outcome.used, outcome.limit);
    }
    if (outcome.result === 'deduped') recordUsageDedupedMetric();
    if (outcome.result === 'ok' && effective.execution === 'soft') {
      const marked = await this.quotaStore.markWarned(event.tenantId, event.quotaKey, windowType, windowStart, event.occurredAt);
      if (marked) {
        await options?.notifySoftLimit?.(event, outcome.used, outcome.limit);
      }
    }
    return outcome;
  }

  /**
   * 重算指定窗口的 rollup（从原始事件重建，幂等；AC-13-06）。
   * 返回重算后的汇总行。
   */
  async recalcRollup(tenantId: string, quotaKey: string, windowType: 'day' | 'month' | 'total', windowStart: Date, windowEnd: Date): Promise<UsageRollupView> {
    const events = await this.usageStore.listEvents(tenantId, quotaKey, windowStart, windowEnd);
    const total = events.reduce((sum, e) => sum + e.quantity, 0n);
    const rollup: UsageRollupView = {
      tenantId,
      quotaKey,
      windowType,
      windowStart,
      totalQuantity: total,
      eventCount: events.length,
    };
    await this.usageStore.upsertRollup(rollup);
    return rollup;
  }

  /** 查询窗口汇总（无行返回 null；查询侧标注数据来源为 rollup） */
  async findRollup(tenantId: string, quotaKey: string, windowType: 'day' | 'month' | 'total', windowStart: Date): Promise<UsageRollupView | null> {
    return this.usageStore.findRollup(tenantId, quotaKey, windowType, windowStart);
  }
}
