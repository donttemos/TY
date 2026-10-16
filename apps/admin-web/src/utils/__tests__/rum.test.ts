/*
 * @file 前端错误监控 RUM 单元测试（M10/E-17）
 * @description 覆盖：归一化（message/stack/截断）、去重签名、采集器行为（批量满即发 /
 *   定时冲刷 / 同签名上限 / 会话上限 / stop 清空 / 采集与发送异常不得外溢）、发送通道
 *   （sendBeacon 优先 → 返回 false 或抛错时 fetch keepalive 兜底 → 全部失败静默）、
 *   installRum 三源监听（window error / 资源失败 / unhandledrejection / Vue errorHandler）
 *   与卸载（监听摘除 + 既有 errorHandler 保留）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIENT_ERROR_ENDPOINT,
  RUM_FLUSH_INTERVAL_MS,
  RUM_MAX_BATCH,
  RUM_MAX_PER_SIGNATURE,
  buildReport,
  createRumCollector,
  installRum,
  normalizeMessage,
  normalizeStack,
  sendBatch,
  signatureOf,
  truncate,
  type ClientErrorBatch,
} from '../rum';

/** 固定时钟（确定性 at 字段） */
const fixedNow = () => new Date('2026-10-15T12:00:00.000Z');

describe('RUM 归一化与签名', () => {
  it('truncate：超长截断并加省略号，未超长原样返回', () => {
    expect(truncate('abc', 5)).toBe('abc');
    expect(truncate('abcdefg', 5)).toBe('abcde…');
  });

  it('normalizeMessage：Error.message → event.message → String(reason) 优先级', () => {
    expect(normalizeMessage({ message: 'from event' })).toBe('from event');
    expect(normalizeMessage({ reason: new Error('from reason') })).toBe('from reason');
    expect(normalizeMessage({ reason: 'plain string' })).toBe('plain string');
    expect(normalizeMessage({ reason: { code: 1 } })).toBe('[object Object]');
    expect(normalizeMessage({})).toBe('unknown error');
  });

  it('normalizeStack：Error.stack → event.error.stack → 字符串 reason；都没有为 null', () => {
    const error = new Error('boom');
    expect(normalizeStack({ stack: 's1' })).toBe('s1');
    expect(normalizeStack({ error })).toBe(error.stack);
    expect(normalizeStack({ reason: 'stackish string' })).toBe('stackish string');
    expect(normalizeStack({ reason: 42 })).toBeNull();
    expect(normalizeStack({})).toBeNull();
  });

  it('signatureOf：同源同案同签名；不同 message/stack 首行不同签名', () => {
    const a = signatureOf({ source: 'error', message: 'boom', stack: 'Error: boom\n at x' });
    const b = signatureOf({ source: 'error', message: 'boom', stack: 'Error: boom\n at y' });
    const c = signatureOf({ source: 'error', message: 'other', stack: 'Error: boom\n at x' });
    expect(a).toBe(b); // 堆栈首行相同（同案）
    expect(a).not.toBe(c);
  });

  it('buildReport：带出页面 / URL / traceId / repeat / at', () => {
    const report = buildReport('error', { message: 'boom', stack: 'Error: boom' }, 'trace-1', 2, fixedNow);
    expect(report).toMatchObject({
      source: 'error',
      message: 'boom',
      stack: 'Error: boom',
      resource: null,
      traceId: 'trace-1',
      repeat: 2,
      at: '2026-10-15T12:00:00.000Z',
    });
    expect(report.page).toContain('/');
    expect(report.url).toContain('http');
  });
});

describe('RUM 采集器', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('累积到 RUM_MAX_BATCH 立即整批发送', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow });
    for (let i = 0; i < RUM_MAX_BATCH; i += 1) {
      collector.capture('error', { message: `boom-${i}`, stack: `Error: boom-${i}\n at x` });
    }
    expect(send).toHaveBeenCalledTimes(1);
    const batch = send.mock.calls[0]?.[0] as ClientErrorBatch;
    expect(batch.app).toBe('admin-web');
    expect(batch.reports).toHaveLength(RUM_MAX_BATCH);
    collector.stop();
  });

  it('未满批时按窗口定时冲刷', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow });
    collector.capture('error', { message: 'boom', stack: 'Error: boom' });
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(RUM_FLUSH_INTERVAL_MS);
    expect(send).toHaveBeenCalledTimes(1);
    collector.stop();
  });

  it('flush() 手动冲刷：发完即清空，无待发时不再发送', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow });
    collector.capture('error', { message: 'boom', stack: 'Error: boom' });
    collector.flush();
    collector.flush();
    expect(send).toHaveBeenCalledTimes(1);
    collector.stop();
  });

  it('同签名去重：第 RUM_MAX_PER_SIGNATURE+1 条起丢弃，repeat 递增', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow });
    for (let i = 0; i < RUM_MAX_PER_SIGNATURE + 3; i += 1) {
      collector.capture('error', { message: 'same', stack: 'Error: same\n at x' });
      collector.flush();
    }
    const sent = send.mock.calls.map((call) => (call[0] as ClientErrorBatch).reports[0]?.repeat);
    expect(sent).toEqual([1, 2, 3, 4, 5]);
  });

  it('会话总量上限：超出 RUM_MAX_SESSION 后静默丢弃', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow });
    for (let i = 0; i < 100 + 5; i += 1) {
      collector.capture('error', { message: `boom-${i}`, stack: `Error: boom-${i}\n at x` });
    }
    collector.flush();
    // 满 RUM_MAX_BATCH 即自动整批发：累计口径 = 100（上限），超额 5 条被丢弃
    const total = send.mock.calls.reduce(
      (sum, call) => sum + (call[0] as ClientErrorBatch).reports.length,
      0,
    );
    expect(total).toBe(100);
    collector.stop();
  });

  it('stop()：计时器摘除 + 待发清空 + 停止后再 capture 不入队', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow });
    collector.capture('error', { message: 'boom', stack: 'Error: boom' });
    collector.stop();
    collector.capture('error', { message: 'boom2', stack: 'Error: boom2' });
    vi.advanceTimersByTime(RUM_FLUSH_INTERVAL_MS * 3);
    expect(send).not.toHaveBeenCalled();
  });

  it('发送抛错不得影响采集（fire-and-forget）', () => {
    const send = vi.fn(() => {
      throw new Error('beacon down');
    });
    const collector = createRumCollector({ send, now: fixedNow });
    expect(() => collector.capture('error', { message: 'boom', stack: 'Error: boom' })).not.toThrow();
    expect(() => collector.flush()).not.toThrow();
  });

  it('traceId 来源可注入（与后端日志关联）', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, traceId: () => 'trace-injected', now: fixedNow });
    collector.capture('error', { message: 'boom', stack: 'Error: boom' });
    collector.flush();
    const batch = send.mock.calls[0]?.[0] as ClientErrorBatch;
    expect(batch.reports[0]?.traceId).toBe('trace-injected');
    collector.stop();
  });
});

describe('RUM 发送通道', () => {
  const originalSendBeacon = Object.getOwnPropertyDescriptor(navigator, 'sendBeacon');
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    if (originalSendBeacon) Object.defineProperty(navigator, 'sendBeacon', originalSendBeacon);
    else delete (navigator as { sendBeacon?: unknown }).sendBeacon;
    globalThis.fetch = originalFetch;
  });

  function stubSendBeacon(impl: (url: string, data: Blob) => boolean): void {
    Object.defineProperty(navigator, 'sendBeacon', { value: impl, configurable: true, writable: true });
  }

  it('sendBeacon 可用且返回 true：优先走 beacon（不发 fetch）', () => {
    const beacon = vi.fn((_url: string, _data: Blob) => true);
    const fetchMock = vi.fn();
    stubSendBeacon(beacon);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    sendBatch({ app: 'admin-web', reports: [] });

    expect(beacon).toHaveBeenCalledTimes(1);
    expect(beacon.mock.calls[0]?.[0]).toBe(CLIENT_ERROR_ENDPOINT);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sendBeacon 返回 false：回退 fetch keepalive', () => {
    const fetchMock = vi.fn((..._args: unknown[]) => Promise.resolve(new Response('{}')));
    stubSendBeacon(() => false);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    sendBatch({ app: 'admin-web', reports: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.method).toBe('POST');
    expect(init.keepalive).toBe(true);
  });

  it('sendBeacon 抛错：同样回退 fetch（不向上抛）', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    stubSendBeacon(() => {
      throw new Error('beacon blocked');
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    expect(() => sendBatch({ app: 'admin-web', reports: [] })).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('sendBeacon 不存在（老浏览器）：直接用 fetch', () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response('{}')));
    // happy-dom 的 sendBeacon 在原型上：delete 实例属性无效，需显式遮蔽为 undefined
    Object.defineProperty(navigator, 'sendBeacon', { value: undefined, configurable: true, writable: true });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    sendBatch({ app: 'admin-web', reports: [] });

    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('installRum 三源监听与卸载', () => {
  it('window error / 资源失败 / unhandledrejection / Vue errorHandler 全部采集', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow, flushIntervalMs: 60_000 });
    const app = { config: {} as { errorHandler?: (err: unknown, instance: unknown, info: string) => void } };
    const uninstall = installRum(app, collector);

    // 1) window error（普通异常）
    window.dispatchEvent(new ErrorEvent('error', { message: 'boom', error: new Error('boom') }));
    // 2) 资源加载失败：真实浏览器中在元素上派发（捕获阶段到 window）；happy-dom 不做
    //    元素→window 的捕获传播，故在此以 window 派发 + target 指向元素等价模拟
    const img = document.createElement('img');
    img.src = '/broken.png';
    const resourceEvent = new ErrorEvent('error', { message: '' });
    Object.defineProperty(resourceEvent, 'target', { value: img, configurable: true });
    window.dispatchEvent(resourceEvent);
    // 3) 未处理 Promise 拒绝
    const rejection = new Event('unhandledrejection');
    Object.defineProperty(rejection, 'reason', { value: new Error('rejected') });
    window.dispatchEvent(rejection);
    // 4) Vue errorHandler
    app.config.errorHandler?.(new Error('vue boom'), null, 'render');

    collector.flush();
    const sources = (send.mock.calls[0]?.[0] as ClientErrorBatch).reports.map((r) => r.source);
    expect(sources).toEqual(['error', 'resource', 'rejection', 'vue']);

    uninstall();
  });

  it('卸载后事件不再采集；既有 errorHandler 被保留且恢复', () => {
    const send = vi.fn();
    const collector = createRumCollector({ send, now: fixedNow, flushIntervalMs: 60_000 });
    const previous = vi.fn();
    const app = { config: { errorHandler: previous } };
    const uninstall = installRum(app, collector);

    app.config.errorHandler?.(new Error('kept'), null, 'mounted');
    expect(previous).toHaveBeenCalledTimes(1);

    uninstall();
    window.dispatchEvent(new ErrorEvent('error', { message: 'after', error: new Error('after') }));
    app.config.errorHandler?.(new Error('after-vue'), null, 'mounted');
    expect(previous).toHaveBeenCalledTimes(2); // 仍是原 handler（已恢复）
    expect(send).not.toHaveBeenCalled();
  });
});
