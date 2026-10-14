/*
 * @file 租户模块装配单元测试
 * @description 覆盖 T-M8-01 TenantModule.forRoot 的装配语义：动态模块 global/exports、
 *   四个 provider 的工厂可执行（TENANT_STORE / TENANT_OPTIONS / TenantService / TENANT_MIDDLEWARE）
 *   与 inject 透传；以及 buildTenantRuntime 的 env 缺省回落、overrides 优先与非法顺序 fail-fast。
 *   补齐 v0.2.0 发布前覆盖率门禁（tenant.module.ts 原先仅部分由既有用例覆盖）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/tenant
 */
import 'reflect-metadata';
import type { Provider } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { buildTenantRuntime, TenantModule, type TenantEnvLike } from '../tenant.module.js';
import { TenantService } from '../tenant.service.js';
import {
  DEFAULT_TENANT_ORDER,
  TENANT_MIDDLEWARE,
  TENANT_OPTIONS,
  TENANT_STORE,
  type TenantInfo,
  type TenantStorePort,
} from '../types.js';

/** 测试用存储实现：仅 acme 存在 */
class FakeStore implements TenantStorePort {
  async findTenantByCode(code: string): Promise<TenantInfo | null> {
    if (code !== 'acme') return null;
    return { id: '1', code: 'acme', name: 'Acme', isolation: 'shared', dbUrl: null, status: 1, expireAt: null };
  }
}

/** 带构造依赖的存储实现（验证 inject 透传） */
class StoreWithDep implements TenantStorePort {
  constructor(readonly dep: unknown) {}

  async findTenantByCode(): Promise<TenantInfo | null> {
    return null;
  }
}

/** 按令牌取出 provider 定义（测试内省用） */
function providerOf(token: unknown, providers: readonly unknown[]): Record<string, never> | undefined {
  return providers.find((p) => (p as { provide?: unknown }).provide === token) as Record<string, never> | undefined;
}

describe('buildTenantRuntime', () => {
  it('env 缺省时回落内置默认值', () => {
    const runtime = buildTenantRuntime({});
    expect(runtime.resolution).toEqual({
      order: [...DEFAULT_TENANT_ORDER],
      headerName: 'x-tenant-id',
      baseDomain: undefined,
      jwtClaim: 'tenantId',
    });
    expect(runtime.serviceOptions.enabled).toBe(false);
    expect(runtime.serviceOptions.cacheTtlMs).toBe(60_000);
  });

  it('env 全部键生效、overrides 优先于 env', () => {
    const env: TenantEnvLike = {
      TENANT_ENABLED: true,
      TENANT_ORDER: 'header,jwt',
      TENANT_HEADER_NAME: 'x-tenant',
      TENANT_BASE_DOMAIN: 'corp.io',
      TENANT_JWT_CLAIM: 'tid',
      TENANT_CACHE_TTL: 5,
    };
    const runtime = buildTenantRuntime(env, {
      enabled: false,
      cacheTtlSeconds: 1,
      resolution: { headerName: 'x-override' },
    });
    expect(runtime.resolution.order).toEqual(['header', 'jwt']);
    expect(runtime.resolution.headerName).toBe('x-override');
    expect(runtime.resolution.baseDomain).toBe('corp.io');
    expect(runtime.resolution.jwtClaim).toBe('tid');
    expect(runtime.serviceOptions.enabled).toBe(false);
    expect(runtime.serviceOptions.cacheTtlMs).toBe(1_000);
  });

  it('TENANT_ORDER 非法时启动即失败（fail-fast）', () => {
    expect(() => buildTenantRuntime({ TENANT_ORDER: 'cookie' })).toThrow();
    expect(() => buildTenantRuntime({ TENANT_ORDER: '' })).toThrow();
  });
});

describe('TenantModule.forRoot', () => {
  it('装配为全局模块并导出服务/存储/中间件令牌，各工厂均可执行', async () => {
    const dynamic = TenantModule.forRoot({
      store: FakeStore,
      env: { TENANT_ENABLED: true, TENANT_BASE_DOMAIN: 'example.com' },
    });

    expect(dynamic.global).toBe(true);
    expect(dynamic.module).toBe(TenantModule);
    expect(dynamic.exports).toEqual(expect.arrayContaining([TenantService, TENANT_STORE, TENANT_MIDDLEWARE]));

    const providers = (dynamic.providers ?? []) as Provider[];

    const storeProvider = providerOf(TENANT_STORE, providers) as unknown as { useFactory: () => TenantStorePort };
    const store = storeProvider.useFactory();
    expect(store).toBeInstanceOf(FakeStore);

    const optionsProvider = providerOf(TENANT_OPTIONS, providers) as unknown as {
      useValue: { serviceOptions: { enabled: boolean } };
    };
    expect(optionsProvider.useValue.serviceOptions.enabled).toBe(true);

    const serviceProvider = providerOf(TenantService, providers) as unknown as {
      useFactory: (s: TenantStorePort, o: unknown) => TenantService;
    };
    const service = serviceProvider.useFactory(store, optionsProvider.useValue);
    expect(service).toBeInstanceOf(TenantService);
    const tenant = await service.resolve({ host: 'acme.example.com', headers: {} });
    expect(tenant?.code).toBe('acme');

    const middlewareProvider = providerOf(TENANT_MIDDLEWARE, providers) as unknown as {
      useFactory: (s: TenantService) => unknown;
    };
    expect(typeof middlewareProvider.useFactory(service)).toBe('function');
  });

  it('inject 依赖透传给存储工厂', () => {
    const dep = Symbol('fw.test.tenant.dep');
    const dynamic = TenantModule.forRoot({ store: StoreWithDep as never, inject: [dep], env: {} });
    const storeProvider = providerOf(TENANT_STORE, (dynamic.providers ?? []) as Provider[]) as unknown as {
      inject: unknown[];
      useFactory: (...args: unknown[]) => TenantStorePort;
    };
    expect(storeProvider.inject).toEqual([dep]);
    expect(storeProvider.useFactory('injected')).toBeInstanceOf(StoreWithDep);
  });
});
