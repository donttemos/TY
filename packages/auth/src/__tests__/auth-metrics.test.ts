/*
 * @file auth / security 指标段契约（PRD-012 OBS-12，ADR-0025 §2.4）
 * @description ① 构造登录失败 / replay 各一例后计数正确；② 基数护栏反向验证：渲染文本不含
 *   userId / familyId / jti 等高基数字段值（label 仅低基数枚举 reason/result）；
 *   ③ METRICS_AUTH_SECTION_ENABLED=false 时该段消失；④ 计数 API 与渲染命名规范
 *   `fw_<域>_<指标>_<单位>`（与 PRD-011 S-33 共用）。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/auth
 */
import { afterEach, describe, expect, it } from 'vitest';
import { runWithRequestContext } from '@fw/logger';
import {
  recordFamilyRevokedMetric,
  recordLoginMetric,
  recordReplayDetectedMetric,
  recordRefreshMetric,
  recordTokenVerifyFailedMetric,
  renderAuthMetricsSection,
  resetAuthMetrics,
} from '../auth-metrics.js';

describe('M12 W2 · auth/security 指标段（OBS-12）', () => {
  afterEach(() => {
    delete process.env.METRICS_AUTH_SECTION_ENABLED;
    resetAuthMetrics();
  });

  it('登录失败 / 成功、verify 失败按 reason 计数正确', () => {
    recordLoginMetric('failed');
    recordLoginMetric('failed');
    recordLoginMetric('success');
    recordTokenVerifyFailedMetric('expired');
    recordRefreshMetric('success');
    const text = renderAuthMetricsSection();
    expect(text).toContain('fw_auth_login_total{result="failed"} 2');
    expect(text).toContain('fw_auth_login_total{result="success"} 1');
    expect(text).toContain('fw_auth_token_verify_failed_total{reason="expired"} 1');
    expect(text).toContain('fw_auth_refresh_total{result="success"} 1');
  });

  it('replay 安全事件按低基数 reason 计数 + 族撤销计数', () => {
    recordReplayDetectedMetric('no_replacement');
    recordReplayDetectedMetric('fingerprint_mismatch');
    recordFamilyRevokedMetric();
    const text = renderAuthMetricsSection();
    expect(text).toContain('fw_security_replay_detected_total{reason="no_replacement"} 1');
    expect(text).toContain('fw_security_replay_detected_total{reason="fingerprint_mismatch"} 1');
    expect(text).toContain('fw_security_family_revoked_total 1');
  });

  it('基数护栏反向验证：身份进 ALS 时渲染文本不含任何高基数字段值', () => {
    runWithRequestContext(
      {
        traceId: 't-guard',
        spanId: '',
        requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV',
        userId: 'user-high-cardinality-42',
        familyId: 'family-high-cardinality-77',
        jti: 'jti-high-cardinality-99',
      },
      () => undefined,
    );
    recordLoginMetric('failed');
    recordReplayDetectedMetric('no_replacement');
    recordTokenVerifyFailedMetric('invalid');
    const text = renderAuthMetricsSection();
    // label 只允许 result / reason 低基数枚举——任何身份值出现即违规
    expect(text).not.toContain('user-high-cardinality-42');
    expect(text).not.toContain('family-high-cardinality-77');
    expect(text).not.toContain('jti-high-cardinality-99');
    expect(text).not.toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    // 低基数 label 枚举白名单自检：出现的 label 键只可能是 result / reason
    for (const m of text.matchAll(/fw_[a-z_]+\{([^}]*)\}/g)) {
      for (const pair of m[1].split(',')) {
        expect(['result', 'reason']).toContain(pair.split('=')[0]);
      }
    }
  });

  it('METRICS_AUTH_SECTION_ENABLED=false 时该段消失（开关语义）', () => {
    process.env.METRICS_AUTH_SECTION_ENABLED = 'false';
    recordLoginMetric('failed');
    expect(renderAuthMetricsSection()).toBe('');
  });
});
