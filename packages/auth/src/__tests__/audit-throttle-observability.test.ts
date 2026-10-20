/*
 * @file 审计限流丢弃的运维观测闭环（PRD-015 FR-15-12 / ADR-0032 R6，M15 P2）
 * @description 限流器的 `stats()` 只是进程内视图；本文件验证丢弃在**真实调用路径**可观测：
 *   ① 登录失败路径（AuthService.login → recordLoginFailure）：同一（IP+账号）第 4 次起被
 *      限流丢弃 → `fw_auth_audit_dropped_total{path="login",reason="rate_limited"}` 计数，
 *      审计行仍只有 3 条样本；周期性汇总结构化日志同步兜底（不含维度键原文）；
 *   ② 容量路径（同一真实路径，注入 maxBuckets=2）：维度键打满后新键被拒 →
 *      `fw_auth_audit_dropped_total{path="login",reason="capacity"}` 计数；
 *   ③ 越权路径（RbacGuard.canActivate）：同一（用户+权限码）第 4 次起丢弃 →
 *      `fw_auth_audit_dropped_total{path="authz",reason="rate_limited"}` 计数，审计行只有 3 条。
 *   业务语义不变：该拒绝的照常拒绝（错误码不变），只是丢弃不再对运维静默。
 * @author donttemo
 * @created 2026-10-21
 * @module @fw/auth
 */
import { Reflector } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { ErrorCode } from '@fw/core';
import { configureLogger } from '@fw/logger';
import { META_PERMISSIONS, PERM } from '../constants.js';
import { renderAuthMetricsSection, resetAuthMetrics } from '../auth-metrics.js';
import { RbacGuard } from '../rbac.guard.js';
import { ApiKeyStrategy, JwtStrategy, StrategyRegistry } from '../strategies.js';
import { createHarness, fakeContext, flushAsync, makeRequest } from './test-helpers.js';

/** 打元数据（不用装饰器语法，避免依赖 esbuild 的装饰器转译；与 rbac.guard.test.ts 同款） */
function meta(target: object, key: string | symbol, value: unknown): void {
  Reflect.defineMetadata(key, value, target);
}

const controller = class TestController {};
const DEFAULT_SINK = (line: string): void => process.stdout.write(line + '\n');

describe('M15 P2 · 审计限流丢弃在真实调用路径可观测（FR-15-12 / ADR-0032 R6）', () => {
  it('登录失败路径：第 4 次起限流丢弃进入指标与周期性汇总日志，审计样本仍只有 3 条', async () => {
    const h = createHarness();
    await h.seed();
    resetAuthMetrics();

    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line) });
    try {
      // 同一（IP+账号）连续 5 次密码错误：业务每次照常拒绝（第 5 次触发账号锁定，不影响观测）
      for (let attempt = 0; attempt < 5; attempt += 1) {
        await h.service.login({ account: 'admin', password: 'bad', ip: '10.0.0.1', userAgent: 'brute-force-agent' }).catch(() => undefined);
      }
      await flushAsync();

      // ① 指标：限流丢弃 2 次（第 4/5 次），容量丢弃 0 次
      const metrics = renderAuthMetricsSection();
      expect(metrics).toContain('fw_auth_audit_dropped_total{path="login",reason="rate_limited"} 2');
      expect(metrics).toContain('fw_auth_audit_dropped_total{path="login",reason="capacity"} 0');

      // ② 审计：只保留前 3 条样本（限流不影响抛错，也不影响已放行样本的完整性）
      const rows = await h.audit.page({ page: 1, pageSize: 20, event: 'auth.login_failed' });
      expect(rows.total).toBe(3);

      // ③ 周期性汇总结构化日志：兜底通道确实被走到，且只含低基数计数（维度键原文不出日志）。
      //    口径说明：汇总日志是「距上次输出的区间累计」（首条立即输出，窗口内后续抑制），
      //    指标是进程内累计——两者都承载丢弃信号，只是累计窗口不同。
      const summaries = lines.filter((l) => l.includes('审计事件限流丢弃周期性汇总'));
      expect(summaries).toHaveLength(1);
      // LogRecord 结构：调用方 ctx 落在 json.ctx 子对象（time/level/module/msg 为顶层固定字段）；
      // ctx 计数键与指标 label 的 reason 同口径（rate_limited / capacity）
      const summary = JSON.parse(summaries[0]).ctx as { path?: string; rate_limited?: number; capacity?: number };
      expect(summary.path).toBe('login');
      expect(summary.rate_limited).toBe(1);
      expect(summary.capacity).toBe(0);
      expect(summaries.join('\n')).not.toContain('login:10.0.0.1:admin');
    } finally {
      configureLogger({ sink: DEFAULT_SINK });
    }
  });

  it('登录失败路径（容量）：维度键打满后新键被拒，容量丢弃计数可观测', async () => {
    // 注入 maxBuckets=2：两个不同（IP+账号）占满后，第三个新键走容量丢弃
    const h = createHarness({}, { maxBuckets: 2 });
    await h.seed();
    resetAuthMetrics();

    for (const ip of ['10.0.0.1', '10.0.0.2', '10.0.0.3']) {
      await h.service.login({ account: 'admin', password: 'bad', ip }).catch(() => undefined);
    }
    await flushAsync();

    const metrics = renderAuthMetricsSection();
    expect(metrics).toContain('fw_auth_audit_dropped_total{path="login",reason="capacity"} 1');
    expect(metrics).toContain('fw_auth_audit_dropped_total{path="login",reason="rate_limited"} 0');

    // 前两个维度键各留 1 条样本，第三个整体丢弃（不是写进去再删）
    const rows = await h.audit.page({ page: 1, pageSize: 20, event: 'auth.login_failed' });
    expect(rows.total).toBe(2);
  });

  it('越权路径（RbacGuard）：第 4 次起限流丢弃进入指标，审计样本仍只有 3 条', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    resetAuthMetrics();

    const access = await h.tokens.signAccess({ id: seeded.normal.id, username: 'alice', roles: ['user'] }, 'fam-drop-observe');
    const probe = (): void => undefined;
    meta(probe, META_PERMISSIONS, [PERM.USER_READ]);
    const registry = new StrategyRegistry([new JwtStrategy(h.tokens, h.blacklist), new ApiKeyStrategy(h.options.apiKeys)]);
    const guard = new RbacGuard(new Reflector(), registry, h.permissions, h.store, h.options, h.audit);

    // 同一用户 + 同一权限码连打 5 次：业务每次都必须 403，审计只留 3 条样本
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const request = makeRequest({ authorization: `Bearer ${access.token}` });
      await expect(guard.canActivate(fakeContext(request, probe, controller))).rejects.toMatchObject({
        code: ErrorCode.FORBIDDEN,
      });
    }
    await flushAsync();

    const metrics = renderAuthMetricsSection();
    expect(metrics).toContain('fw_auth_audit_dropped_total{path="authz",reason="rate_limited"} 2');
    expect(metrics).toContain('fw_auth_audit_dropped_total{path="authz",reason="capacity"} 0');

    const rows = await h.audit.page({ page: 1, pageSize: 20, event: 'authz.denied' });
    expect(rows.total).toBe(3);
  });
});
