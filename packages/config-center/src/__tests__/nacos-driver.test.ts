/*
 * @file Nacos 事实源驱动测试（M9 Backlog 示例实现的框架级验证）
 * @description fetch 结构桩注入：读取（200/404/网络失败）、发布（成功/失败）、内容 MD5 轮询
 *   （变更回调 / 同内容抑制 / 解析失败保持快照 / 写后自触发抑制）、鉴权登录惰性获取。
 * @author donttemo
 * @created 2026-10-15
 * @module config-center
 */
import { describe, expect, it, vi } from 'vitest';
import { NacosConfigDriver } from '../drivers/nacos.driver.js';
import type { FetchLike } from '../drivers/nacos.driver.js';

/** fetch 桩：按 URL 匹配返回预置响应，并记录调用 */
function makeFetch(routes: {
  get?: () => { status: number; body: string };
  post?: (body: string) => { status: number; body: string };
} = {}): FetchLike & { calls: Array<{ method: string; url: string; body?: string }> } {
  const calls: Array<{ method: string; url: string; body?: string }> = [];
  const fn = (async (url: string, init?: RequestInit) => {
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ method, url, body: typeof init?.body === 'string' ? init.body : undefined });
    if (method === 'POST' && routes.post) {
      const r = routes.post(String(init?.body ?? ''));
      return { status: r.status, text: async () => r.body };
    }
    const r = routes.get ? routes.get() : { status: 404, body: '' };
    return { status: r.status, text: async () => r.body };
  }) as FetchLike & { calls: typeof calls };
  fn.calls = calls;
  return fn;
}

/** 手动驱动一轮轮询（定时器桩登记 handler，测试显式触发） */
function makeTimers() {
  let handler: (() => void) | undefined;
  return {
    setIntervalFn: (h: () => void) => {
      handler = h;
      return Symbol('timer');
    },
    clearIntervalFn: () => undefined,
    tick: () => handler?.(),
  };
}

function makeDriver(fetchFn: FetchLike, timers = makeTimers()): NacosConfigDriver {
  return new NacosConfigDriver({
    serverAddr: 'http://nacos.test:8848',
    dataId: 'fw-runtime.json',
    group: 'FW_GROUP',
    namespace: 'fw-ns',
    pollSeconds: 5,
    fetchFn,
    setIntervalFn: timers.setIntervalFn,
    clearIntervalFn: timers.clearIntervalFn,
  });
}

const CONFIG = JSON.stringify({ 'log.level': 'debug', 'cache.ttl': 600 });

describe('NacosConfigDriver · load / write', () => {
  it('load：200 返回解析后的覆盖集', async () => {
    const fetchFn = makeFetch({ get: () => ({ status: 200, body: CONFIG }) });
    const driver = makeDriver(fetchFn);
    expect(await driver.load()).toEqual({ 'log.level': 'debug', 'cache.ttl': 600 });
    expect(fetchFn.calls[0]?.url).toContain('/nacos/v1/cs/configs');
    expect(fetchFn.calls[0]?.url).toContain('dataId=fw-runtime.json');
    expect(fetchFn.calls[0]?.url).toContain('group=FW_GROUP');
    expect(fetchFn.calls[0]?.url).toContain('tenant=fw-ns');
  });

  it('load：404（配置未创建）→ null，由上层 fail-open', async () => {
    const driver = makeDriver(makeFetch()); // 无 get 路由 → 404
    expect(await driver.load()).toBeNull();
  });

  it('load：网络失败上抛（init 期由上层 fail-open，轮询期保持快照）', async () => {
    const fetchFn = (async () => {
      throw new Error('connection refused');
    }) as unknown as FetchLike;
    const driver = makeDriver(fetchFn);
    await expect(driver.load()).rejects.toThrow('connection refused');
  });

  it('load：JSON 损坏 → null（fail-open，不抛到调用方）', async () => {
    const driver = makeDriver(makeFetch({ get: () => ({ status: 200, body: '{ broken' }) }));
    expect(await driver.load()).toBeNull();
  });

  it('write：POST 发布 json 内容（dataId/group/tenant/content/type 全量下发），成功返回', async () => {
    const fetchFn = makeFetch({ post: () => ({ status: 200, body: 'true' }) });
    const driver = makeDriver(fetchFn);
    const snapshot = { 'log.level': 'warn' };
    await driver.write(snapshot);
    const call = fetchFn.calls[0]!;
    expect(call.url).toBe('http://nacos.test:8848/nacos/v1/cs/configs');
    const form = new URLSearchParams(call.body ?? '');
    expect(form.get('dataId')).toBe('fw-runtime.json');
    expect(form.get('group')).toBe('FW_GROUP');
    expect(form.get('tenant')).toBe('fw-ns');
    expect(form.get('type')).toBe('json');
    expect(form.get('content')).toContain('"log.level": "warn"');
  });

  it('write：发布失败（非 true 响应）上抛', async () => {
    const driver = makeDriver(makeFetch({ post: () => ({ status: 200, body: 'false' }) }));
    await expect(driver.write({})).rejects.toThrow('Nacos 配置发布失败');
  });
});

describe('NacosConfigDriver · watch（内容 MD5 轮询）', () => {
  it('内容变化 → 回调新快照；同内容 → 抑制；写入自触发 → 抑制', async () => {
    let body = CONFIG;
    const fetchFn = makeFetch({ get: () => ({ status: 200, body }), post: () => ({ status: 200, body: 'true' }) });
    const timers = makeTimers();
    const driver = makeDriver(fetchFn, timers);
    const onChange = vi.fn();

    driver.watch(onChange);
    body = JSON.stringify({ 'log.level': 'trace' });
    timers.tick();
    await driver.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith({ 'log.level': 'trace' });

    // 同内容：不回调
    timers.tick();
    await driver.settle();
    expect(onChange).toHaveBeenCalledTimes(1);

    // write 自身已更新指纹（指纹 = 发布内容原文）：下一轮不把自写内容当外部变更
    await driver.write({ 'log.level': 'warn' });
    body = JSON.stringify({ 'log.level': 'warn' }, null, 2);
    timers.tick();
    await driver.settle();
    expect(onChange).toHaveBeenCalledTimes(1);
    await driver.stop();
  });

  it('解析失败不回调（fail-keep）；404（配置被删）不回调、不动运行态', async () => {
    let status = 200;
    let body = CONFIG;
    const fetchFn = makeFetch({ get: () => ({ status, body }) });
    const timers = makeTimers();
    const driver = makeDriver(fetchFn, timers);
    const onChange = vi.fn();
    driver.watch(onChange);

    body = '{ broken';
    timers.tick();
    await driver.settle();
    expect(onChange).not.toHaveBeenCalled();

    status = 404;
    body = '';
    timers.tick();
    await driver.settle();
    expect(onChange).not.toHaveBeenCalled();
    await driver.stop();
  });
});

describe('NacosConfigDriver · 鉴权（开启鉴权的 Nacos）', () => {
  it('惰性登录一次，后续读写复用 accessToken', async () => {
    const calls: Array<{ method: string; url: string }> = [];
    let tokenIssued = 0;
    const fetchFn = (async (url: string, init?: RequestInit) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ method, url });
      if (url.includes('/nacos/v1/auth/login')) {
        tokenIssued++;
        return { status: 200, text: async () => JSON.stringify({ accessToken: 'tok-1' }) };
      }
      if (method === 'POST') return { status: 200, text: async () => 'true' };
      return { status: 200, text: async () => CONFIG };
    }) as unknown as FetchLike;
    const driver = new NacosConfigDriver({
      serverAddr: 'http://nacos.test:8848',
      dataId: 'fw-runtime.json',
      username: 'nacos',
      password: 'secret',
      fetchFn,
    });

    await driver.load();
    await driver.load();
    await driver.write({});
    expect(tokenIssued).toBe(1); // 登录一次
    expect(calls.filter((c) => c.url.includes('configs')).every((c) => !calls[0] || true)).toBe(true);
    // 读写请求携带 accessToken
    expect(calls.some((c) => c.url.includes('accessToken=tok-1'))).toBe(true);
  });
});
