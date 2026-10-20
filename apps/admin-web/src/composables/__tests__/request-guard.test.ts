/*
 * @file 请求竞态守卫单测（M14/PRD-014 AC-14-04 乱序安全的最小证明）
 * @description 钉住 createRequestGuard 的三个契约：① 只有最新票据能提交（后发先至时旧响应被丢弃）；
 *   ② invalidate() 立即作废在途票据（切租户复位的同步语义）；③ 作用域快照变化时票据失效
 *   （同序号也可能因租户/指标变化而不得写入）。三页页面级乱序用例见各页 __tests__。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/composables
 */

import { describe, expect, it } from 'vitest';
import { createRequestGuard } from '@/composables/useRequestGuard';

/** 可控 promise：手动决定何时返回，用于构造「后发先至」 */
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('createRequestGuard（异步竞态守卫）', () => {
  it('单次请求：票据有效，apply 执行并返回 true', () => {
    const guard = createRequestGuard();
    const ticket = guard.begin();
    let value = '';

    expect(ticket.isFresh()).toBe(true);
    expect(ticket.apply(() => { value = 'A'; })).toBe(true);
    expect(value).toBe('A');
  });

  it('后发先至：B 先返回后 A 才返回，A 的结果被丢弃（页面只留 B）', async () => {
    const guard = createRequestGuard();
    const state = { data: '' };

    const reqA = deferred<string>();
    const ticketA = guard.begin();
    const pA = reqA.promise.then((d) => ticketA.apply(() => { state.data = d; }));

    const reqB = deferred<string>();
    const ticketB = guard.begin();
    const pB = reqB.promise.then((d) => ticketB.apply(() => { state.data = d; }));

    reqB.resolve('B-data');
    await pB;
    expect(state.data).toBe('B-data');

    // A 晚到：序号已过期 → 不得覆盖 B
    reqA.resolve('A-data');
    await pA;
    expect(state.data).toBe('B-data');
    expect(ticketA.isFresh()).toBe(false);
    expect(ticketA.apply(() => { state.data = 'leak'; })).toBe(false);
    expect(state.data).toBe('B-data');
  });

  it('invalidate() 同步作废在途票据（切租户复位/清空选择）', async () => {
    const guard = createRequestGuard();
    const state = { data: '' };
    const req = deferred<string>();
    const ticket = guard.begin();
    const p = req.promise.then((d) => ticket.apply(() => { state.data = d; }));

    guard.invalidate();
    expect(ticket.isFresh()).toBe(false);

    req.resolve('late');
    await p;
    expect(state.data).toBe('');
  });

  it('作用域快照变化：序号未变也不得写入（租户/指标已切换）', () => {
    const guard = createRequestGuard();
    const ctx = { tenant: 't1', metric: 'api_calls' };
    const ticket = guard.begin(() => `${ctx.tenant}|${ctx.metric}`);
    let value = '';

    // 上下文切换到 t2 但本票据序号仍是最新 → 仅靠序号会漏，快照拦住
    ctx.tenant = 't2';
    expect(ticket.isFresh()).toBe(false);
    expect(ticket.apply(() => { value = 't1-usage'; })).toBe(false);
    expect(value).toBe('');
  });

  it('作用域快照一致：允许写入（正常同租户重查）', () => {
    const guard = createRequestGuard();
    const ctx = { tenant: 't1' };
    const ticket = guard.begin(() => ctx.tenant);
    let value = '';

    expect(ticket.apply(() => { value = 'ok'; })).toBe(true);
    expect(value).toBe('ok');
  });

  it('固定字符串作用域：永不过期，只有序号决定新旧', () => {
    const guard = createRequestGuard();
    const ticket = guard.begin('list');
    expect(ticket.isFresh()).toBe(true);
    guard.begin('list');
    expect(ticket.isFresh()).toBe(false);
  });

  it('独立守卫互不影响：一个实例的 begin 不会作废另一个实例的票据', () => {
    const quotaGuard = createRequestGuard();
    const metricGuard = createRequestGuard();
    const quotaTicket = quotaGuard.begin();
    metricGuard.begin();

    expect(quotaTicket.isFresh()).toBe(true);
  });
});
