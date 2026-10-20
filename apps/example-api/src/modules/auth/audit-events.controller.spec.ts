/*
 * @file 审计事件注册表端点契约（PRD-015 FR-15-01）
 * @description `GET /api/v1/audit-logs/events` 的最小单元锁定：
 *   返回注册表定义与 version 指纹；事件码集合稳定；不依赖请求上下文。
 *   路由顺序（必须声明在 `:id` 之前）由 Nest 声明顺序保证，此处校验方法本身可用。
 * @author donttemo
 * @created 2026-10-20
 * @module example-api/auth
 */
import { describe, expect, it } from 'vitest';
import { AuditController } from './audit.controller.js';
import type { JobCenterService } from '../jobs/job-center.service.js';
import type { JobRunnerRegistry } from '../jobs/job-runner.registry.js';

/** 构造控制器：本用例只调用 listEvents，其余依赖以最小桩替代 */
function createController(): AuditController {
  const registry = { register: () => undefined } as unknown as JobRunnerRegistry;
  return new AuditController({} as never, {} as never, {} as never, {} as unknown as JobCenterService, registry, {} as never);
}

describe('M15 · 审计事件注册表端点', () => {
  it('返回 version + items，且含已知事件定义（名称/风险/摘要模板）', () => {
    const { version, items } = createController().listEvents();
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(items.length).toBeGreaterThanOrEqual(12);

    const codes = items.map((item) => item.code);
    expect(codes).toContain('saas.plan.publish');
    expect(codes).toContain('saas.lifecycle.freeze');
    expect(codes).toContain('refresh.replay_detected');
    // 事件码唯一（注册表契约：码是稳定标识）
    expect(new Set(codes).size).toBe(codes.length);

    const freeze = items.find((item) => item.code === 'saas.lifecycle.freeze')!;
    expect(freeze.name).toBe('冻结租户');
    expect(freeze.risk).toBe('high');
    expect(freeze.reviewRequired).toBe(true);
    expect(freeze.changeFields?.to?.valueLabels?.['3']).toBe('冻结');
  });
});
