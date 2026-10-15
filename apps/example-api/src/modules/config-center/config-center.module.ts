/*
 * @file 配置中心模块（M9/PRD-009）
 * @description 按 CONFIG_CENTER_ENABLED 装配：
 *   true  —— file 驱动（mtime 轮询）+ ConfigCenterService + 审计桥 + 订阅生命周期（init → 订阅 → syncAll）；
 *   false —— 仅注册「env 视图」服务实例（不读文件不起轮询），GET /configs 提供只读视图，PUT 一律 1004。
 *   审计经 ConfigAuditBridge 桥进统一审计（端口反转）；TelemetryService 所在模块非全局，
 *   显式 import TelemetryModule.forRoot()（与 AppModule 的同参动态模块按 Nest 语义去重为同一实例）。
 *   cache / queue / tenant / auth 四域服务均为全局模块导出，直接注入；queue 域服务经
 *   QUEUE_SERVICE 令牌可选注入（与 QueueModule 消费 CACHE_SERVICE 的先例一致）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CACHE_SERVICE, type CacheService } from '@fw/cache';
import { loadEnv } from '@fw/config';
import { ConfigCenterService, FileConfigDriver, type ConfigDriverPort } from '@fw/config-center';
import { AuditService } from '@fw/auth';
import { QUEUE_SERVICE, type QueueService } from '@fw/queue';
import { TelemetryModule, TelemetryService } from '@fw/telemetry';
import { TenantService } from '@fw/tenant';
import { ConfigAuditBridge } from './audit-bridge.js';
import { ConfigCenterLifecycle } from './config-center.lifecycle.js';
import { CONFIG_CENTER, CONFIG_CENTER_STATE, CONFIG_SUBSCRIPTION_TARGETS } from './config-center.tokens.js';
import type { ConfigSubscriptionTargets } from './config-subscriptions.js';
import { ConfigsController } from './configs.controller.js';

/** 驱动令牌（内部装配用） */
export const CONFIG_CENTER_DRIVER = 'FW_CONFIG_CENTER_DRIVER';

/**
 * 配置中心模块（全局）
 */
@Global()
@Module({})
export class ConfigCenterModule {
  /**
   * 装配配置中心
   * @returns 动态模块定义
   */
  static forRoot(): DynamicModule {
    const env = loadEnv();
    const enabled = env.CONFIG_CENTER_ENABLED;

    const providers: Provider[] = [
      { provide: CONFIG_CENTER_STATE, useValue: { enabled } },
      {
        provide: CONFIG_CENTER_DRIVER,
        useFactory: (): ConfigDriverPort =>
          new FileConfigDriver({ file: env.CONFIG_CENTER_FILE, pollSeconds: env.CONFIG_CENTER_POLL_SECONDS }),
      },
      {
        provide: CONFIG_CENTER,
        useFactory: (driver: ConfigDriverPort, audit: AuditService): ConfigCenterService =>
          new ConfigCenterService({ driver, env, audit: new ConfigAuditBridge(audit) }),
        inject: [CONFIG_CENTER_DRIVER, AuditService],
      },
      // 可订阅框架服务集合：cache / queue / tenant / audit 为全局模块导出；
      // telemetry 经本模块 import TelemetryModule.forRoot() 提供（非全局，同参去重）
      {
        provide: CONFIG_SUBSCRIPTION_TARGETS,
        useFactory: (options: {
          cache?: CacheService;
          queue?: QueueService;
          telemetry?: TelemetryService;
          tenant?: TenantService;
        }): ConfigSubscriptionTargets => ({
          ...(options.cache ? { cache: options.cache } : {}),
          ...(options.queue ? { queue: options.queue } : {}),
          ...(options.telemetry ? { telemetry: options.telemetry } : {}),
          ...(options.tenant ? { tenant: options.tenant } : {}),
        }),
        inject: [
          { token: CACHE_SERVICE, optional: true },
          { token: QUEUE_SERVICE, optional: true },
          { token: TelemetryService, optional: true },
          { token: TenantService, optional: true },
        ],
      },
      ...(enabled ? [ConfigCenterLifecycle] : []),
    ];

    return {
      module: ConfigCenterModule,
      global: true,
      ...(enabled ? { imports: [TelemetryModule.forRoot()] } : {}),
      providers,
      controllers: [ConfigsController],
      exports: [CONFIG_CENTER, CONFIG_CENTER_STATE, CONFIG_SUBSCRIPTION_TARGETS],
    };
  }
}
