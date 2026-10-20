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
 *     fw_auth_audit_dropped_total{path,reason}  审计事件限流丢弃（M15：login / authz 两条
 *       真实调用路径 × rate_limited / capacity 两种原因）——限流器 `stats()` 只是进程内视图，
 *       丢弃经此序列与周期性汇总结构化日志进入运维面，回答「审计样本是否正在大量丢失」。
 *   基数护栏（硬约束）：label 仅允许低基数枚举（result / reason / path），禁止 userId / familyId /
 *   jti / tokenId / 维度键原文入 label（租户/用户维度走审计表，不进 Prometheus，PRD-012 §6.6）。
 *   段开关：METRICS_AUTH_SECTION_ENABLED（默认开启；关闭则 /metrics 不渲染该段；周期性汇总
 *   日志与开关无关——日志正是指标抓取不可用时的兜底）。
 * @author donttemo
 * @created 2026-10-17
 * @modified 2026-10-21 donttemo M15 P2 观测闭环：新增 fw_auth_audit_dropped_total 序列与
 *   recordAuditThrottleDrop（计数 + 每路径每窗口最多一条的周期性汇总日志，防日志放大）
 * @module @fw/auth
 */

import { registerMetricsSection } from '@fw/core';
import { Logger } from '@fw/logger';
import type { AuditThrottleDropReason } from './audit-throttle.js';

/** result 维度 */
type Result = 'success' | 'failed';
/** verify 失败原因（与 TokenVerifyReason 同枚举） */
export type VerifyFailReason = 'missing' | 'expired' | 'invalid';
/** 审计限流丢弃的调用路径（低基数枚举：登录失败 / 越权拒绝两条真实路径） */
export type AuditThrottlePath = 'login' | 'authz';

/** 周期性汇总日志的最小间隔（毫秒）：与限流窗口同阶——丢弃是运维信号，但不能被攻击者刷成日志放大 */
const AUDIT_DROP_LOG_INTERVAL_MS = 60_000;

const dropLogger = Logger.for('auth.metrics');

/** 计数器状态（模块级，进程生命周期内累计） */
const counters = {
  login: { success: 0, failed: 0 },
  refresh: { success: 0, failed: 0 },
  verifyFailed: { missing: 0, expired: 0, invalid: 0 } as Record<VerifyFailReason, number>,
  replayDetected: {} as Record<string, number>,
  familyRevoked: 0,
  /** 审计限流丢弃：`${path}:${reason}` → 累计次数 */
  auditThrottleDropped: {} as Record<string, number>,
};

/** 每路径的汇总日志状态：上次输出时刻 + 区间累计（lastLoggedAt=0 表示从未输出） */
interface DropLogState {
  lastLoggedAt: number;
  /** 区间累计，键为 AuditThrottleDropReason（与指标 label 同口径，避免驼峰/蛇形键位错位） */
  counts: Record<AuditThrottleDropReason, number>;
}

const dropLogState: Record<AuditThrottlePath, DropLogState> = {
  login: { lastLoggedAt: 0, counts: { rate_limited: 0, capacity: 0 } },
  authz: { lastLoggedAt: 0, counts: { rate_limited: 0, capacity: 0 } },
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

/**
 * 记录一次审计事件限流丢弃（登录失败 / 越权拒绝两条真实调用路径经限流器 onDrop 接入）
 *
 * 双通道观测：① `fw_auth_audit_dropped_total{path,reason}` 计数器（/metrics 可查询，
 * 告警规则直接消费）；② 周期性汇总结构化日志（每路径每窗口最多一条）——指标抓取
 * 不可用时的兜底，也是限流器注释中「结构化日志兜底」的落实。
 *
 * 汇总日志**只含低基数计数**（path + 两种原因的区间次数），不含维度键原文：
 * key 里有 IP / 账号 / 权限串，逐条或原样输出都会把丢弃变成攻击者可控的放大面；
 * 「谁在被打」以保留下来的前 N 条审计样本为准。
 * @param path 调用路径（login / authz）
 * @param reason 丢弃原因（rate_limited / capacity）
 * @param now 当前时间（测试注入；生产走默认）
 */
export function recordAuditThrottleDrop(path: AuditThrottlePath, reason: AuditThrottleDropReason, now = Date.now()): void {
  const series = `${path}:${reason}`;
  counters.auditThrottleDropped[series] = (counters.auditThrottleDropped[series] ?? 0) + 1;
  emitDropSummaryLog(path, reason, now);
}

/**
 * 周期性汇总日志：每路径每窗口最多一条；时钟回拨（now < lastLoggedAt）时视为已到下一窗口，
 * 避免长时间误判「刚输出过」而一直抑制（与 AuditEventThrottle.prune 同口径）。
 * ctx 计数键与指标 label 的 reason 取值同口径（rate_limited / capacity），便于日志与指标互查。
 */
function emitDropSummaryLog(path: AuditThrottlePath, reason: AuditThrottleDropReason, now: number): void {
  const state = dropLogState[path];
  state.counts[reason] += 1;
  if (state.lastLoggedAt !== 0 && now >= state.lastLoggedAt && now - state.lastLoggedAt < AUDIT_DROP_LOG_INTERVAL_MS) return;
  state.lastLoggedAt = now;
  dropLogger.warn('审计事件限流丢弃周期性汇总', {
    path,
    intervalMs: AUDIT_DROP_LOG_INTERVAL_MS,
    rate_limited: state.counts.rate_limited,
    capacity: state.counts.capacity,
  });
  state.counts.rate_limited = 0;
  state.counts.capacity = 0;
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
  // 审计限流丢弃（M15）：四条固定序列恒输出（含 0），告警规则可静态引用而无需等首条丢弃
  lines.push('# HELP fw_auth_audit_dropped_total 审计事件限流丢弃计数（按调用路径与原因；丢弃样本另有周期性汇总日志兜底）');
  lines.push('# TYPE fw_auth_audit_dropped_total counter');
  for (const path of ['login', 'authz'] as const) {
    for (const reason of ['rate_limited', 'capacity'] as const) {
      lines.push(`fw_auth_audit_dropped_total{path="${path}",reason="${reason}"} ${counters.auditThrottleDropped[`${path}:${reason}`] ?? 0}`);
    }
  }
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
  counters.auditThrottleDropped = {};
  for (const state of Object.values(dropLogState)) {
    state.lastLoggedAt = 0;
    state.counts.rate_limited = 0;
    state.counts.capacity = 0;
  }
}

// 进程内注册到 /metrics（模块级汇；段名唯一，后注册覆盖）
registerMetricsSection('auth_security', renderAuthMetricsSection);
