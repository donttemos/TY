/*
 * @file 配置中心模块（M9/PRD-009；M10 E-02 多实例语义）
 * @description 按 CONFIG_CENTER_ENABLED 装配：
 *   true  —— 事实源驱动（file：mtime 轮询 / nacos：v1 Open API 内容 MD5 轮询，M10 E-02 转正）
 *            + ConfigCenterService + 快照历史持久端口（PrismaConfigHistoryStore，config_snapshots 表，
 *            版本基线与回滚候选跨实例一致——AC2）+ 审计桥 + 订阅生命周期（init → 订阅 → syncAll）；
 *   false —— 仅注册「env 视图」服务实例（不读事实源不起轮询），GET /configs 提供只读视图，PUT 一律 1004。
 *   审计经 ConfigAuditBridge 桥进统一审计（端口反转）；TelemetryService 所在模块非全局，
 *   显式 import TelemetryModule.forRoot()（与 AppModule 的同参动态模块按 Nest 语义去重为同一实例）。
 *   cache / queue / tenant / auth 四域服务均为全局模块导出，直接注入；queue 域服务经
 *   QUEUE_SERVICE 令牌可选注入（与 QueueModule 消费 CACHE_SERVICE 的先例一致）。
 * @modified 2026-10-15 donttemo M10 E-02：nacos 驱动转正入装配（CONFIG_CENTER_NACOS_* 6 键，
 *   serverAddr 缺失启动即失败）；注入 PrismaConfigHistoryStore（多实例版本/回滚一致）
 * @modified 2026-10-15 donttemo M10/E-16：快照历史保留版本数经 CONFIG_CENTER_HISTORY_MAX 配置
 *   （服务 maxHistory 与持久淘汰窗口同源，缺省 20）
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import { Global, Module, type DynamicModule, type Provider } from '@nestjs/common';
import { CACHE_SERVICE, type CacheService } from '@fw/cache';
import { loadEnv } from '@fw/config';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import { ConfigCenterService, FileConfigDriver, NacosConfigDriver, type ConfigDriverPort, type ConfigHistoryPort } from '@fw/config-center';
import { AuditService } from '@fw/auth';
import { QUEUE_SERVICE, type QueueService } from '@fw/queue';
import { TelemetryModule, TelemetryService } from '@fw/telemetry';
import { TenantService } from '@fw/tenant';
import { ConfigAuditBridge } from './audit-bridge.js';
import { ConfigCenterLifecycle } from './config-center.lifecycle.js';
import { CONFIG_CENTER, CONFIG_CENTER_STATE, CONFIG_SUBSCRIPTION_TARGETS } from './config-center.tokens.js';
import { PrismaConfigHistoryStore } from './history-store.js';
import type { ConfigSubscriptionTargets } from './config-subscriptions.js';
import { ConfigsController } from './configs.controller.js';

/** 驱动令牌（内部装配用） */
export const CONFIG_CENTER_DRIVER = 'FW_CONFIG_CENTER_DRIVER';

/** 快照历史端口令牌（内部装配用） */
export const CONFIG_HISTORY = 'FW_CONFIG_HISTORY';

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
        useFactory: (): ConfigDriverPort => {
          // M10 E-02：nacos 驱动转正入装配（v1 Open API 内容 MD5 轮询——多实例天然安全）；
          // serverAddr 缺失启动即失败（fail-fast，与非法枚举值同语义）
          if (env.CONFIG_CENTER_DRIVER === 'nacos') {
            if (!env.CONFIG_CENTER_NACOS_SERVER_ADDR) {
              throw new Error('CONFIG_CENTER_DRIVER=nacos 需要配置 CONFIG_CENTER_NACOS_SERVER_ADDR（缺失启动即失败）');
            }
            return new NacosConfigDriver({
              serverAddr: env.CONFIG_CENTER_NACOS_SERVER_ADDR,
              dataId: env.CONFIG_CENTER_NACOS_DATA_ID,
              group: env.CONFIG_CENTER_NACOS_GROUP,
              namespace: env.CONFIG_CENTER_NACOS_NAMESPACE,
              username: env.CONFIG_CENTER_NACOS_USERNAME,
              password: env.CONFIG_CENTER_NACOS_PASSWORD,
              pollSeconds: env.CONFIG_CENTER_POLL_SECONDS,
            });
          }
          return new FileConfigDriver({ file: env.CONFIG_CENTER_FILE, pollSeconds: env.CONFIG_CENTER_POLL_SECONDS });
        },
      },
      // M10 E-02：快照历史持久端口（config_snapshots 表）——多实例版本基线与回滚候选跨实例一致（AC2）
      // M10/E-16：淘汰窗口经 CONFIG_CENTER_HISTORY_MAX 配置（与 ConfigCenterService.maxHistory 同源）
      {
        provide: CONFIG_HISTORY,
        useFactory: (client: PrismaClientLike): ConfigHistoryPort =>
          new PrismaConfigHistoryStore(client, env.CONFIG_CENTER_HISTORY_MAX),
        inject: [DB_CLIENT],
      },
      {
        provide: CONFIG_CENTER,
        useFactory: (driver: ConfigDriverPort, audit: AuditService, history: ConfigHistoryPort): ConfigCenterService =>
          new ConfigCenterService({
            driver,
            env,
            audit: new ConfigAuditBridge(audit),
            history,
            maxHistory: env.CONFIG_CENTER_HISTORY_MAX,
          }),
        inject: [CONFIG_CENTER_DRIVER, AuditService, CONFIG_HISTORY],
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
