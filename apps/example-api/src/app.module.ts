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
 * @module example-api
 */
import { Module } from '@nestjs/common';
import { CacheModule, createCacheReadinessProbe } from '@fw/cache';
import { DB_CLIENT } from '@fw/db';
import { FwCoreModule } from '@fw/core';
import { QueueModule, createQueueReadinessProbe } from '@fw/queue';
import { TelemetryModule } from '@fw/telemetry';
import { TenantModule } from '@fw/tenant';
import { TransportModule, createTransportReadinessProbe } from '@fw/transport';
import { AppAuthModule } from './modules/auth/app-auth.module.js';
import { CacheDemoModule } from './modules/cache-demo/cache-demo.module.js';
import { ConfigCenterModule } from './modules/config-center/config-center.module.js';
import { DemoModule, dbReadinessProbe } from './modules/demo/demo.module.js';
import { DemoItemModule } from './modules/demo-item/demo-item.module.js';
import { DemoQueueModule } from './modules/demo-queue/demo-queue.module.js';
import { DemoTransportModule } from './modules/demo-transport/demo-transport.module.js';
import { JobsModule } from './modules/jobs/jobs.module.js';
import { TenantAdminModule } from './modules/tenant/tenant-admin.module.js';
import { PrismaTenantStore } from './modules/tenant/prisma-tenant-store.js';

/** 缓存就绪探针：与 CacheModule.forRoot 共用同一实例（装配后由模块绑定缓存服务） */
export const cacheReadinessProbe = createCacheReadinessProbe();

/** 队列就绪探针：与 QueueModule.forRoot 共用同一实例（装配后由模块绑定队列服务） */
export const queueReadinessProbe = createQueueReadinessProbe();

/** 传输就绪探针：与 TransportModule.forRoot 共用同一实例（装配后由模块绑定传输服务） */
export const transportReadinessProbe = createTransportReadinessProbe();

/**
 * 应用根模块：新增业务模块在此追加 import
 */
@Module({
  imports: [
    FwCoreModule.forRoot({ readinessProbes: [dbReadinessProbe, cacheReadinessProbe, queueReadinessProbe, transportReadinessProbe] }),
    CacheModule.forRoot({ readinessProbe: cacheReadinessProbe }),
    // 执行守卫复用 @fw/cache 的 CacheService：CACHE_DRIVER=redis 时 cron 天然集群单跑，
    // memory 驱动下退化为进程内锁并在启动期告警（PRD-007 §8）
    QueueModule.forRoot({ readinessProbe: queueReadinessProbe }),
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
    DemoItemModule,
    DemoQueueModule,
    DemoTransportModule,
    // N-02：异步任务中心（@Global，审计导出与租户迁移共用；任务面端点 /api/v1/jobs）
    JobsModule,
    // N-01：租户管理端点（/api/v1/tenants 五端点；跨租户维护面，标 @IgnoreTenant）
    TenantAdminModule,
    // M9：配置中心（/api/v1/configs 查/改两端点；CONFIG_CENTER_ENABLED=false 时零开销仅 env 视图）
    ConfigCenterModule.forRoot(),
  ],
})
export class AppModule {}
