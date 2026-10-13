/*
 * @file 应用根模块（M4：接入缓存层）
 * @description 组装框架核心（FwCoreModule.forRoot 完成配置校验、日志初始化、健康检查、就绪探针）、
 *   缓存层（CacheModule.forRoot：按 CACHE_DRIVER 装配 memory/redis 驱动与 /metrics）、
 *   鉴权模块（AppAuthModule：全局守卫 + 审计拦截器 + 权限缓存接 CacheService）与业务模块；
 *   db 与 cache 两个就绪探针在此注册到 /ready（TC-ORM-006 / PRD-004）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo M4 接入 CacheModule（memory 默认）+ 缓存就绪探针 + 缓存演示模块
 * @module example-api
 */
import { Module } from '@nestjs/common';
import { CacheModule, createCacheReadinessProbe } from '@fw/cache';
import { FwCoreModule } from '@fw/core';
import { AppAuthModule } from './modules/auth/app-auth.module.js';
import { CacheDemoModule } from './modules/cache-demo/cache-demo.module.js';
import { DemoModule, dbReadinessProbe } from './modules/demo/demo.module.js';

/** 缓存就绪探针：与 CacheModule.forRoot 共用同一实例（装配后由模块绑定缓存服务） */
export const cacheReadinessProbe = createCacheReadinessProbe();

/**
 * 应用根模块：新增业务模块在此追加 import
 */
@Module({
  imports: [
    FwCoreModule.forRoot({ readinessProbes: [dbReadinessProbe, cacheReadinessProbe] }),
    CacheModule.forRoot({ readinessProbe: cacheReadinessProbe }),
    AppAuthModule,
    DemoModule,
    CacheDemoModule,
  ],
})
export class AppModule {}
