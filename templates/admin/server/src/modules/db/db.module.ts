/*
 * @file 数据库模块装配（admin 模板）
 * @description 注册 DbModule.forRoot（全局 DB_CLIENT + 慢查询插桩 + 就绪探针）：
 *   应用用自身 schema 生成的强类型 PrismaClient（框架只依赖结构类型），
 *   切换数据库只改 datasource 两行 + DB_DRIVER（业务代码零改动）。
 * @author donttemo
 * @created 2026-10-15
 * @module __APP_NAME__/db
 */
import { Module } from '@nestjs/common';
import { PrismaClient } from '@prisma/client';
import { DbModule, type DbReadinessProbe, type PrismaClientLike } from '@fw/db';
import { loadEnv } from '@fw/config';

/** DB_DRIVER → Prisma provider 映射（postgres 为 postgresql 别名） */
const PROVIDER_MAP = { sqlite: 'sqlite', mysql: 'mysql', postgres: 'postgresql' } as const;

// 启动期校验配置（与 FwCoreModule 同一份 loadEnv，缺项即失败）
const env = loadEnv();

/** 数据库就绪探针实例：app.module 会把它传给 FwCoreModule.forRoot */
export const dbReadinessProbe: DbReadinessProbe = DbModule.readinessProbe(
  PROVIDER_MAP[env.DB_DRIVER as keyof typeof PROVIDER_MAP],
  env.DB_SLOW_MS,
);

/** 应用 Prisma client（由本应用 schema 生成） */
const prismaClient = new PrismaClient() as unknown as PrismaClientLike;

/**
 * 数据库装配模块
 */
@Module({
  imports: [
    DbModule.forRoot({
      client: prismaClient,
      provider: PROVIDER_MAP[env.DB_DRIVER as keyof typeof PROVIDER_MAP],
      slowQueryThresholdMs: env.DB_SLOW_MS,
      readinessProbe: dbReadinessProbe,
      // 慢查询包装由 DbModule.forRoot 内部完成（注入容器的 client 即带观测）
    }),
  ],
})
export class TemplateDbModule {}
