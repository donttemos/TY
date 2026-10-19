/*
 * @file SaaS 运营指标段
 * @description M13（PRD-013 NFR-13-5，命名规范沿 M12 `fw_<域>_<指标>_<单位>`）：进程内自研计数器
 *   （零新依赖，NG12-3 不引 prom-client），经 @fw/core 指标段注册表挂到 /metrics。段内容：
 *     fw_saas_quota_checks_total{execution}        限额检查计数（soft / hard / observe）
 *     fw_saas_quota_exceeded_total                 硬限额拒绝计数（4029；不按 metricKey 分——
 *                                                  指标键由租户数据驱动，入 label 即高基数违规）
 *     fw_saas_usage_deduped_total                  幂等键去重计数（重复投递不重复计量）
 *     fw_saas_lifecycle_transitions_total{action}  生命周期迁移计数（六动作枚举，低基数）
 *     fw_saas_lifecycle_invalid_total              非法迁移拒绝计数（4030）
 *     fw_saas_tenant_suspended_rejected_total      冻结/终止拦截计数（4031，业务入口 Guard）
 *     fw_saas_sweep_total{result}                  到期巡检动作计数（expired / frozen / failed）
 *   基数护栏（硬约束，同 M12 §6.6）：label 仅允许低基数枚举，禁止 tenantId / metricKey /
 *   subscriptionId 入 label——租户/指标维度走审计表与 usage_events，不进 Prometheus。
 *   段开关：METRICS_SAAS_SECTION_ENABLED（默认开启；关闭则 /metrics 不渲染该段）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */

import { registerMetricsSection } from '@fw/core';

/** 限额执行方式维度 */
export type QuotaExecutionMetric = 'soft' | 'hard' | 'observe';

/** 计数器状态（模块级，进程生命周期内累计） */
const counters = {
  quotaChecks: { soft: 0, hard: 0, observe: 0 } as Record<QuotaExecutionMetric, number>,
  quotaExceeded: 0,
  usageDeduped: 0,
  lifecycleTransitions: {} as Record<string, number>,
  lifecycleInvalid: 0,
  tenantSuspendedRejected: 0,
  sweep: {} as Record<string, number>,
};

/** 限额检查计数（UsageService.record 消费路径） */
export function recordQuotaCheckMetric(execution: QuotaExecutionMetric): void {
  counters.quotaChecks[execution] += 1;
}

/** 硬限额拒绝计数（4029 抛出点） */
export function recordQuotaExceededMetric(): void {
  counters.quotaExceeded += 1;
}

/** 幂等键去重计数 */
export function recordUsageDedupedMetric(): void {
  counters.usageDeduped += 1;
}

/** 生命周期迁移计数（action 为六动作低基数枚举） */
export function recordLifecycleTransitionMetric(action: string): void {
  counters.lifecycleTransitions[action] = (counters.lifecycleTransitions[action] ?? 0) + 1;
}

/** 非法迁移拒绝计数（4030 抛出点） */
export function recordLifecycleInvalidMetric(): void {
  counters.lifecycleInvalid += 1;
}

/** 冻结/终止业务拦截计数（4031 抛出点，SaasLifecycleGuard 消费） */
export function recordTenantSuspendedRejectedMetric(): void {
  counters.tenantSuspendedRejected += 1;
}

/** 到期巡检动作计数（result ∈ expired / frozen / failed，SaasLifecycleJobs 消费） */
export function recordSweepMetric(result: string): void {
  counters.sweep[result] = (counters.sweep[result] ?? 0) + 1;
}

/** 指标段是否启用（METRICS_SAAS_SECTION_ENABLED，默认 on） */
export function isSaasMetricsSectionEnabled(): boolean {
  return process.env.METRICS_SAAS_SECTION_ENABLED !== 'false';
}

/** 渲染 Prometheus 文本段（禁用或全零时仍输出结构，便于告警规则静态引用） */
export function renderSaasMetricsSection(): string {
  if (!isSaasMetricsSectionEnabled()) return '';
  const lines: string[] = [];
  lines.push('# HELP fw_saas_quota_checks_total 限额检查计数（按执行方式）');
  lines.push('# TYPE fw_saas_quota_checks_total counter');
  for (const execution of ['soft', 'hard', 'observe'] as const) {
    lines.push(`fw_saas_quota_checks_total{execution="${execution}"} ${counters.quotaChecks[execution]}`);
  }
  lines.push('# HELP fw_saas_quota_exceeded_total 硬限额拒绝计数（4029）');
  lines.push('# TYPE fw_saas_quota_exceeded_total counter');
  lines.push(`fw_saas_quota_exceeded_total ${counters.quotaExceeded}`);
  lines.push('# HELP fw_saas_usage_deduped_total 用量幂等键去重计数');
  lines.push('# TYPE fw_saas_usage_deduped_total counter');
  lines.push(`fw_saas_usage_deduped_total ${counters.usageDeduped}`);
  lines.push('# HELP fw_saas_lifecycle_transitions_total 生命周期迁移计数（按动作）');
  lines.push('# TYPE fw_saas_lifecycle_transitions_total counter');
  for (const action of ['activate', 'expire', 'freeze', 'resume', 'terminate', 'dispose'] as const) {
    lines.push(`fw_saas_lifecycle_transitions_total{action="${action}"} ${counters.lifecycleTransitions[action] ?? 0}`);
  }
  lines.push('# HELP fw_saas_lifecycle_invalid_total 非法生命周期迁移拒绝计数（4030）');
  lines.push('# TYPE fw_saas_lifecycle_invalid_total counter');
  lines.push(`fw_saas_lifecycle_invalid_total ${counters.lifecycleInvalid}`);
  lines.push('# HELP fw_saas_tenant_suspended_rejected_total 冻结/终止租户业务拦截计数（4031）');
  lines.push('# TYPE fw_saas_tenant_suspended_rejected_total counter');
  lines.push(`fw_saas_tenant_suspended_rejected_total ${counters.tenantSuspendedRejected}`);
  lines.push('# HELP fw_saas_sweep_total 到期巡检动作计数（按结果）');
  lines.push('# TYPE fw_saas_sweep_total counter');
  for (const result of Object.keys(counters.sweep).sort()) {
    lines.push(`fw_saas_sweep_total{result="${result}"} ${counters.sweep[result]}`);
  }
  if (Object.keys(counters.sweep).length === 0) {
    lines.push('fw_saas_sweep_total 0');
  }
  return lines.join('\n');
}

/** 计数器清零（测试注入用） */
export function resetSaasMetrics(): void {
  counters.quotaChecks = { soft: 0, hard: 0, observe: 0 };
  counters.quotaExceeded = 0;
  counters.usageDeduped = 0;
  counters.lifecycleTransitions = {};
  counters.lifecycleInvalid = 0;
  counters.tenantSuspendedRejected = 0;
  counters.sweep = {};
}

// 进程内注册到 /metrics（模块级汇；段名唯一，后注册覆盖）
registerMetricsSection('saas', renderSaasMetricsSection);
