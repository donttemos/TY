/*
 * @file 租户生命周期服务
 * @description ADR-0031：五态迁移唯一权威编排。迁移合法性由 lifecycle.machine 判定（非法 4030），
 *   执行用状态条件更新（正确性不依赖锁）；条件更新失败后重读判定幂等（alreadyApplied），
 *   成功才记日志（幂等重入不重复记）。业务入口的冻结拦截（4031）由接入方 Guard 消费 assertNotSuspended。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { BizError, ErrorCode } from '@fw/core';
import { Injectable } from '@nestjs/common';
import { resolveTransition, TRANSITIONS } from './lifecycle.machine.js';
import { LifecycleTransitionInvalidError, TenantSuspendedError } from './errors.js';
import { recordLifecycleInvalidMetric, recordLifecycleTransitionMetric, recordTenantSuspendedRejectedMetric } from './saas-metrics.js';
import type { LifecycleStore } from './store.port.js';
import type { LifecycleAction, LifecycleLog, LifecycleStatus, TransitionResult } from './types.js';

@Injectable()
export class TenantLifecycleService {
  constructor(private readonly store: LifecycleStore) {}

  /**
   * 执行生命周期迁移：
   * 1. 迁移表判定（非法 → 4030）；
   * 2. 状态条件更新（affected=0 → 重读：已是目标态则幂等返回 alreadyApplied，否则 4030 竞态）；
   * 3. 首次成功才写生命周期日志。
   */
  async transition(
    tenantId: string,
    action: LifecycleAction,
    input?: { reason?: string | null; actorType?: 'system' | 'user'; actorId?: string | null; ip?: string | null; userAgent?: string | null; traceId?: string | null; requestId?: string | null; at?: Date },
  ): Promise<TransitionResult> {
    const from = await this.store.findTenantStatus(tenantId);
    if (!from) {
      throw new BizError(ErrorCode.NOT_FOUND, `租户不存在：${tenantId}`);
    }
    let to = resolveTransition(from, action);
    if (!to) {
      // 幂等重入判定（ADR-0031 §2.3：任务重复执行无双重副作用）：
      // 当前态已是该 action 的某个合法源状态的目标态 → 视为已生效（如 frozen 下重试 freeze）
      const reachedFrom = (Object.keys(TRANSITIONS) as LifecycleStatus[]).find((s) => resolveTransition(s, action) === from);
      if (reachedFrom) {
        return { from, to: from, alreadyApplied: true };
      }
      recordLifecycleInvalidMetric();
      throw new LifecycleTransitionInvalidError(from, action);
    }

    const applied = await this.store.conditionalUpdateStatus(tenantId, from, to);
    if (!applied) {
      const current = await this.store.findTenantStatus(tenantId);
      if (current === to) {
        // 重复执行（任务重试 / 并发迁移者已生效）：幂等成功，不重复记日志（ADR-0031 §2.3）
        return { from, to, alreadyApplied: true };
      }
      throw new LifecycleTransitionInvalidError(current ?? from, action, to);
    }

    recordLifecycleTransitionMetric(action);

    const log: LifecycleLog = {
      tenantId,
      fromStatus: from,
      toStatus: to,
      action,
      actorType: input?.actorType ?? 'user',
      actorId: input?.actorId ?? null,
      reason: input?.reason ?? null,
      ip: input?.ip ?? null,
      userAgent: input?.userAgent ?? null,
      traceId: input?.traceId ?? null,
      requestId: input?.requestId ?? null,
      at: input?.at ?? new Date(),
    };
    await this.store.appendLifecycleLog(log);
    return { from, to, alreadyApplied: false };
  }

  /** 业务入口 Guard 消费：frozen/terminated 抛 4031（放行白名单在 Guard 层裁决） */
  async assertNotSuspended(tenantId: string): Promise<LifecycleStatus> {
    const status = await this.store.findTenantStatus(tenantId);
    if (status === 'frozen' || status === 'terminated') {
      recordTenantSuspendedRejectedMetric();
      throw new TenantSuspendedError(tenantId, status);
    }
    return status ?? 'pending';
  }

  /** 查询迁移历史（运营面） */
  async listLogs(tenantId: string): Promise<LifecycleLog[]> {
    return this.store.listLifecycleLogs(tenantId);
  }
}
