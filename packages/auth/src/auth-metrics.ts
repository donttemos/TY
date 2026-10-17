/*
 * @file auth / security 指标段
 * @description M12 W2（PRD-012 OBS-12，命名规范沿 PRD-011 S-33 `fw_<域>_<指标>_<单位>`）：
 *   进程内自研计数器（零新依赖，NG12-3 不引 prom-client），经 @fw/core 指标段注册表挂到 /metrics。
 *   段内容：
 *     fw_auth_login_total{result}            登录成功 / 失败
 *     fw_auth_refresh_total{result}          refresh 轮换成功 / 失败
 *     fw_auth_token_verify_failed_total{reason}  令牌校验失败按原因（missing / expired / invalid）
 *     fw_security_replay_detected_total{reason}  replay 安全事件按低基数原因
 *     fw_security_family_revoked_total       令牌族撤销数
 *   基数护栏（硬约束）：label 仅允许低基数枚举（result / reason），禁止 userId / familyId /
 *   jti / tokenId 入 label（租户/用户维度走审计表，不进 Prometheus，PRD-012 §6.6）。
 *   段开关：METRICS_AUTH_SECTION_ENABLED（默认开启；关闭则 /metrics 不渲染该段）。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/auth
 */

import { registerMetricsSection } from '@fw/core';

/** result 维度 */
type Result = 'success' | 'failed';
/** verify 失败原因（与 TokenVerifyReason 同枚举） */
export type VerifyFailReason = 'missing' | 'expired' | 'invalid';

/** 计数器状态（模块级，进程生命周期内累计） */
const counters = {
  login: { success: 0, failed: 0 },
  refresh: { success: 0, failed: 0 },
  verifyFailed: { missing: 0, expired: 0, invalid: 0 } as Record<VerifyFailReason, number>,
  replayDetected: {} as Record<string, number>,
  familyRevoked: 0,
};

/** 登录结果计数 */
export function recordLoginMetric(result: Result): void {
  counters.login[result] += 1;
}

/** refresh 轮换结果计数 */
export function recordRefreshMetric(result: Result): void {
  counters.refresh[result] += 1;
}

/** 令牌校验失败按原因计数 */
export function recordTokenVerifyFailedMetric(reason: VerifyFailReason): void {
  counters.verifyFailed[reason] = (counters.verifyFailed[reason] ?? 0) + 1;
}

/** replay 安全事件按原因计数（reason 为低基数 ReplayReason 枚举，ADR-0025 §2.4） */
export function recordReplayDetectedMetric(reason: string): void {
  counters.replayDetected[reason] = (counters.replayDetected[reason] ?? 0) + 1;
}

/** 令牌族撤销计数 */
export function recordFamilyRevokedMetric(count = 1): void {
  counters.familyRevoked += count;
}

/** 指标段是否启用（METRICS_AUTH_SECTION_ENABLED，默认 on；渲染时判定） */
export function isAuthMetricsSectionEnabled(): boolean {
  return process.env.METRICS_AUTH_SECTION_ENABLED !== 'false';
}

/** 渲染 Prometheus 文本段（ HELP / TYPE + 样本行；禁用或全零时仍输出结构，便于告警规则静态引用） */
export function renderAuthMetricsSection(): string {
  if (!isAuthMetricsSectionEnabled()) return '';
  const lines: string[] = [];
  lines.push('# HELP fw_auth_login_total 登录请求计数（按结果）');
  lines.push('# TYPE fw_auth_login_total counter');
  for (const result of ['success', 'failed'] as const) {
    lines.push(`fw_auth_login_total{result="${result}"} ${counters.login[result]}`);
  }
  lines.push('# HELP fw_auth_refresh_total refresh 轮换请求计数（按结果）');
  lines.push('# TYPE fw_auth_refresh_total counter');
  for (const result of ['success', 'failed'] as const) {
    lines.push(`fw_auth_refresh_total{result="${result}"} ${counters.refresh[result]}`);
  }
  lines.push('# HELP fw_auth_token_verify_failed_total 令牌校验失败计数（按原因）');
  lines.push('# TYPE fw_auth_token_verify_failed_total counter');
  for (const reason of ['missing', 'expired', 'invalid'] as const) {
    lines.push(`fw_auth_token_verify_failed_total{reason="${reason}"} ${counters.verifyFailed[reason] ?? 0}`);
  }
  lines.push('# HELP fw_security_replay_detected_total replay 安全事件计数（按低基数原因）');
  lines.push('# TYPE fw_security_replay_detected_total counter');
  for (const reason of Object.keys(counters.replayDetected).sort()) {
    lines.push(`fw_security_replay_detected_total{reason="${reason}"} ${counters.replayDetected[reason]}`);
  }
  if (Object.keys(counters.replayDetected).length === 0) {
    lines.push('fw_security_replay_detected_total 0');
  }
  lines.push('# HELP fw_security_family_revoked_total 令牌族撤销计数');
  lines.push('# TYPE fw_security_family_revoked_total counter');
  lines.push(`fw_security_family_revoked_total ${counters.familyRevoked}`);
  return lines.join('\n');
}

/** 计数器清零（测试注入用） */
export function resetAuthMetrics(): void {
  counters.login.success = 0;
  counters.login.failed = 0;
  counters.refresh.success = 0;
  counters.refresh.failed = 0;
  counters.verifyFailed = { missing: 0, expired: 0, invalid: 0 };
  counters.replayDetected = {};
  counters.familyRevoked = 0;
}

// 进程内注册到 /metrics（模块级汇；段名唯一，后注册覆盖）
registerMetricsSection('auth_security', renderAuthMetricsSection);
