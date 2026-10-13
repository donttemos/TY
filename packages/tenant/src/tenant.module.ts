/*
 * @file 租户模块
 * @description PRD-008 FR-01：TenantModule.forRoot({ store }) 注册 TenantService 与 express 级
 *   中间件工厂（TENANT_MIDDLEWARE 令牌）。宿主在 @fw/core bootstrap 的 beforeListen 钩子里
 *   以 app.use 注册，执行顺序为 trace → tenant → 路由（模块级 forRoutes 在 Express 5 下
 *   不覆盖其他模块路由，故与 trace 中间件同层注册）。业务代码不感知租户解析——
 *   上下文写入 AsyncLocalStorage 后由 Repository（@fw/db tenantScoped）与日志自动消费。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/tenant
 */
import { DynamicModule, Global, Module, Provider, type InjectionToken } from '@nestjs/common';
import { loadEnv } from '@fw/config';
import { createTenantExpressMiddleware, type TenantExpressMiddleware } from './tenant.middleware.js';
import { TenantService, type TenantServiceOptions } from './tenant.service.js';
import { parseTenantOrder } from './resolver.js';
import { TENANT_MIDDLEWARE, TENANT_OPTIONS, TENANT_STORE, type TenantResolutionOptions, type TenantStorePort } from './types.js';

/** forRoot 参数 */
export interface TenantModuleOptions {
  /** 租户存储实现类（宿主提供，如 Prisma 查 `tenants` 表） */
  store: new (...args: never[]) => TenantStorePort;
  /** store 构造函数依赖（透传给 useFactory 的 inject；可为类型或注入令牌，如 @fw/db 的 DB_CLIENT） */
  inject?: InjectionToken[];
  /** 环境变量覆盖（默认 loadEnv()） */
  env?: TenantEnvLike;
  /** 解析配置覆盖（默认按 TENANT_* 环境变量） */
  resolution?: Partial<TenantResolutionOptions>;
  /** 是否启用多租户（默认取 TENANT_ENABLED） */
  enabled?: boolean;
  /** 租户信息缓存 TTL（秒，默认取 TENANT_CACHE_TTL=60） */
  cacheTtlSeconds?: number;
}

/** 运行时装配结果 */
export interface TenantRuntime {
  resolution: TenantResolutionOptions;
  serviceOptions: TenantServiceOptions;
}

/** 环境变量最小视图 */
export interface TenantEnvLike {
  TENANT_ENABLED?: boolean;
  TENANT_ORDER?: string;
  TENANT_HEADER_NAME?: string;
  TENANT_BASE_DOMAIN?: string;
  TENANT_JWT_CLAIM?: string;
  TENANT_CACHE_TTL?: number;
}

const DEFAULTS = {
  order: 'subdomain,header,jwt',
  headerName: 'x-tenant-id',
  jwtClaim: 'tenantId',
  cacheTtlSeconds: 60,
};

/** 解析运行时配置：env + overrides 合并（fail-fast：TENANT_ORDER 非法启动即失败） */
export function buildTenantRuntime(env: TenantEnvLike, overrides: Partial<TenantModuleOptions> = {}): TenantRuntime {
  const resolution: TenantResolutionOptions = {
    order: overrides.resolution?.order ?? parseTenantOrder(env.TENANT_ORDER ?? DEFAULTS.order),
    headerName: overrides.resolution?.headerName ?? env.TENANT_HEADER_NAME ?? DEFAULTS.headerName,
    baseDomain: overrides.resolution?.baseDomain ?? env.TENANT_BASE_DOMAIN,
    jwtClaim: overrides.resolution?.jwtClaim ?? env.TENANT_JWT_CLAIM ?? DEFAULTS.jwtClaim,
  };
  const serviceOptions: TenantServiceOptions = {
    resolution,
    enabled: overrides.enabled ?? env.TENANT_ENABLED ?? false,
    cacheTtlMs: (overrides.cacheTtlSeconds ?? env.TENANT_CACHE_TTL ?? DEFAULTS.cacheTtlSeconds) * 1000,
  };
  return { resolution, serviceOptions };
}

/**
 * 租户全局模块
 */
@Global()
@Module({})
export class TenantModule {
  /**
   * 装配租户能力
   * @param options 存储实现、环境覆盖与解析开关
   * @returns 动态模块定义
   */
  static forRoot(options: TenantModuleOptions): DynamicModule {
    const env = options.env ?? (loadEnv() as TenantEnvLike);
    const runtime = buildTenantRuntime(env, options);

    const providers: Provider[] = [
      {
        provide: TENANT_STORE,
        useFactory: (...args: unknown[]): TenantStorePort => new options.store(...(args as never[])),
        inject: options.inject ?? [],
      },
      { provide: TENANT_OPTIONS, useValue: runtime },
      {
        provide: TenantService,
        useFactory: (store: TenantStorePort, built: TenantRuntime): TenantService =>
          new TenantService(store, built.serviceOptions),
        inject: [TENANT_STORE, TENANT_OPTIONS],
      },
      {
        provide: TENANT_MIDDLEWARE,
        useFactory: (tenants: TenantService): TenantExpressMiddleware => createTenantExpressMiddleware(tenants),
        inject: [TenantService],
      },
    ];

    return {
      module: TenantModule,
      global: true,
      providers,
      exports: [TenantService, TENANT_STORE, TENANT_MIDDLEWARE],
    };
  }
}
