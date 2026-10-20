/*
 * @file 审计事件注册表与 recordEvent 单测（PRD-015 FR-15-01~06，ADR-0032 R1/R3/R5/R7）
 * @description 覆盖：注册表自检（命名/唯一/模板变量）、摘要三级生成链（枚举值翻译）、
 *   事件写入收口（module/action/category 由注册表补全、auditSource=domain）、
 *   未知事件码的严格/降级两条路径、租户与结果过滤、快照长度裁剪。
 * @author donttemo
 * @created 2026-10-20
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { runWithRequestContext } from '@fw/logger';
import { AuditService } from '../audit.service.js';
import { AuditEventThrottle } from '../audit-throttle.js';
import {
  AUDIT_EVENTS,
  auditEventCodesByRisk,
  auditEventDomain,
  auditRegistryVersion,
  findAuditEvent,
  listAuditEvents,
  renderAuditSummary,
  verifyAuditRegistry,
} from '../audit-events.js';
import { MemoryAuthStore } from '../memory-auth-store.js';
import { createHarness, flushAsync } from './test-helpers.js';
import type { AuditLogRecord } from '../types.js';

/**
 * 取全部审计行（内存实现按 createdAt 排序，同毫秒内顺序不稳定——
 * 断言一律按字段定位，不依赖行序）
 */
async function rows(store: MemoryAuthStore): Promise<AuditLogRecord[]> {
  return (await store.pageAuditLogs({ page: 1, pageSize: 50 })).items;
}

/** 按事件码取唯一一条（可叠加对象名区分同码多行） */
async function rowOf(store: MemoryAuthStore, event: string, targetLabel?: string): Promise<AuditLogRecord> {
  const matched = (await rows(store)).filter(
    (row) => row.event === event && (targetLabel === undefined || row.targetLabel === targetLabel),
  );
  expect(matched).toHaveLength(1);
  return matched[0]!;
}

describe('审计事件注册表（FR-15-01/02）', () => {
  it('注册表自检通过：码唯一、命名合规、文案与模板变量完整', () => {
    expect(verifyAuditRegistry()).toEqual([]);
  });

  it('事件码为「至少两段点分小写」，域由首段派生', () => {
    for (const definition of AUDIT_EVENTS) {
      // 两段起（domain.verb）或三段（domain.aggregate.verb），见 AUDIT_EVENT_CODE_PATTERN 注释
      expect(definition.code).toMatch(/^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*)+$/);
      expect(definition.code.split('.').length).toBeGreaterThanOrEqual(2);
      expect(auditEventDomain(definition.code)).toBe(definition.code.split('.')[0]);
    }
    expect(auditEventDomain('saas.plan.publish')).toBe('saas');
  });

  it('findAuditEvent 命中/未命中；listAuditEvents 默认排除 deprecated', () => {
    expect(findAuditEvent('saas.plan.publish')?.name).toBe('发布套餐版本');
    expect(findAuditEvent('not.registered.event')).toBeUndefined();
    expect(listAuditEvents().length).toBe(AUDIT_EVENTS.filter((item) => !item.deprecated).length);
  });

  it('风险等级 → 事件码集合（筛选按 event 集合展开，ADR-0032 R9）', () => {
    const critical = auditEventCodesByRisk('critical');
    expect(critical).toContain('refresh.replay_detected');
    expect(critical).toContain('saas.lifecycle.terminate');
    expect(critical.every((code) => findAuditEvent(code)?.risk === 'critical')).toBe(true);
  });

  it('摘要模板按 changeFields 的 valueLabels 翻译枚举值', () => {
    const freeze = findAuditEvent('saas.lifecycle.freeze')!;
    const summary = renderAuditSummary(freeze, { targetLabel: '示例企业', from: '正常', to: '冻结', reason: '欠费' });
    expect(summary).toBe('将租户「示例企业」由正常变更为冻结（原因：欠费）');
  });

  it('注册表版本指纹稳定且为 8 位十六进制', () => {
    const version = auditRegistryVersion();
    expect(version).toMatch(/^[0-9a-f]{8}$/);
    expect(auditRegistryVersion()).toBe(version);
  });
});

describe('AuditService.recordEvent（FR-15-03/04/05/06）', () => {
  it('注册表补全 module/action/category/targetType，默认 result=success、来源 domain', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.plan.create', {
      userId: 'u-1',
      targetId: 'plan-9',
      targetLabel: '专业版',
      after: { code: 'pro', name: '专业版', description: null },
    });

    const row = await rowOf(store, 'saas.plan.create');
    expect(row.module).toBe('saas');
    expect(row.action).toBe('create');
    expect(row.category).toBe('admin');
    expect(row.targetType).toBe('plan');
    expect(row.result).toBe('success');
    expect(row.auditSource).toBe('domain');
    expect(row.summary).toBe('创建套餐「专业版」');
    expect(row.targetLabel).toBe('专业版');
    expect(row.userId).toBe('u-1');
  });

  it('生命周期事件：摘要取 from/to 并为状态码翻译业务文案', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.lifecycle.freeze', {
      userId: 'op-1',
      targetId: '1024',
      targetLabel: '示例企业',
      reason: '欠费 30 天',
      result: 'success',
      after: { from: 'active', to: 'frozen', alreadyApplied: false },
    });

    const row = await rowOf(store, 'saas.lifecycle.freeze');
    expect(row.summary).toBe('将租户「示例企业」由正常变更为冻结（原因：欠费 30 天）');
    expect(row.reason).toBe('欠费 30 天');
    expect(row.category).toBe('tenant');
    expect(row.action).toBe('update');
  });

  it('调用点显式摘要优先于注册表模板（R3 第一优先级）', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.plan.create', { targetLabel: '基础版', summary: '由运营手工补充的摘要' });
    expect((await rowOf(store, 'saas.plan.create')).summary).toBe('由运营手工补充的摘要');
  });

  it('denied / failed / unknown 必须显式声明，不被默认值吞掉（R5）', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.quota.exceeded', { targetId: 't-1', result: 'denied', after: { quotaKey: 'order.monthly' } });
    await audit.recordEventSync('saas.subscription.cancel', { targetId: 'sub-1', result: 'failed', reason: '下游超时' });
    await audit.recordEventSync('saas.subscription.create', { targetId: 'sub-2', result: 'unknown' });

    const byEvent = new Map((await rows(store)).map((row) => [row.event, row.result]));
    expect(byEvent.get('saas.quota.exceeded')).toBe('denied');
    expect(byEvent.get('saas.subscription.cancel')).toBe('failed');
    expect(byEvent.get('saas.subscription.create')).toBe('unknown');
  });

  it('租户取自请求上下文（修复恒 0）；显式入参优先', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await runWithRequestContext({ traceId: 'trace-1', spanId: '', tenantId: '2048', requestId: 'req-1' }, async () => {
      await audit.recordEventSync('saas.plan.create', { targetLabel: 'ctx' });
    });
    const ctxRow = await rowOf(store, 'saas.plan.create', 'ctx');
    expect(ctxRow.tenantId).toBe('2048');
    expect(ctxRow.requestId).toBe('req-1');
    expect(ctxRow.traceId).toBe('trace-1');

    await audit.recordEventSync('saas.plan.create', { targetLabel: 'explicit', tenantId: '7' });
    const explicit = await rowOf(store, 'saas.plan.create', 'explicit');
    expect(explicit.tenantId).toBe('7');
  });

  it('无请求上下文时租户落 0（未知/存量语义），不抛错', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.plan.create', { targetLabel: 'z' });
    expect((await rowOf(store, 'saas.plan.create')).tenantId).toBe('0');
  });

  it('快照超长裁剪并以省略号标记（不静默丢字段）', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.plan.create', { targetLabel: 'A'.repeat(200), summary: 'B'.repeat(400) });
    const row = await rowOf(store, 'saas.plan.create');
    expect(row.targetLabel).toHaveLength(128);
    expect(row.targetLabel?.endsWith('…')).toBe(true);
    expect(row.summary).toHaveLength(255);
    expect(row.summary?.endsWith('…')).toBe(true);
  });

  it('未知事件码：严格模式同步抛 400（开发期暴露拼写错误）', () => {
    const audit = new AuditService(new MemoryAuthStore(), { strictEvents: true });
    expect(() => audit.recordEvent('saas.plan.publsh', { targetLabel: 'x' })).toThrowError(/未登记的审计事件码/);
  });

  it('未知事件码：生产降级为原样落库（审计不得丢事件、不得阻塞业务）', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store, { strictEvents: false });
    await audit.recordEventSync('saas.plan.publsh', { targetLabel: 'x', result: 'failed' });
    const row = await rowOf(store, 'saas.plan.publsh');
    expect(row.module).toBe('saas');
    expect(row.result).toBe('failed');
    expect(row.auditSource).toBe('domain');
  });
});

describe('审计查询：结果与租户过滤（FR-15-05/06）', () => {
  it('result / tenantId 精确过滤，可与事件组合', async () => {
    const store = new MemoryAuthStore();
    const audit = new AuditService(store);
    await audit.recordEventSync('saas.plan.create', { targetLabel: 'a', tenantId: '11' });
    await audit.recordEventSync('saas.quota.exceeded', { targetId: 't-9', tenantId: '11', result: 'denied' });
    await audit.recordEventSync('saas.plan.create', { targetLabel: 'b', tenantId: '22' });

    expect((await store.pageAuditLogs({ page: 1, pageSize: 10, result: 'denied' })).total).toBe(1);
    expect((await store.pageAuditLogs({ page: 1, pageSize: 10, tenantId: '11' })).total).toBe(2);
    expect((await store.pageAuditLogs({ page: 1, pageSize: 10, tenantId: '11', result: 'success' })).total).toBe(1);
    expect((await store.pageAuditLogs({ page: 1, pageSize: 10, tenantId: '0' })).total).toBe(0);
  });
});

describe('认证事件覆盖（PRD-015 FR-15-08）', () => {
  it('登录成功：auth.login + 中文摘要 + 来源 domain', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    await h.service.login({ account: 'admin', password: seeded.adminPassword, ip: '10.1.1.1', userAgent: 'jest' });
    await flushAsync();

    const rows = await h.audit.page({ page: 1, pageSize: 10, event: 'auth.login' });
    expect(rows.total).toBe(1);
    expect(rows.items[0]).toMatchObject({
      event: 'auth.login',
      action: 'login',
      category: 'auth',
      result: 'success',
      auditSource: 'domain',
      targetLabel: 'admin',
    });
    expect(rows.items[0].summary).toBe('用户「admin」登录成功（方式：口令）');
  });

  it('登录失败：denied + 低基数原因；同 IP+账号每分钟只留 3 条（防洪）', async () => {
    const h = createHarness();
    await h.seed();
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await h.service.login({ account: 'ghost', password: 'whatever', ip: '10.9.9.9' }).catch(() => undefined);
    }
    await flushAsync();

    const rows = await h.audit.page({ page: 1, pageSize: 20, event: 'auth.login_failed' });
    expect(rows.total).toBe(3);
    expect(rows.items[0]).toMatchObject({
      category: 'security',
      result: 'denied',
      auditSource: 'domain',
      reason: 'bad_credentials',
    });
    expect(rows.items[0].summary).toBe('用户「ghost」登录失败（原因：账号或密码错误）');
    // 不落任何口令类字段（脱敏底线）
    expect(JSON.stringify(rows.items[0].afterValue)).not.toContain('whatever');
  });

  it('禁用账号登录失败：原因归为 account_locked（与口令错误可区分）', async () => {
    const h = createHarness();
    const seeded = await h.seed();
    await h.store.updateUser(seeded.normal.id, { status: 0 });
    await h.service.login({ account: 'alice', password: 'Alice@12345', ip: '10.2.2.2' }).catch(() => undefined);
    await flushAsync();

    const rows = await h.audit.page({ page: 1, pageSize: 10, event: 'auth.login_failed' });
    expect(rows.total).toBe(1);
    expect(rows.items[0].reason).toBe('account_locked');
  });
});

describe('审计事件限流器（ADR-0032 R6）', () => {
  it('窗口内放行 max 条，跨窗口重新计数；reset 清空', () => {
    const throttle = new AuditEventThrottle();
    const start = 1_000_000;
    expect(throttle.allow('k', 2, 60_000, start)).toBe(true);
    expect(throttle.allow('k', 2, 60_000, start + 1)).toBe(true);
    expect(throttle.allow('k', 2, 60_000, start + 2)).toBe(false);
    expect(throttle.allow('k', 2, 60_000, start + 60_000)).toBe(true);
    expect(throttle.allow('other', 2, 60_000, start + 3)).toBe(true);
    throttle.reset();
    expect(throttle.allow('k', 2, 60_000, start + 4)).toBe(true);
  });
});
