/*
 * @file 生命周期状态机与服务测试
 * @description ADR-0031 验收：合法迁移逐条对表、非法迁移 4030、条件更新幂等（alreadyApplied 不重复记日志）、
 *   冻结拦截 4031。store 为内存 Fake（正确性语义与 ADR-0031 §2.3 对齐）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { describe, expect, it } from 'vitest';
import { LifecycleTransitionInvalidError, TenantSuspendedError } from '../errors.js';
import { listTransitions, resolveTransition } from '../lifecycle.machine.js';
import { TenantLifecycleService } from '../lifecycle.service.js';
import { FakeSaasStore } from '../fake-store.js';

describe('生命周期状态机（ADR-0031 §2.2 迁移表）', () => {
  it('合法迁移逐条可解析', () => {
    const table = listTransitions();
    expect(table).toHaveLength(10);
    for (const t of table) {
      expect(resolveTransition(t.from, t.action)).toBe(t.to);
    }
  });

  it('非法迁移返回 null（覆盖每态至少一条非法路径）', () => {
    expect(resolveTransition('pending', 'freeze')).toBeNull();
    expect(resolveTransition('active', 'activate')).toBeNull();
    expect(resolveTransition('grace', 'activate')).toBeNull();
    expect(resolveTransition('frozen', 'expire')).toBeNull();
    expect(resolveTransition('terminated', 'resume')).toBeNull();
    expect(resolveTransition('terminated', 'freeze')).toBeNull();
  });
});

describe('TenantLifecycleService.transition', () => {
  it('合法迁移：状态更新 + 日志落盘', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    store.tenantStatus.set('t1', 'pending');
    const r = await svc.transition('t1', 'activate', { actorType: 'user', actorId: 'op-1', reason: '开通' });
    expect(r).toEqual({ from: 'pending', to: 'active', alreadyApplied: false });
    expect(store.logs).toHaveLength(1);
    expect(store.logs[0]).toMatchObject({ tenantId: 't1', fromStatus: 'pending', toStatus: 'active', action: 'activate', actorId: 'op-1' });
  });

  it('非法迁移抛 4030（details 含 from/action）', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    store.tenantStatus.set('t1', 'pending');
    await expect(svc.transition('t1', 'freeze')).rejects.toMatchObject({
      name: 'LifecycleTransitionInvalidError',
      code: 4030,
      http: 409,
      details: [{ field: 'from', message: 'pending' }, { field: 'action', message: 'freeze' }],
    });
  });

  it('重复执行幂等：alreadyApplied=true 且不重复记日志', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    store.tenantStatus.set('t1', 'active');
    await svc.transition('t1', 'freeze', { actorType: 'system' });
    const r = await svc.transition('t1', 'freeze', { actorType: 'system' });
    expect(r.alreadyApplied).toBe(true);
    expect(store.logs.filter((l) => l.action === 'freeze')).toHaveLength(1);
  });

  it('条件更新失败且非目标态：4030（竞态被拒）', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    store.tenantStatus.set('t1', 'active');
    // 模拟并发迁移者先行改变状态：conditionalUpdateStatus 以 from='active' 判定，此处先改掉
    store.tenantStatus.set('t1', 'terminated');
    await expect(svc.transition('t1', 'freeze')).rejects.toBeInstanceOf(LifecycleTransitionInvalidError);
  });

  it('租户不存在 → 1002', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    await expect(svc.transition('nope', 'activate')).rejects.toMatchObject({ code: 1002 });
  });

  it('assertNotSuspended：frozen/terminated 抛 4031，active 放行', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    store.tenantStatus.set('t1', 'frozen');
    store.tenantStatus.set('t2', 'terminated');
    store.tenantStatus.set('t3', 'active');
    await expect(svc.assertNotSuspended('t1')).rejects.toBeInstanceOf(TenantSuspendedError);
    await expect(svc.assertNotSuspended('t1')).rejects.toMatchObject({ code: 4031, http: 403 });
    await expect(svc.assertNotSuspended('t2')).rejects.toMatchObject({ code: 4031 });
    await expect(svc.assertNotSuspended('t3')).resolves.toBe('active');
  });

  it('全链：pending → active → grace → frozen → resume → terminate（日志逐条累积）', async () => {
    const store = new FakeSaasStore();
    const svc = new TenantLifecycleService(store);
    store.tenantStatus.set('t1', 'pending');
    await svc.transition('t1', 'activate', { actorType: 'user' });
    await svc.transition('t1', 'expire', { actorType: 'system' });
    await svc.transition('t1', 'freeze', { actorType: 'system' });
    await svc.transition('t1', 'resume', { actorType: 'user', reason: '续订' });
    await svc.transition('t1', 'terminate', { actorType: 'user', reason: '注销' });
    expect(store.tenantStatus.get('t1')).toBe('terminated');
    expect(store.logs.map((l) => l.action)).toEqual(['activate', 'expire', 'freeze', 'resume', 'terminate']);
    await expect(svc.transition('t1', 'resume')).rejects.toMatchObject({ code: 4030 });
    // 运营面查询：只返回本租户日志
    const logs = await svc.listLogs('t1');
    expect(logs).toHaveLength(5);
    expect(await svc.listLogs('t-other')).toHaveLength(0);
  });
});
