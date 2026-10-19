/*
 * @file 指标段测试
 * @description fw_saas_* 七计数器：record 后 render 数值断言（label 低基数枚举逐行）、
 *   reset 清零、段开关（METRICS_SAAS_SECTION_ENABLED=false 渲染空串）。
 *   注意：模块级计数器跨用例共享，先 reset 再断言；segment 注册副作用由 import 触发。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  isSaasMetricsSectionEnabled,
  recordLifecycleInvalidMetric,
  recordLifecycleTransitionMetric,
  recordQuotaCheckMetric,
  recordQuotaExceededMetric,
  recordSweepMetric,
  recordTenantSuspendedRejectedMetric,
  recordUsageDedupedMetric,
  renderSaasMetricsSection,
  resetSaasMetrics,
} from '../saas-metrics.js';

describe('fw_saas_* 指标段', () => {
  afterEach(() => {
    resetSaasMetrics();
    delete process.env.METRICS_SAAS_SECTION_ENABLED;
  });

  it('record → render 数值与低基数 label 逐行对应', () => {
    recordQuotaCheckMetric('hard');
    recordQuotaCheckMetric('hard');
    recordQuotaCheckMetric('soft');
    recordQuotaCheckMetric('observe');
    recordQuotaExceededMetric();
    recordUsageDedupedMetric();
    recordLifecycleTransitionMetric('freeze');
    recordLifecycleTransitionMetric('activate');
    recordLifecycleInvalidMetric();
    recordTenantSuspendedRejectedMetric();
    recordSweepMetric('expired');
    recordSweepMetric('frozen');
    recordSweepMetric('failed');

    const out = renderSaasMetricsSection();
    expect(out).toContain('fw_saas_quota_checks_total{execution="hard"} 2');
    expect(out).toContain('fw_saas_quota_checks_total{execution="soft"} 1');
    expect(out).toContain('fw_saas_quota_checks_total{execution="observe"} 1');
    expect(out).toContain('fw_saas_quota_exceeded_total 1');
    expect(out).toContain('fw_saas_usage_deduped_total 1');
    expect(out).toContain('fw_saas_lifecycle_transitions_total{action="freeze"} 1');
    expect(out).toContain('fw_saas_lifecycle_transitions_total{action="activate"} 1');
    expect(out).toContain('fw_saas_lifecycle_transitions_total{action="dispose"} 0');
    expect(out).toContain('fw_saas_lifecycle_invalid_total 1');
    expect(out).toContain('fw_saas_tenant_suspended_rejected_total 1');
    expect(out).toContain('fw_saas_sweep_total{result="expired"} 1');
    expect(out).toContain('fw_saas_sweep_total{result="failed"} 1');
    // 高基数护栏：tenantId / metricKey 不得作为 label 出现
    expect(out).not.toMatch(/tenantId=/);
    expect(out).not.toMatch(/metricKey=/);
  });

  it('reset 清零后渲染结构完整（全零仍输出，供告警规则静态引用）', () => {
    recordQuotaExceededMetric();
    resetSaasMetrics();
    const out = renderSaasMetricsSection();
    expect(out).toContain('fw_saas_quota_exceeded_total 0');
    expect(out).toContain('fw_saas_sweep_total 0');
    expect(out).toContain('# HELP fw_saas_quota_exceeded_total');
    expect(out).toContain('# TYPE fw_saas_quota_exceeded_total counter');
  });

  it('段开关：METRICS_SAAS_SECTION_ENABLED=false 渲染空串', () => {
    process.env.METRICS_SAAS_SECTION_ENABLED = 'false';
    expect(isSaasMetricsSectionEnabled()).toBe(false);
    expect(renderSaasMetricsSection()).toBe('');
  });
});
