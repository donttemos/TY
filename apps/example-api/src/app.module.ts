/*
 * @file 应用根模块（M4：接入缓存层）
 * @description 组装框架核心（FwCoreModule.forRoot 完成配置校验、日志初始化、健康检查、就绪探针）、
 *   缓存层（CacheModule.forRoot：按 CACHE_DRIVER 装配 memory/redis 驱动与 /metrics）、
 *   鉴权模块（AppAuthModule：全局守卫 + 审计拦截器 + 权限缓存接 CacheService）与业务模块；
 *   db 与 cache 两个就绪探针在此注册到 /ready（TC-ORM-006 / PRD-004）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo M4 接入 CacheModule（memory 默认）+ 缓存就绪探针 + 缓存演示模块
 * @modified 2026-10-13 donttemo M6 接入 DemoItemModule（fw gen crud 生成的 CRUD 验证载体）
 * @modified 2026-10-13 donttemo M7 接入 QueueModule（memory 默认）+ 队列就绪探针 + 队列演示模块
 * @modified 2026-10-13 donttemo M8 接入 TenantModule（默认单租户模式；TENANT_ENABLED 一改即切多租户）
 * @modified 2026-10-14 donttemo M8 接入 TransportModule（in-process 默认）+ 传输就绪探针 + 传输演示模块
 * @modified 2026-10-14 donttemo M8 T-M8-06 接入 TelemetryModule（OTEL_ENABLED=false 零开销）
 * @modified 2026-10-15 donttemo N-01/N-02 接入 JobsModule（异步任务中心，@Global）与 TenantAdminModule
 *   （/api/v1/tenants 五端点）
 * @modified 2026-10-15 donttemo M9/PRD-009 接入 ConfigCenterModule（/api/v1/configs 两端点；默认
 *   CONFIG_CENTER_ENABLED=false 零开销，开启后 file 适配 + 热更白名单 11 键订阅生效）
 * @modified 2026-10-15 donttemo M10 E-01：JobsModule 改 forRoot() 装配（按 JOB_CENTER_DRIVER
 *   选 memory/db/bullmq 驱动，默认 memory 行为不变）
 * @modified 2026-10-15 donttemo M10 E-03：接入框架级 API 限流——RATE_LIMIT_LIMITER 按 env 构造
 *   （令牌桶状态存 CACHE_STORE），RateLimitMiddleware 挂 /api/v1 全路由（豁免白名单在 limiter 内判定）
 * @modified 2026-10-15 donttemo M10 E-12：接入 EventsModule（SSE 实时推送）+ 队列死信告警汇
 *   （QueueModule.forRoot 的 alert 转事件面）
 * @modified 2026-10-15 donttemo M10 E-13：接入 NotificationsModule（站内信订阅事件面落库 + 用户面端点）
 * @modified 2026-10-15 donttemo M10 E-17：接入 ClientErrorsModule（前端 RUM 错误上报接收面
 *   /api/v1/telemetry/client-errors，@Public + error 级结构化日志 + 进程内计数）
 * @module example-api
 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import { CacheModule, createCacheReadinessProbe, RateLimitLimiter, RateLimitMiddleware, setGlobalRateLimiter, CACHE_STORE, RATE_LIMIT_LIMITER } from '@fw/cache';
import type { CacheStorePort } from '@fw/cache';
import { loadEnv } from '@fw/config';
import { DB_CLIENT } from '@fw/db';
import { FwCoreModule } from '@fw/core';
import { QueueModule, createQueueReadinessProbe } from '@fw/queue';
import { TelemetryModule } from '@fw/telemetry';
import { TenantModule } from '@fw/tenant';
import { TransportModule, createTransportReadinessProbe } from '@fw/transport';
import { AppAuthModule } from './modules/auth/app-auth.module.js';
import { CacheDemoModule } from './modules/cache-demo/cache-demo.module.js';
import { ClientErrorsModule } from './modules/client-errors/client-errors.module.js';
import { ConfigCenterModule } from './modules/config-center/config-center.module.js';
import { DemoModule, dbReadinessProbe } from './modules/demo/demo.module.js';
import { DemoItemModule } from './modules/demo-item/demo-item.module.js';
import { DemoQueueModule } from './modules/demo-queue/demo-queue.module.js';
import { DemoTransportModule } from './modules/demo-transport/demo-transport.module.js';
import { EventsModule } from './modules/events/events.module.js';
import { publishQueueAlert } from './modules/events/queue-alerts.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { NotificationsModule } from './modules/notifications/notifications.module.js';
import { TenantAdminModule } from './modules/tenant/tenant-admin.module.js';
import { PrismaTenantStore } from './modules/tenant/prisma-tenant-store.js';
import { UploadModule } from './modules/upload/upload.module.js';

/** 缓存就绪探针：与 CacheModule.forRoot 共用同一实例（装配后由模块绑定缓存服务） */
export const cacheReadinessProbe = createCacheReadinessProbe();

/** 队列就绪探针：与 QueueModule.forRoot 共用同一实例（装配后由模块绑定队列服务） */
export const queueReadinessProbe = createQueueReadinessProbe();

/** 传输就绪探针：与 TransportModule.forRoot 共用同一实例（装配后由模块绑定传输服务） */
export const transportReadinessProbe = createTransportReadinessProbe();

/** 限流豁免前缀（env 逗号分隔 → 数组，供 limiter 前缀匹配） */
function parseWhitelist(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 应用根模块：新增业务模块在此追加 import
 */
@Module({
  providers: [
    // M10 E-03：框架级限流器（令牌桶状态存 CACHE_STORE——memory 进程内 / redis Lua 原子多实例共享；
    // RATE_LIMIT_DRY_RUN=true 时仅计数告警不拦截，灰度观测先行）
    {
      provide: RATE_LIMIT_LIMITER,
      useFactory: (store: CacheStorePort): RateLimitLimiter => {
        const env = loadEnv();
        const limiter = new RateLimitLimiter({
          store,
          capacity: env.RATE_LIMIT_CAPACITY,
          refillPerSecond: env.RATE_LIMIT_REFILL_PER_SECOND,
          whitelist: parseWhitelist(env.RATE_LIMIT_WHITELIST),
          failOpen: env.RATE_LIMIT_FAIL_OPEN,
          dryRun: env.RATE_LIMIT_DRY_RUN,
        });
        // /metrics 渲染经模块级引用取计数（CacheModule 内控制器与根模块 provider 无直接注入关系）
        setGlobalRateLimiter(limiter);
        return limiter;
      },
      inject: [CACHE_STORE],
    },
  ],
  imports: [
    FwCoreModule.forRoot({ readinessProbes: [dbReadinessProbe, cacheReadinessProbe, queueReadinessProbe, transportReadinessProbe] }),
    CacheModule.forRoot({ readinessProbe: cacheReadinessProbe }),
    // 执行守卫复用 @fw/cache 的 CacheService：CACHE_DRIVER=redis 时 cron 天然集群单跑，
    // memory 驱动下退化为进程内锁并在启动期告警（PRD-007 §8）
    // M10 E-12：死信告警经模块级汇转 SSE 通道（forRoot 是静态装配点，拿不到 DI 容器）
    QueueModule.forRoot({
      readinessProbe: queueReadinessProbe,
      alert: (record, reason) =>
        publishQueueAlert({
          kind: 'dead-letter',
          at: new Date().toISOString(),
          queue: record.queue,
          jobId: record.id,
          jobName: record.name,
          attemptsMade: record.attemptsMade,
          reason,
        }),
    }),
    // 传输层（M8 T-M8-05）：默认 TRANSPORT_DRIVER=in-process（进程内直调，零依赖）；
    // 跨进程 / 微服务拆分时一改即切 redis，业务代码零改动（PRD-008 FR-06 / TC-TNT-005）
    TransportModule.forRoot({ readinessProbe: transportReadinessProbe }),
    // 多租户（M8）：默认 TENANT_ENABLED=false（单租户模式，解析直接短路）；
    // 冒烟与多租户部署通过环境变量一改即切，业务代码零改动（PRD-008 FR-01）
    TenantModule.forRoot({ store: PrismaTenantStore, inject: [DB_CLIENT] }),
    // 链路追踪（M8 T-M8-06 / PRD-008 FR-07）：默认 OTEL_ENABLED=false（零开销，SDK 为 optional peer）。
    // 接追踪时置 OTEL_ENABLED=true + OTEL_EXPORTER_URL，并安装 @opentelemetry/sdk-node 与导出器
    TelemetryModule.forRoot(),
    AppAuthModule,
    DemoModule,
    CacheDemoModule,
    // M10 E-17：前端 RUM 错误上报（admin-web 实时用户监控的服务端接收面；@Public——
    // 登录页与未登录态异常同样上报；观测旁路不写业务库，主观测路径是 error 级结构化日志）
    ClientErrorsModule,
    DemoItemModule,
    DemoQueueModule,
    DemoTransportModule,
    // N-02/E-01：异步任务中心（@Global，审计导出与租户迁移共用；任务面端点 /api/v1/jobs；
    // JOB_CENTER_DRIVER 默认 memory = N-02 原行为，db/bullmq 驱动多副本语义见 jobs.module）
    JobsModule.forRoot(),
    // M10 E-12：SSE 实时推送（任务进度 / 队列告警经统一通道下发；前端轮询降级为兜底）
    EventsModule,
    // M10 E-13：站内信 / 通知中心（订阅事件面落库 + /notifications 用户面；实时未读走 SSE）
    NotificationsModule,
    // N-01：租户管理端点（/api/v1/tenants 五端点；跨租户维护面，标 @IgnoreTenant）
    TenantAdminModule,
    // M9：配置中心（/api/v1/configs 查/改两端点；CONFIG_CENTER_ENABLED=false 时零开销仅 env 视图）
    ConfigCenterModule.forRoot(),
    // M10 E-09：附件上传（/api/v1/files 三端点；文件内容经 @fw/storage 端口，
    // STORAGE_DRIVER=local/s3 一改即切，业务代码零改动）
    UploadModule,
  ],
})
export class AppModule implements NestModule {
  /**
   * 全局中间件：限流挂 /api/v1 业务路由组（health/ready/metrics 由 RATE_LIMIT_WHITELIST 默认豁免）
   */
  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(RateLimitMiddleware).forRoutes('/api/v1');
  }
}
