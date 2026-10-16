/*
 * @file 应用根模块（admin 模板）
 * @description 组装框架核心 + 缓存 + 鉴权（RBAC）+ 管理端点 + 示例 CRUD + 附件上传。
 *   全部能力来自既有 packages（@fw/*），模板不新增框架功能；新增业务模块在此追加 import。
 * @author donttemo
 * @created 2026-10-15
 * @module __APP_NAME__
 * @since v0.1.0
 */
import { Module, type MiddlewareConsumer, type NestModule } from '@nestjs/common';
import {
  CacheModule,
  createCacheReadinessProbe,
  CACHE_STORE,
  RATE_LIMIT_LIMITER,
  RateLimitLimiter,
  RateLimitMiddleware,
  setGlobalRateLimiter,
} from '@fw/cache';
import type { CacheStorePort } from '@fw/cache';
import { loadEnv } from '@fw/config';
import { FwCoreModule } from '@fw/core';
import { AppAuthModule } from './modules/auth/app-auth.module.js';
import { TemplateDbModule, dbReadinessProbe } from './modules/db/db.module.js';
import { DemoItemModule } from './modules/demo-item/demo-item.module.js';
import { UploadModule } from './modules/upload/upload.module.js';

/** 缓存就绪探针：与 CacheModule.forRoot 共用同一实例 */
export const cacheReadinessProbe = createCacheReadinessProbe();

/** 限流豁免前缀（env 逗号分隔 → 数组，供 limiter 前缀匹配） */
function parseWhitelist(raw: string): string[] {
  return raw
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item !== '');
}

/**
 * 应用根模块
 */
@Module({
  providers: [
    // 框架级限流（E-03）：令牌桶状态存 CACHE_STORE——memory 进程内 / redis Lua 原子多实例共享；
    // RATE_LIMIT_DRY_RUN=true 时仅计数告警不拦截，灰度观测先行
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
        // /metrics 渲染经模块级引用取计数
        setGlobalRateLimiter(limiter);
        return limiter;
      },
      inject: [CACHE_STORE],
    },
  ],
  imports: [
    FwCoreModule.forRoot({ readinessProbes: [dbReadinessProbe, cacheReadinessProbe] }),
    CacheModule.forRoot({ readinessProbe: cacheReadinessProbe }),
    // 数据库连接（DB_CLIENT 全局可注入 + 慢查询插桩 + 就绪探针）
    TemplateDbModule,
    // 登录 + RBAC + 用户/角色/菜单/字典/审计管理端点（@fw/auth 装配 + ADMIN_STORE）
    AppAuthModule,
    // 示例 CRUD（fw gen crud 产物形态，带权限点守卫）
    DemoItemModule,
    // 附件上传（PRD-010 E-09 收编：文件内容经 @fw/storage 端口，STORAGE_DRIVER=local/s3 一改即切；
    // StorageModule 由 UploadModule 内部 forRoot 装配）
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
