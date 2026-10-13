/*
 * @file 演示模块定义（M2：接入 @fw/db）
 * @description 注册 DbModule.forRoot（慢查询插桩 + 全局 client），
 *   并暴露 DemoItemRepository 供控制器使用。数据库就绪探针经 app.module 传入 FwCoreModule。
 *   切换数据库：改 .env 的 DB_DRIVER/DB_URL + fw db:migrate，本文件零改动（TC-ORM-008）。
 * @author donttemo
 * @created 2026-10-12
 * @module demo
 */
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { loadEnv } from '@fw/config';
import { DbModule, DB_CLIENT, type DbReadinessProbe, type PrismaClientLike } from '@fw/db';
import { DemoController } from './demo.controller.js';
import { DemoItemRepository } from './demo-item.repository.js';

/** 配置驱动名 → Prisma provider 名（postgres 是配置侧简称） */
const PROVIDER_MAP = { sqlite: 'sqlite', mysql: 'mysql', postgres: 'postgresql' } as const;

// 启动期校验配置（与 FwCoreModule 同一份 loadEnv，缺项即失败）
const env = loadEnv();

/** 数据库就绪探针实例：app.module 会把它传给 FwCoreModule.forRoot */
export const dbReadinessProbe: DbReadinessProbe = DbModule.readinessProbe(
  PROVIDER_MAP[env.DB_DRIVER],
  env.DB_SLOW_MS,
);

@Module({
  imports: [
    DbModule.forRoot({
      // 业务项目用自身 schema 生成的强类型 client（框架只依赖结构类型）
      client: new PrismaClient() as unknown as PrismaClientLike,
      provider: PROVIDER_MAP[env.DB_DRIVER],
      slowQueryThresholdMs: env.DB_SLOW_MS,
      readinessProbe: dbReadinessProbe,
    }),
  ],
  controllers: [DemoController],
  providers: [DemoItemRepository],
  exports: [DemoItemRepository],
})
export class DemoModule {}
