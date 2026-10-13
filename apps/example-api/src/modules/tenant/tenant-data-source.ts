/*
 * @file 租户数据源装配（M8 T-M8-02，PRD-008 FR-02）
 * @description 把 @fw/db 的 TenantDataSource 落到 example-api：默认 client 即 DbModule
 *   注入的共享库 client；dedicated 租户按解密后的连接串懒创建独立库 client
 *   （同一 schema 的独立物理库），并包一层慢查询插桩保持观测一致。
 *   连接串来自 tenants.db_url_enc 的解密结果（见 db-url-crypto.ts），只经请求上下文传递。
 * @author donttemo
 * @created 2026-10-14
 * @module example-api/tenant
 */

import { PrismaClient } from '@prisma/client';
import { TenantDataSource, withSlowQueryLog, type PrismaClientLike } from '@fw/db';

/**
 * 创建租户数据源。
 *
 * 连接串语义与主库 DB_URL 一致：sqlite 相对路径（file:./xxx.db）按 prisma/schema.prisma
 * 所在目录解析（Prisma 官方行为），因此种子里的 `file:./tenant-dedicated.db` 与
 * 冒烟脚本 db push 的目标文件是同一个库；mysql/postgres 连接串原样透传。
 *
 * @param defaultClient 共享库 client（DbModule.forRoot 传入的同一实例）
 * @param slowQueryThresholdMs 慢查询阈值（与主库一致，租户库共用）
 */
export function createTenantDataSource(
  defaultClient: PrismaClientLike,
  slowQueryThresholdMs: number,
): TenantDataSource {
  return new TenantDataSource(defaultClient, {
    clientFactory: (dbUrl: string) =>
      withSlowQueryLog(
        // 独立库与主库同 schema：仅数据源不同，业务代码零差异（TC-ORM-008 的同构延伸）
        new PrismaClient({ datasources: { db: { url: dbUrl } } }) as unknown as PrismaClientLike,
        slowQueryThresholdMs,
      ),
  });
}
