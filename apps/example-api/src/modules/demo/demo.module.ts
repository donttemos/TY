/*
 * @file 演示模块定义（M2：接入 @fw/db）
 * @description 注册 DbModule.forRoot（慢查询插桩 + 全局 client），
 *   并暴露 DemoItemRepository 供控制器使用。数据库就绪探针经 app.module 传入 FwCoreModule。
 *   切换数据库：改 .env 的 DB_DRIVER/DB_URL + fw db:migrate，本文件零改动（TC-ORM-008）。
 *   M8 T-M8-02：装配 TenantDataSource（dedicated 租户独立库路由）并以 TENANT_DATA_SOURCE
 *   注入容器；未启用多租户时所有解析回退默认 client，行为与 M2–M7 完全一致。
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-14 donttemo M8 T-M8-02 注册 TENANT_DATA_SOURCE（dedicated 独立库路由）
 * @module demo
 */
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '@fw/config';
import { DbModule, DB_CLIENT, TENANT_DATA_SOURCE, type DbReadinessProbe, type PrismaClientLike } from '@fw/db';
import { DemoController } from './demo.controller.js';
import { DemoItemRepository } from './demo-item.repository.js';
import { DemoTenantItemsController } from './demo-tenant-items.controller.js';
import { createTenantDataSource } from '../tenant/tenant-data-source.js';

/** 配置驱动名 → Prisma provider 名（postgres 是配置侧简称） */
const PROVIDER_MAP = { sqlite: 'sqlite', mysql: 'mysql', postgres: 'postgresql' } as const;

// 启动期校验配置（与 FwCoreModule 同一份 loadEnv，缺项即失败）
const env = loadEnv();

/** 数据库就绪探针实例：app.module 会把它传给 FwCoreModule.forRoot */
export const dbReadinessProbe: DbReadinessProbe = DbModule.readinessProbe(
  PROVIDER_MAP[env.DB_DRIVER],
  env.DB_SLOW_MS,
);

/** 共享库 client：DbModule 与 TenantDataSource 共用同一实例 */
const prismaClient = new PrismaClient() as unknown as PrismaClientLike;

/** 租户数据源（M8 T-M8-02）：dedicated 租户按上下文路由独立库，其余回退共享库 */
export const tenantDataSource = createTenantDataSource(prismaClient, env.DB_SLOW_MS);

@Module({
  imports: [
    DbModule.forRoot({
      // 业务项目用自身 schema 生成的强类型 client（框架只依赖结构类型）
      client: prismaClient,
      provider: PROVIDER_MAP[env.DB_DRIVER],
      slowQueryThresholdMs: env.DB_SLOW_MS,
      readinessProbe: dbReadinessProbe,
    }),
  ],
  controllers: [DemoController, DemoTenantItemsController],
  providers: [
    DemoItemRepository,
    { provide: TENANT_DATA_SOURCE, useValue: tenantDataSource },
  ],
  exports: [DemoItemRepository],
})
export class DemoModule {}
