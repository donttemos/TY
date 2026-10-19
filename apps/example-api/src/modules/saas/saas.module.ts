/*
 * @file SaaS 运营模块（M13）
 * @description 注册 @fw/saas 五个领域服务与 PrismaSaasStore 端口实现（SAAS_STORE token 绑定）、
 *   运营端点（SaasOpsController，@IgnoreTenant + @LifecycleExempt 白名单）、到期处置任务
 *   （SaasLifecycleJobs，@Cron + 分布式锁）与业务入口拦截守卫（SaasLifecycleGuard，APP_GUARD
 *   注册序在 RbacGuard 之后——本模块在 app.module imports 中位于 AuthModule 之后）。
 *   本模块只做装配，业务规则全部在 @fw/saas（ADR-0029~0031）。
 * @author donttemo
 * @created 2026-10-19
 * @module example-api/saas
 */

import { Module, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { Reflector } from '@nestjs/core';
import {
  PlanService,
  QuotaService,
  SubscriptionService,
  TenantLifecycleService,
  UsageService,
} from '@fw/saas';
import { PrismaSaasStore } from './prisma-saas-store.js';
import { SaasLifecycleGuard } from './saas-lifecycle.guard.js';
import { SaasLifecycleJobs } from './saas-lifecycle.jobs.js';
import { SaasOpsController } from './saas-ops.controller.js';
import { SAAS_STORE } from './saas.tokens.js';

/** 五服务共享同一 SaasStore 实例（无状态，装配期绑定） */
function serviceProviders(): Provider[] {
  return [
    { provide: SAAS_STORE, useClass: PrismaSaasStore },
    { provide: PlanService, useFactory: (store: PrismaSaasStore) => new PlanService(store), inject: [SAAS_STORE] },
    { provide: QuotaService, useFactory: (store: PrismaSaasStore) => new QuotaService(store, store, store), inject: [SAAS_STORE] },
    { provide: SubscriptionService, useFactory: (store: PrismaSaasStore) => new SubscriptionService(store, store, store), inject: [SAAS_STORE] },
    { provide: UsageService, useFactory: (store: PrismaSaasStore) => new UsageService(new QuotaService(store, store, store), store, store), inject: [SAAS_STORE] },
    { provide: TenantLifecycleService, useFactory: (store: PrismaSaasStore) => new TenantLifecycleService(store), inject: [SAAS_STORE] },
    // 业务入口拦截（4031）：全局守卫，注册序在 RbacGuard 之后（app.module imports 顺序保证）
    { provide: APP_GUARD, useFactory: (reflector: Reflector, store: PrismaSaasStore) => new SaasLifecycleGuard(reflector, store), inject: [Reflector, SAAS_STORE] },
  ];
}

/**
 * SaaS 运营模块
 */
@Module({
  controllers: [SaasOpsController],
  providers: [...serviceProviders(), SaasLifecycleJobs],
  exports: [SAAS_STORE, PlanService, QuotaService, SubscriptionService, UsageService, TenantLifecycleService],
})
export class SaasModule {}
