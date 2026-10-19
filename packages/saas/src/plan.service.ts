/*
 * @file 套餐服务
 * @description 套餐定义与版本发布规则（ADR-0029）：版本号单调递增、发布即不可变
 *   （端口无版本更新方法，规则由结构保证）。配额默认项随版本 upsert。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { BizError, ErrorCode } from '@fw/core';
import { Injectable } from '@nestjs/common';
import type { PlanStore } from './store.port.js';
import type { PlanQuotaView, PlanVersionView, PlanView, QuotaDefinitionView } from './types.js';

/** 发布版本时的配额默认项载荷 */
export interface PublishQuotaInput {
  quotaKey: string;
  limitValue: bigint;
  execution?: PlanQuotaView['execution'];
}

@Injectable()
export class PlanService {
  constructor(private readonly store: PlanStore) {}

  /** 创建套餐（code 唯一，冲突返回 1003） */
  async createPlan(input: { code: string; name: string; description?: string | null }): Promise<PlanView> {
    const existing = await this.store.findPlanByCode(input.code);
    if (existing) {
      throw new BizError(ErrorCode.CONFLICT, `套餐编码已存在：${input.code}`);
    }
    return this.store.createPlan(input);
  }

  /** 发布新版本：version = 当前最大版本 + 1；发布后不可变（ADR-0029 §2.1） */
  async publishVersion(
    planId: string,
    input: { remark?: string | null; quotas: PublishQuotaInput[]; at?: Date; definitions?: QuotaDefinitionView[] },
  ): Promise<PlanVersionView> {
    const plan = await this.store.findPlanById(planId);
    if (!plan) {
      throw new BizError(ErrorCode.NOT_FOUND, `套餐不存在：${planId}`);
    }
    if (input.quotas.length === 0) {
      throw new BizError(ErrorCode.BIZ_FAILED, '版本必须至少包含一条配额定义');
    }
    for (const q of input.quotas) {
      const def = input.definitions?.find((d) => d.key === q.quotaKey) ?? (await this.store.findQuotaDefinition(q.quotaKey));
      if (!def) {
        throw new BizError(ErrorCode.NOT_FOUND, `配额字典未登记：${q.quotaKey}`);
      }
      if (q.limitValue < 0n) {
        throw new BizError(ErrorCode.BIZ_FAILED, `配额限额不能为负：${q.quotaKey}`);
      }
    }

    const versions = await this.store.listVersions(planId);
    const next = versions.reduce((max, v) => Math.max(max, v.version), 0) + 1;
    const published = await this.store.createVersion({
      planId,
      version: next,
      remark: input.remark ?? null,
      publishedAt: input.at ?? new Date(),
    });
    for (const q of input.quotas) {
      await this.store.upsertPlanQuota({
        planVersionId: published.id,
        quotaKey: q.quotaKey,
        limitValue: q.limitValue,
        execution: q.execution ?? null,
      });
      // 字典侧登记缺失时顺带补登记（保证 plan_quotas 的外键语义可用）
      const def = await this.store.findQuotaDefinition(q.quotaKey);
      if (!def && input.definitions) {
        const d = input.definitions.find((x) => x.key === q.quotaKey);
        if (d) await this.store.upsertQuotaDefinition(d);
      }
    }
    return published;
  }

  /** 列出版本（含草稿；发布后不可变） */
  async listVersions(planId: string): Promise<PlanVersionView[]> {
    return this.store.listVersions(planId);
  }

  /** 列出版本配额默认项 */
  async listPlanQuotas(planVersionId: string): Promise<PlanQuotaView[]> {
    return this.store.listPlanQuotas(planVersionId);
  }
}
