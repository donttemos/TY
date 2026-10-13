/*
 * @file 请求层单元测试（TC-WEB-003 无感刷新）
 * @description 覆盖统一请求层的响应拦截行为：信封解包（code=0 取 data / 非信封原样返回）、
 *   3001/3003 触发无感刷新并重放原请求、刷新失败跳登录、并发 401 共用同一刷新 Promise（防轮换互相踩）。
 *   axios 与 DOM location 以 mock 注入；每例 resetModules 后动态加载 request 与 token 模块，
 *   保证用例拿到的是同一批模块实例（refreshing 模块级状态不跨用例污染）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/utils
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BIZ_CODE } from '../biz-error';

const mocks = vi.hoisted(() => {
  const instance = {
    interceptors: {
      request: { use: vi.fn() },
      response: { use: vi.fn() },
    },
    request: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
    put: vi.fn(),
    delete: vi.fn(),
  };
  return { instance, axiosPost: vi.fn() };
});

vi.mock('axios', () => ({
  default: {
    create: () => mocks.instance,
    post: mocks.axiosPost,
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.instance.interceptors.request.use.mockClear();
  mocks.instance.interceptors.response.use.mockClear();
  mocks.instance.request.mockClear();
  mocks.axiosPost.mockClear();
  localStorage.clear();
  sessionStorage.clear();
});

/** 动态加载同一批模块实例：request（含 ensureFreshToken）与 token 存储 */
async function loadModules(): Promise<{
  tokenStore: typeof import('../token').tokenStore;
  ensureFreshToken: typeof import('../request').ensureFreshToken;
  onFulfilled: (r: unknown) => unknown;
  onRejected: (e: unknown) => Promise<unknown>;
}> {
  const requestModule = await import('../request');
  const tokenModule = await import('../token');
  const [onFulfilled, onRejected] = mocks.instance.interceptors.response.use.mock.calls[0] as [
    (r: unknown) => unknown,
    (e: unknown) => Promise<unknown>,
  ];
  return { tokenStore: tokenModule.tokenStore, ensureFreshToken: requestModule.ensureFreshToken, onFulfilled, onRejected };
}

describe('响应拦截器：信封解包', () => {
  it('code=0 返回解包后的 data', async () => {
    const { onFulfilled } = await loadModules();
    const result = onFulfilled({ data: { code: 0, message: 'ok', data: { id: 'u-1' } } });
    expect(result).toEqual({ id: 'u-1' });
  });

  it('非信封响应（无 code 字段）原样返回', async () => {
    const { onFulfilled } = await loadModules();
    const result = onFulfilled({ data: { hello: 'world' } });
    expect(result).toEqual({ hello: 'world' });
  });

  it('code≠0 拒绝为 BizError（带 traceId）', async () => {
    const { onFulfilled } = await loadModules();
    await expect(
      (async () =>
        onFulfilled({ data: { code: 1001, message: '参数错误', traceId: 't-1', data: { details: [{ field: 'username', message: '必填' }] } } }))(),
    ).rejects.toMatchObject({ name: 'BizError', code: 1001, traceId: 't-1' });
  });
});

describe('响应拦截器：无感刷新与重放', () => {
  it('3001 触发刷新并重放原请求，新令牌写入内存', async () => {
    const { tokenStore, onRejected } = await loadModules();
    tokenStore.setRefresh('old-refresh', true);
    mocks.axiosPost.mockResolvedValue({ data: { code: 0, data: { accessToken: 'new-access', refreshToken: 'new-refresh' } } });
    mocks.instance.request.mockResolvedValue({ id: 'replayed' });

    const result = await onRejected({
      response: { data: { code: BIZ_CODE.UNAUTHORIZED, message: '登录状态已失效' }, headers: {} },
      config: { url: '/users' },
      message: 'Request failed with status code 401',
    });

    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.instance.request).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ id: 'replayed' });
    expect(tokenStore.getAccess()).toBe('new-access');
    expect(tokenStore.getRefresh()).toBe('new-refresh');
  });

  it('3003 token 过期同样触发刷新重放', async () => {
    const { tokenStore, onRejected } = await loadModules();
    tokenStore.setRefresh('old-refresh', true);
    mocks.axiosPost.mockResolvedValue({ data: { code: 0, data: { accessToken: 'a2', refreshToken: 'r2' } } });
    mocks.instance.request.mockResolvedValue('ok');

    const result = await onRejected({
      response: { data: { code: BIZ_CODE.TOKEN_EXPIRED }, headers: {} },
      config: { url: '/auth/me' },
      message: 'expired',
    });
    expect(result).toBe('ok');
  });

  it('3002 越权不触发刷新，直接拒绝', async () => {
    const { onRejected } = await loadModules();
    await expect(
      onRejected({
        response: { data: { code: BIZ_CODE.FORBIDDEN, message: '无操作权限' }, headers: {} },
        config: { url: '/users' },
        message: 'forbidden',
      }),
    ).rejects.toMatchObject({ code: BIZ_CODE.FORBIDDEN });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
    expect(mocks.instance.request).not.toHaveBeenCalled();
  });

  it('刷新失败：拒绝为未登录并跳登录页（带 redirect）', async () => {
    const locationStub = { assign: vi.fn(), pathname: '/system/users', search: '?a=1' };
    Object.defineProperty(window, 'location', { value: locationStub, writable: true, configurable: true });
    const { tokenStore, onRejected } = await loadModules();
    tokenStore.setRefresh('old-refresh', true);
    mocks.axiosPost.mockResolvedValue({ data: { code: BIZ_CODE.UNAUTHORIZED, message: '刷新失败' } });

    await expect(
      onRejected({
        response: { data: { code: BIZ_CODE.TOKEN_EXPIRED }, headers: {} },
        config: { url: '/auth/me' },
        message: 'expired',
      }),
    ).rejects.toMatchObject({ code: BIZ_CODE.UNAUTHORIZED });

    expect(locationStub.assign).toHaveBeenCalledWith('/login?redirect=%2Fsystem%2Fusers%3Fa%3D1');
    expect(tokenStore.getRefresh()).toBeNull();
  });

  it('刷新请求自身的 401 不递归刷新', async () => {
    const { onRejected } = await loadModules();
    await expect(
      onRejected({
        response: { data: { code: BIZ_CODE.UNAUTHORIZED, message: '刷新令牌无效' }, headers: {} },
        config: { url: '/auth/refresh' },
        message: 'invalid',
      }),
    ).rejects.toMatchObject({ code: BIZ_CODE.UNAUTHORIZED });
    expect(mocks.axiosPost).not.toHaveBeenCalled();
  });

  it('并发 401 共用同一刷新 Promise（防轮换互相踩）', async () => {
    const { tokenStore, ensureFreshToken, onRejected } = await loadModules();
    tokenStore.setRefresh('old-refresh', true);
    let resolveRefresh: (value: unknown) => void = () => {};
    mocks.axiosPost.mockReturnValue(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      }),
    );
    mocks.instance.request.mockResolvedValue('ok');

    const first = onRejected({
      response: { data: { code: BIZ_CODE.TOKEN_EXPIRED }, headers: {} },
      config: { url: '/users' },
      message: 'expired',
    });
    const second = onRejected({
      response: { data: { code: BIZ_CODE.TOKEN_EXPIRED }, headers: {} },
      config: { url: '/roles' },
      message: 'expired',
    });
    const third = ensureFreshToken();

    // 刷新未完成前只发起一次刷新请求
    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);

    resolveRefresh({ data: { code: 0, data: { accessToken: 'a3', refreshToken: 'r3' } } });
    await Promise.all([first, second, third]);

    expect(mocks.axiosPost).toHaveBeenCalledTimes(1);
    expect(mocks.instance.request).toHaveBeenCalledTimes(2);
    expect(tokenStore.getAccess()).toBe('a3');
  });
});
