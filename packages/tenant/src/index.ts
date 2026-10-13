/*
 * @file @fw/tenant 对外导出
 * @description 多租户解析与上下文注入（PRD-008 FR-01）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/tenant
 */
import 'reflect-metadata';

export { TenantModule, buildTenantRuntime, type TenantEnvLike, type TenantModuleOptions, type TenantRuntime } from './tenant.module.js';
export { createTenantExpressMiddleware, type TenantExpressMiddleware, type TenantRequest } from './tenant.middleware.js';
export { TenantService, type TenantServiceOptions } from './tenant.service.js';
export { resolveTenantCode, parseTenantOrder } from './resolver.js';
export {
  TENANT_CODE_PATTERN,
  TENANT_MIDDLEWARE,
  TENANT_OPTIONS,
  TENANT_STORE,
  DEFAULT_TENANT_ORDER,
  type TenantInfo,
  type TenantIsolation,
  type TenantResolutionInput,
  type TenantResolutionOptions,
  type TenantSource,
  type TenantStorePort,
} from './types.js';
