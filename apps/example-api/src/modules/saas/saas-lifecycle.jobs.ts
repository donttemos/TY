/*
 * @file 到期与宽限期处置任务（M13，ADR-0031 §2.3 / FR-13-11）
 * @description 分布式定时任务（@Cron + 执行守卫分布式锁，多实例只跑一次）：
 *   ① expire：active 订阅到期（expireAt < now）→ 租户 active→grace + 订阅置 expired；
 *   ② freeze：宽限期满（expireAt < now - SAAS_GRACE_PERIOD_DAYS，默认 7 天）且租户 grace → frozen。
 *   幂等性：租户迁移走条件更新（重复执行 alreadyApplied 短路，不重复记日志）；
 *   订阅关闭按「当前 active 才关」判定；单条失败不中断整批（失败计数留在任务快照）。
 *   进程重启无内存态：扫描基于 DB 条件，重启后自然续跑（AC-13-08）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import { Inject, Injectable } from '@nestjs/common';
import { Logger } from '@fw/logger';
import { Cron } from '@fw/queue';
import { TenantLifecycleService } from '@fw/saas';
import type { SaasStore } from '@fw/saas';
import { DEFAULT_GRACE_PERIOD_DAYS, SAAS_GRACE_PERIOD_DAYS, SAAS_STORE } from './saas.tokens.js';

const logger = Logger.for('saas.lifecycle-jobs');

/** 本批扫描上限（防止单轮过重；剩余下一轮续扫） */
const SWEEP_BATCH = 100;

@Injectable()
export class SaasLifecycleJobs {
  constructor(
    @Inject(SAAS_STORE) private readonly store: SaasStore,
    private readonly lifecycle: TenantLifecycleService,
  ) {}

  /** 读取宽限期天数（env SAAS_GRACE_PERIOD_DAYS，非法值回退默认 7 并告警） */
  private graceDays(): number {
    const raw = process.env[SAAS_GRACE_PERIOD_DAYS];
    if (!raw) return DEFAULT_GRACE_PERIOD_DAYS;
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      logger.warn('SAAS_GRACE_PERIOD_DAYS 非法（须为正整数），回退默认值', { raw });
      return DEFAULT_GRACE_PERIOD_DAYS;
    }
    return n;
  }

  /** 每小时整点执行（分布锁互斥）；手动 tick 亦走同一把锁 */
  @Cron('0 * * * *', { lock: true, name: 'saas-lifecycle-sweep' })
  async sweep(): Promise<void> {
    const now = new Date();
    const summary = { expired: 0, frozen: 0, skipped: 0, failed: 0 };

    // ① active 订阅到期 → grace
    const expiredSubs = (await this.store.listActiveSubscriptionsExpiredAt(now)).slice(0, SWEEP_BATCH);
    for (const sub of expiredSubs) {
      try {
        const r = await this.lifecycle.transition(sub.tenantId, 'expire', {
          actorType: 'system',
          reason: `订阅到期（sub=${sub.id}，expireAt=${sub.expireAt?.toISOString() ?? 'null'}）`,
          at: now,
        });
        if (!r.alreadyApplied) {
          summary.expired += 1;
          logger.info('租户进入宽限期', { tenantId: sub.tenantId, expireAt: sub.expireAt });
        } else {
          summary.skipped += 1;
        }
        // 订阅关闭（幂等：仅当前 active 才关；重跑时已 expired 直接跳过）
        const current = await this.store.findSubscriptionById(sub.id);
        if (current && current.status === 'active') {
          await this.store.closeSubscription(sub.id, { status: 'expired', reason: '到期自动关闭', closedAt: now });
        }
      } catch (e) {
        summary.failed += 1;
        logger.error('到期迁移失败（不中断整批）', { tenantId: sub.tenantId, error: e instanceof Error ? e.message : String(e) });
      }
    }

    // ② 宽限期满 → frozen
    const cutoff = new Date(now.getTime() - this.graceDays() * 24 * 3600 * 1000);
    const pastGrace = (await this.store.listGraceTenantsPastGrace(cutoff)).slice(0, SWEEP_BATCH);
    for (const sub of pastGrace) {
      try {
        const r = await this.lifecycle.transition(sub.tenantId, 'freeze', {
          actorType: 'system',
          reason: `宽限期满（grace 截止 ${cutoff.toISOString()}）`,
          at: now,
        });
        if (!r.alreadyApplied) {
          summary.frozen += 1;
          logger.info('租户宽限期满转入冻结', { tenantId: sub.tenantId });
        } else {
          summary.skipped += 1;
        }
      } catch (e) {
        summary.failed += 1;
        logger.error('宽限期满冻结失败（不中断整批）', { tenantId: sub.tenantId, error: e instanceof Error ? e.message : String(e) });
      }
    }

    if (summary.expired + summary.frozen + summary.failed > 0) {
      logger.info('生命周期巡检完成', { ...summary, graceDays: this.graceDays() });
    }
  }
}
