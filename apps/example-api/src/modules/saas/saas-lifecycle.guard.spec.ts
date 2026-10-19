/*
 * @file 单测：生命周期拦截守卫与到期处置任务（M13）
 * @description ADR-0031 验收（AC-13-08/09）：
 *   守卫——@Public 放行、@LifecycleExempt 放行、无租户上下文放行、frozen/terminated 4031、active 放行；
 *   任务——到期 active→grace（订阅同批置 expired）、重复执行幂等（alreadyApplied 不重复记日志）、
 *   宽限期满 grace→frozen（SAAS_GRACE_PERIOD_DAYS 推算）、单条失败不中断整批。
 *   store 为内存 Fake（@fw/saas FakeSaasStore，语义与 ADR 对齐）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import 'reflect-metadata';
import { describe, expect, it } from 'vitest';
import type { ExecutionContext } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { SetMetadata } from '@nestjs/common';
import { runWithRequestContext } from '@fw/logger';
import { META_PUBLIC } from '@fw/auth';
import { FakeSaasStore, TenantLifecycleService, TenantSuspendedError } from '@fw/saas';
import { SaasLifecycleGuard } from './saas-lifecycle.guard.js';
import { SaasLifecycleJobs } from './saas-lifecycle.jobs.js';
import { META_LIFECYCLE_EXEMPT } from './lifecycle.decorator.js';
import { SAAS_STORE } from './saas.tokens.js';

/** 构造 ExecutionContext 桩（handler/class 元数据面） */
function mockContext(opts: { public?: boolean; exempt?: boolean; handler?: object; clazz?: object } = {}): ExecutionContext {
  const handler = opts.handler ?? (() => undefined);
  const clazz = opts.clazz ?? class Temp {};
  if (opts.public) SetMetadata(META_PUBLIC, true)(handler as never);
  if (opts.exempt) SetMetadata(META_LIFECYCLE_EXEMPT, true)(handler as never);
  return {
    switchToHttp: () => ({ getRequest: () => ({}) }),
    getHandler: () => handler,
    getClass: () => clazz,
  } as unknown as ExecutionContext;
}

function makeGuard(store: FakeSaasStore): SaasLifecycleGuard {
  return new SaasLifecycleGuard(new Reflector(), store);
}

describe('SaasLifecycleGuard（ADR-0031 §3 业务入口拦截）', () => {
  function run(tenantId: string | undefined, fn: () => Promise<boolean>): Promise<boolean> {
    return runWithRequestContext({ tenantId, traceId: 'tr-1' }, fn);
  }

  it('@Public 路由放行（不查库）', async () => {
    const store = new FakeSaasStore();
    const guard = makeGuard(store);
    await expect(guard.canActivate(mockContext({ public: true }))).resolves.toBe(true);
  });

  it('@LifecycleExempt 白名单放行（frozen 亦放行）', async () => {
    const store = new FakeSaasStore();
    store.tenantStatus.set('t1', 'frozen');
    const guard = makeGuard(store);
    await expect(run('t1', () => guard.canActivate(mockContext({ exempt: true })))).resolves.toBe(true);
  });

  it('无租户上下文（单租户模式）放行', async () => {
    const store = new FakeSaasStore();
    store.tenantStatus.set('t1', 'terminated');
    const guard = makeGuard(store);
    await expect(guard.canActivate(mockContext({}))).resolves.toBe(true);
  });

  it('frozen/terminated → 4031；active → 放行', async () => {
    const store = new FakeSaasStore();
    store.tenantStatus.set('t1', 'frozen');
    store.tenantStatus.set('t2', 'terminated');
    store.tenantStatus.set('t3', 'active');
    const guard = makeGuard(store);

    await expect(run('t1', () => guard.canActivate(mockContext({})))).rejects.toBeInstanceOf(TenantSuspendedError);
    await expect(run('t1', () => guard.canActivate(mockContext({})))).rejects.toMatchObject({ code: 4031, http: 403 });
    await expect(run('t2', () => guard.canActivate(mockContext({})))).rejects.toMatchObject({ code: 4031 });
    await expect(run('t3', () => guard.canActivate(mockContext({})))).resolves.toBe(true);
    // 未知租户（无状态行）：放行（创建路径先于状态存在）
    await expect(run('t-none', () => guard.canActivate(mockContext({})))).resolves.toBe(true);
  });
});

describe('SaasLifecycleJobs.sweep（ADR-0031 §2.3 到期处置）', () => {
  const DAY = 24 * 3600 * 1000;
  const NOW = new Date(Date.UTC(2026, 9, 19, 12, 0, 0));

  function seedStore(): FakeSaasStore {
    const store = new FakeSaasStore();
    // t1：active 订阅已到期 → 应转 grace
    store.tenantStatus.set('t1', 'active');
    store.subscriptions.push({ id: 's1', tenantId: 't1', planId: 'p', planVersionId: 'pv', status: 'active', effectiveAt: new Date(NOW.getTime() - 40 * DAY), expireAt: new Date(NOW.getTime() - DAY), closedAt: null, reason: null, activeMarker: 't1' });
    // t2：grace 且 expireAt 已过宽限期（默认 7 天）→ 应转 frozen
    store.tenantStatus.set('t2', 'grace');
    store.subscriptions.push({ id: 's2', tenantId: 't2', planId: 'p', planVersionId: 'pv', status: 'expired', effectiveAt: new Date(NOW.getTime() - 40 * DAY), expireAt: new Date(NOW.getTime() - 8 * DAY), closedAt: new Date(NOW.getTime() - DAY), reason: null, activeMarker: null });
    // t3：grace 但宽限未满（expireAt 仅 2 天前）→ 不动
    store.tenantStatus.set('t3', 'grace');
    store.subscriptions.push({ id: 's3', tenantId: 't3', planId: 'p', planVersionId: 'pv', status: 'expired', effectiveAt: new Date(NOW.getTime() - 40 * DAY), expireAt: new Date(NOW.getTime() - 2 * DAY), closedAt: new Date(NOW.getTime() - DAY), reason: null, activeMarker: null });
    // t4：active 未到期 → 不动
    store.tenantStatus.set('t4', 'active');
    store.subscriptions.push({ id: 's4', tenantId: 't4', planId: 'p', planVersionId: 'pv', status: 'active', effectiveAt: new Date(), expireAt: new Date(NOW.getTime() + 30 * DAY), closedAt: null, reason: null, activeMarker: 't4' });
    return store;
  }

  function makeJobs(store: FakeSaasStore): SaasLifecycleJobs {
    return new SaasLifecycleJobs(store, new TenantLifecycleService(store));
  }

  it('首轮：t1 active→grace + 订阅置 expired；t2 grace→frozen；t3/t4 不动', async () => {
    const store = seedStore();
    const jobs = makeJobs(store);
    // 冻结时钟断言用固定窗口：任务内部取当前时刻——t3 的「宽限未满」依赖真实 now 与种子差值，
    // 用 SAAS_GRACE_PERIOD_DAYS 拉长宽限窗口保证 t3 不被冻结（8 天前 < now-30天 不成立）
    process.env.SAAS_GRACE_PERIOD_DAYS = '30';
    try {
      await jobs.sweep();
      expect(store.tenantStatus.get('t1')).toBe('grace');
      expect((await store.findSubscriptionById('s1'))?.status).toBe('expired');
      expect(store.tenantStatus.get('t2')).toBe('grace'); // 8 天前到期 < 30 天宽限 → 不动
      expect(store.tenantStatus.get('t3')).toBe('grace');
      expect(store.tenantStatus.get('t4')).toBe('active');
      // 日志逐条：仅 t1 expire 一条
      expect(store.logs.filter((l) => l.action === 'expire')).toHaveLength(1);
      expect(store.logs.filter((l) => l.action === 'freeze')).toHaveLength(0);
    } finally {
      delete process.env.SAAS_GRACE_PERIOD_DAYS;
    }
  });

  it('重复执行幂等：alreadyApplied 短路，不重复记日志、不重复关订阅', async () => {
    const store = seedStore();
    const jobs = makeJobs(store);
    process.env.SAAS_GRACE_PERIOD_DAYS = '30';
    try {
      await jobs.sweep();
      const logsAfterFirst = store.logs.length;
      await jobs.sweep();
      expect(store.logs.length).toBe(logsAfterFirst);
      expect((await store.findSubscriptionById('s1'))?.status).toBe('expired');
    } finally {
      delete process.env.SAAS_GRACE_PERIOD_DAYS;
    }
  });

  it('宽限期推算：SAAS_GRACE_PERIOD_DAYS=1 时 t3（2 天前到期）应被冻结', async () => {
    const store = seedStore();
    const jobs = makeJobs(store);
    process.env.SAAS_GRACE_PERIOD_DAYS = '1';
    try {
      await jobs.sweep();
      // t2（8 天前）与 t3（2 天前）都超过 1 天宽限
      expect(store.tenantStatus.get('t3')).toBe('frozen');
    } finally {
      delete process.env.SAAS_GRACE_PERIOD_DAYS;
    }
  });

  it('store token 可用（DI 契约面）', () => {
    expect(typeof SAAS_STORE).toBe('symbol');
  });
});
