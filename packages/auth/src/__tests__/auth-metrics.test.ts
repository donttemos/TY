/*
 * @file auth / security 指标段契约（PRD-012 OBS-12，ADR-0025 §2.4）
 * @description ① 构造登录失败 / replay 各一例后计数正确；② 基数护栏反向验证：渲染文本不含
 *   userId / familyId / jti 等高基数字段值（label 仅低基数枚举 reason/result/path）；
 *   ③ METRICS_AUTH_SECTION_ENABLED=false 时该段消失；④ 计数 API 与渲染命名规范
 *   `fw_<域>_<指标>_<单位>`（与 PRD-011 S-33 共用）；⑤ 审计限流丢弃序列（M15 P2：
 *   fw_auth_audit_dropped_total 四序列恒输出）+ 周期性汇总日志每路径每窗口最多一条。
 * @author donttemo
 * @created 2026-10-17
 * @modified 2026-10-21 donttemo M15 P2 观测闭环：补审计限流丢弃计数、label 白名单加 path、
 *   周期性汇总日志门限与内容（低基数、不含维度键原文）用例
 * @module @fw/auth
 */
import { afterEach, describe, expect, it } from 'vitest';
import { configureLogger, runWithRequestContext } from '@fw/logger';
import {
  recordAuditThrottleDrop,
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
    recordAuditThrottleDrop('login', 'rate_limited');
    const text = renderAuthMetricsSection();
    // label 只允许 result / reason 低基数枚举——任何身份值出现即违规
    expect(text).not.toContain('user-high-cardinality-42');
    expect(text).not.toContain('family-high-cardinality-77');
    expect(text).not.toContain('jti-high-cardinality-99');
    expect(text).not.toContain('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    // 低基数 label 枚举白名单自检：出现的 label 键只可能是 result / reason
    for (const m of text.matchAll(/fw_[a-z_]+\{([^}]*)\}/g)) {
      for (const pair of m[1].split(',')) {
        expect(['result', 'reason', 'path']).toContain(pair.split('=')[0]);
      }
    }
  });

  it('METRICS_AUTH_SECTION_ENABLED=false 时该段消失（开关语义）', () => {
    process.env.METRICS_AUTH_SECTION_ENABLED = 'false';
    recordLoginMetric('failed');
    expect(renderAuthMetricsSection()).toBe('');
  });

  it('M15 P2：审计限流丢弃按 path × reason 计数，四条固定序列恒输出（含 0）', () => {
    recordAuditThrottleDrop('login', 'rate_limited');
    recordAuditThrottleDrop('login', 'rate_limited');
    recordAuditThrottleDrop('authz', 'capacity');
    const text = renderAuthMetricsSection();
    expect(text).toContain('fw_auth_audit_dropped_total{path="login",reason="rate_limited"} 2');
    expect(text).toContain('fw_auth_audit_dropped_total{path="login",reason="capacity"} 0');
    expect(text).toContain('fw_auth_audit_dropped_total{path="authz",reason="rate_limited"} 0');
    expect(text).toContain('fw_auth_audit_dropped_total{path="authz",reason="capacity"} 1');
    // reset 后归零（序列仍在，告警规则可静态引用）
    resetAuthMetrics();
    expect(renderAuthMetricsSection()).toContain('fw_auth_audit_dropped_total{path="login",reason="rate_limited"} 0');
  });

  it('M15 P2：周期性汇总日志每路径每窗口最多一条；内容只含低基数计数，不含维度键原文', () => {
    const lines: string[] = [];
    const defaultSink = (line: string): void => process.stdout.write(line + '\n');
    configureLogger({ sink: (line) => lines.push(line) });
    try {
      // 同一路径首条丢弃立即输出；窗口内的后续丢弃被抑制并累计
      recordAuditThrottleDrop('login', 'rate_limited', 1_000);
      recordAuditThrottleDrop('login', 'rate_limited', 30_000);
      recordAuditThrottleDrop('login', 'capacity', 59_000);
      const summaries = (): string[] => lines.filter((l) => l.includes('审计事件限流丢弃周期性汇总'));
      expect(summaries()).toHaveLength(1);

      // 跨过窗口（60s）后再次丢弃：输出上一窗口的累计，然后重新计数
      recordAuditThrottleDrop('login', 'rate_limited', 61_000);
      expect(summaries()).toHaveLength(2);
      // LogRecord 结构：调用方 ctx 落在 json.ctx 子对象（time/level/module/msg 为顶层固定字段）；
      // ctx 计数键与指标 label 的 reason 同口径（rate_limited / capacity）
      const second = JSON.parse(summaries()[1]).ctx as { path?: string; rate_limited?: number; capacity?: number };
      expect(second.path).toBe('login');
      expect(second.rate_limited).toBe(2);
      expect(second.capacity).toBe(1);

      // 两条路径独立门限（authz 首条不受 login 已输出影响）
      recordAuditThrottleDrop('authz', 'rate_limited', 62_000);
      expect(summaries()).toHaveLength(3);
      expect((JSON.parse(summaries()[2]).ctx as { path?: string }).path).toBe('authz');

      // 基数护栏：汇总里不出现维度键原文（IP / 账号 / 权限串都是攻击者可控的高基数数据）
      expect(summaries().join('\n')).not.toContain('login:10.0.0.1:admin');
      expect(summaries().join('\n')).not.toContain('authz:');
    } finally {
      configureLogger({ sink: defaultSink });
    }
  });
});
