/*
 * @file 租户解析中间件（express 级）
 * @description PRD-008 FR-01：在 trace 中间件之后、路由处理器之前解析租户并写入
 *   AsyncLocalStorage 请求上下文（tenantId）。此时仅完成「定位」，`tenantVerified` 仍为 false——
 *   只有鉴权守卫确认「当前用户归属该租户」后才置位，Repository 层据此 fail-closed。
 *   经 @fw/core bootstrap 的 beforeListen 钩子以 app.use 注册（模块级 forRoutes 在
 *   Express 5 下不覆盖其他模块的路由，故与 trace 中间件同层注册，顺序 trace → tenant → 路由）。
 *   M8 T-M8-02：解析结果除 tenantId 外，还把 isolation 与解密后的独立库连接串写入上下文，
 *   供 @fw/db 的 TenantDataSource 做 dedicated 租户数据源路由。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/tenant
 */
import type { NextFunction, Request, Response } from 'express';
import { patchRequestContext, Logger } from '@fw/logger';
import { TenantService } from './tenant.service.js';
import type { TenantInfo, TenantResolutionInput } from './types.js';

const logger = Logger.for('tenant');

/** 携带租户信息的请求对象 */
export interface TenantRequest extends Request {
  /** 当前请求解析出的租户（多租户启用且解析成功时存在） */
  tenant?: TenantInfo;
}

/** 运维路径豁免：健康检查 / 就绪 / 指标不做租户解析（与 @fw/auth DEFAULT_PUBLIC_PATHS 对齐） */
const SKIP_PATH_PREFIXES = ['/health', '/ready', '/metrics'] as const;

/** 归一化请求头为小写键集合 */
function lowerHeaders(req: Request): Record<string, string | string[] | undefined> {
  const out: Record<string, string | string[] | undefined> = {};
  for (const [key, value] of Object.entries(req.headers) as [string, string | string[] | undefined][]) {
    out[key.toLowerCase()] = value;
  }
  return out;
}

/** express 中间件函数类型 */
export type TenantExpressMiddleware = (req: Request, res: Response, next: NextFunction) => void;

/**
 * 创建租户中间件：多租户启用时，未携带有效租户标识的请求直接 403（fail-closed）；
 * 未启用时零开销短路（直接 next）。
 */
export function createTenantExpressMiddleware(tenants: TenantService): TenantExpressMiddleware {
  return function tenantMiddleware(req: Request, res: Response, next: NextFunction): void {
    const path = req.url.split('?')[0] ?? req.url;
    if (SKIP_PATH_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`))) {
      next();
      return;
    }
    const input: TenantResolutionInput = {
      host: req.headers.host,
      headers: lowerHeaders(req),
      extractJwtClaim: (req as TenantRequest & { tenantClaim?: string }).tenantClaim
        ? () => (req as TenantRequest & { tenantClaim?: string }).tenantClaim
        : undefined,
    };
    tenants
      .resolve(input)
      .then((tenant: TenantInfo | null) => {
        if (tenant) {
          // 隔离级别与独立库连接串随上下文透传（T-M8-02）：@fw/db 的 TenantDataSource
          // 据此把 dedicated 租户的查询路由到独立库 client；dbUrl 仅进程内传递，禁入日志
          patchRequestContext({
            tenantId: tenant.id,
            tenantIsolation: tenant.isolation,
            ...(tenant.dbUrl ? { tenantDbUrl: tenant.dbUrl } : {}),
          });
          (req as TenantRequest).tenant = tenant;
        }
        next();
      })
      .catch((error: unknown) => {
        logger.warn('租户解析失败（fail-closed）', {
          url: req.url,
          error: error instanceof Error ? error.message : String(error),
        });
        next(error);
      });
  };
}
