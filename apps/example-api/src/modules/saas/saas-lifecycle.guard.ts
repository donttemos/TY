/*
 * @file 租户生命周期拦截守卫（M13，ADR-0031 §3）
 * @description 全局 Guard（APP_GUARD，注册序在 RbacGuard 之后）：frozen/terminated 租户的
 *   业务请求一律 4031。放行面三类：① @Public 路由（登录/健康等认证前能力）；
 *   ② @LifecycleExempt() 白名单（运营面/导出/生命周期查询，ADR-0031 §3.2）；
 *   ③ 无租户上下文（TENANT_ENABLED=false 单租户模式沿既有行为，不引入新拦截面）。
 *   状态读走 SaasStore（findTenantStatus 直查派生列，ADR-0029 §2.2）；缓存优化登记待办
 *   （余量缓存 60s + 迁移写路径失效，与 ADR-0029 §4 同协议），当前直查以正确性优先。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import { type CanActivate, type ExecutionContext, Inject, Injectable } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { getRequestContext } from '@fw/logger';
import { META_PUBLIC } from '@fw/auth';
import { TenantSuspendedError, recordTenantSuspendedRejectedMetric } from '@fw/saas';
import type { SaasStore } from '@fw/saas';
import { META_LIFECYCLE_EXEMPT } from './lifecycle.decorator.js';
import { SAAS_STORE } from './saas.tokens.js';

@Injectable()
export class SaasLifecycleGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    @Inject(SAAS_STORE) private readonly store: SaasStore,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const sources = [context.getHandler(), context.getClass()];
    // ① @Public：认证前能力（登录/健康/自检）放行
    if (this.reflector.getAllAndOverride<boolean>(META_PUBLIC, sources)) return true;
    // ② 白名单：运营面/导出/生命周期查询（默认拒绝，装饰器显式豁免）
    if (this.reflector.getAllAndOverride<boolean>(META_LIFECYCLE_EXEMPT, sources)) return true;
    // ③ 多租户上下文：frozen/terminated 拒绝业务访问（4031）
    const tenantId = getRequestContext()?.tenantId;
    if (!tenantId) return true; // 单租户模式无 ALS 上下文：沿既有行为（legacy 停用语义由解析路径 4001 承载）
    const status = await this.store.findTenantStatus(tenantId);
    if (status === 'frozen' || status === 'terminated') {
      recordTenantSuspendedRejectedMetric();
      throw new TenantSuspendedError(tenantId, status);
    }
    return true;
  }
}
