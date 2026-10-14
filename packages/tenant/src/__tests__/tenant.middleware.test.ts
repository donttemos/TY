/*
 * @file 租户解析中间件（express 级）单元测试
 * @description 覆盖 T-M8-01 中间件层行为：运维路径豁免、多租户关闭时零开销放行、
 *   解析成功写入 req.tenant 与请求上下文（含 dedicated 独立库连接串分支）、
 *   JWT claim 来源回退、fail-closed 异常经 next(error) 传递。补齐 v0.2.0 发布前
 *   覆盖率门禁（middleware.ts 原先仅由端到端冒烟覆盖）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/tenant
 */
import 'reflect-metadata';
import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it } from 'vitest';
import { BizError } from '@fw/core';
import { createTenantExpressMiddleware, type TenantRequest } from '../tenant.middleware.js';
import { TenantService, type TenantServiceOptions } from '../tenant.service.js';
import { DEFAULT_TENANT_ORDER, type TenantInfo, type TenantStorePort, type TenantResolutionOptions } from '../types.js';

/** 中间件测试用解析配置（子域名 → 请求头 → JWT） */
const RESOLUTION: TenantResolutionOptions = {
  order: [...DEFAULT_TENANT_ORDER],
  headerName: 'x-tenant-id',
  baseDomain: 'example.com',
  jwtClaim: 'tenantId',
};

/** 构造 TenantService（store 由用例注入的租户表或抛错行为决定） */
function makeService(opts: { enabled?: boolean; tenants?: TenantInfo[]; storeThrows?: Error } = {}): TenantService {
  const tenants = opts.tenants ?? [];
  const store: TenantStorePort = {
    async findTenantByCode(code: string): Promise<TenantInfo | null> {
      if (opts.storeThrows) throw opts.storeThrows;
      return tenants.find((t) => t.code === code) ?? null;
    },
  };
  const options: TenantServiceOptions = {
    resolution: RESOLUTION,
    enabled: opts.enabled ?? true,
    cacheTtlMs: 60_000,
  };
  return new TenantService(store, options);
}

/** 共享库租户 */
const ACME_SHARED: TenantInfo = {
  id: '1',
  code: 'acme',
  name: 'Acme',
  isolation: 'shared',
  dbUrl: null,
  status: 1,
  expireAt: null,
};

/** 独立库租户（带连接串，触发上下文透传的 dbUrl 分支） */
const ACME_DEDICATED: TenantInfo = { ...ACME_SHARED, isolation: 'dedicated', dbUrl: 'postgresql://u:p@127.0.0.1:5432/acme' };

/** 构造 express 请求三元组并记录 next 调用 */
function harness(over: { url?: string; host?: string; headers?: Record<string, unknown>; tenantClaim?: string } = {}) {
  const req = {
    url: over.url ?? '/api/v1/demo/items',
    headers: { host: over.host ?? 'acme.example.com', ...(over.headers ?? {}) },
    ...(over.tenantClaim ? { tenantClaim: over.tenantClaim } : {}),
  } as unknown as TenantRequest;
  const res = {} as Response;
  const state: { called: boolean; error?: unknown } = { called: false };
  const next: NextFunction = ((error?: unknown) => {
    state.called = true;
    state.error = error;
  }) as NextFunction;
  return { req, res, next, state };
}

/** 等待中间件内部 promise 链完成（resolve(...).then/.catch 至少一个宏任务轮次） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe('createTenantExpressMiddleware', () => {
  it('运维路径豁免：/health /ready /metrics 及其子路径直接放行且不解析', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_SHARED] }));
    for (const url of ['/health', '/ready', '/metrics', '/ready/db?probe=1']) {
      const h = harness({ url, host: 'acme.example.com' });
      middleware(h.req, h.res, h.next);
      expect(h.state.called).toBe(true);
      expect(h.state.error).toBeUndefined();
      expect(h.req.tenant).toBeUndefined();
    }
    await flush();
  });

  it('多租户关闭：resolve 短路为 null，放行且不写租户', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ enabled: false }));
    const h = harness();
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.state.called).toBe(true);
    expect(h.state.error).toBeUndefined();
    expect(h.req.tenant).toBeUndefined();
  });

  it('解析成功（共享库）：写入 req.tenant 并放行', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_SHARED] }));
    const h = harness();
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.state.error).toBeUndefined();
    expect(h.req.tenant?.code).toBe('acme');
    expect(h.req.tenant?.isolation).toBe('shared');
  });

  it('解析成功（独立库）：上下文透传 dbUrl 分支被覆盖', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_DEDICATED] }));
    const h = harness();
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.req.tenant?.isolation).toBe('dedicated');
    expect(h.req.tenant?.dbUrl).toBe('postgresql://u:p@127.0.0.1:5432/acme');
  });

  it('请求头来源：小写归一后命中（Host 无子域名）', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_SHARED] }));
    const h = harness({ host: 'example.com', headers: { 'X-Tenant-Id': 'acme' } });
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.req.tenant?.code).toBe('acme');
  });

  it('JWT 来源：无子域名与请求头时取 tenantClaim', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_SHARED] }));
    const h = harness({ host: 'example.com', tenantClaim: 'acme' });
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.req.tenant?.code).toBe('acme');
  });

  it('fail-closed：未知租户标识 → next(BizError 4001)，不写租户', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_SHARED] }));
    const h = harness({ host: 'ghost.example.com' });
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.state.called).toBe(true);
    expect(h.state.error).toBeInstanceOf(BizError);
    expect(h.req.tenant).toBeUndefined();
  });

  it('缺租户标识 → next(BizError)，请求未进入业务处理', async () => {
    const middleware = createTenantExpressMiddleware(makeService({ tenants: [ACME_SHARED] }));
    const h = harness({ host: 'example.com' });
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.state.error).toBeInstanceOf(BizError);
    expect(h.req.tenant).toBeUndefined();
  });

  it('存储实现异常 → next(error) 透传（不吞错）', async () => {
    const boom = new Error('store unavailable');
    const middleware = createTenantExpressMiddleware(makeService({ storeThrows: boom }));
    const h = harness();
    middleware(h.req, h.res, h.next);
    await flush();
    expect(h.state.error).toBe(boom);
  });
});
