/*
 * @file DbModule：数据库连接与 Repository 注册
 * @description forRoot 接收业务项目生成的 PrismaClient，包装慢查询观测后注入容器。
 *   就绪探针（/ready 的 DB 项）经 options.readinessProbe 由业务模块传入
 *   FwCoreModule.forRoot({ readinessProbes: [...] })——Nest 10 的 ValueProvider 不支持 multi，
 *   探针集合由 @fw/core 单值管理（TC-ORM-006）。
 *   框架不感知具体 schema：模型委托由各项目的 Repository 子类按 modelName 绑定。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { Global, Module, type DynamicModule } from '@nestjs/common';
import { withSlowQueryLog, createDbReadinessProbe, DEFAULT_SLOW_QUERY_MS } from './observability.js';
import { PrismaRepository } from './prisma-repository.js';
import type { PrismaClientLike } from './types.js';

/** 数据库客户端注入令牌（供业务 Repository 子类构造时注入） */
export const DB_CLIENT = Symbol('fw.db.client');

/**
 * 租户数据源注入令牌（M8 T-M8-02）：宿主创建 TenantDataSource 后以 useValue 注入，
 * 需要 dedicated 独立库路由的 Repository 在 options.dataSource 中引用。
 */
export const TENANT_DATA_SOURCE = Symbol('fw.db.tenantDataSource');

/** 就绪探针（由 createDbReadinessProbe 创建，DbModule 负责标记连接状态） */
export interface DbReadinessProbe {
  name: string;
  check: () => Promise<boolean>;
  markConnected(): void;
  stats(): { provider: string; connected: boolean; slowQueryThresholdMs: number };
}

/** forRoot 入参 */
export interface DbModuleOptions {
  /** 业务项目用自身 schema 生成的 PrismaClient 实例（已配置 datasource） */
  client: PrismaClientLike;
  /** 驱动名：决定方言分支（upsert/jsonContains）与探针展示 */
  provider: 'sqlite' | 'mysql' | 'postgresql';
  /** 慢查询阈值（ms），默认 500 */
  slowQueryThresholdMs?: number;
  /** 就绪探针实例：业务侧同一实例传入 FwCoreModule.forRoot，DbModule 负责 markConnected */
  readinessProbe?: DbReadinessProbe;
}

@Global()
@Module({})
export class DbModule {
  /**
   * 注册数据库客户端（全局单例）
   * @param options 客户端 + 驱动 + 观测配置
   */
  static forRoot(options: DbModuleOptions): DynamicModule {
    const thresholdMs = options.slowQueryThresholdMs ?? DEFAULT_SLOW_QUERY_MS;
    // 慢查询包装：注入容器的是插桩版 client，业务 Repository 拿到的即带观测
    const instrumented = withSlowQueryLog(options.client, thresholdMs);
    // Prisma 懒连接：主动连一次并标记就绪状态
    void options.client.$connect().then(
      () => options.readinessProbe?.markConnected(),
      () => undefined, // 连接失败不在此处崩溃：/ready 会持续返回 503，启动入口的迁移检查负责报错
    );

    return {
      module: DbModule,
      global: true,
      providers: [{ provide: DB_CLIENT, useValue: instrumented }],
      exports: [DB_CLIENT],
    };
  }

  /**
   * 创建 DB 就绪探针（与 forRoot 配套：把返回值传给 FwCoreModule.forRoot({ readinessProbes })）
   * @param provider 驱动名
   * @param slowQueryThresholdMs 慢查询阈值
   */
  static readinessProbe(
    provider: 'sqlite' | 'mysql' | 'postgresql',
    slowQueryThresholdMs: number = DEFAULT_SLOW_QUERY_MS,
  ): DbReadinessProbe {
    return createDbReadinessProbe(provider, slowQueryThresholdMs);
  }
}

/**
 * 业务 Repository 基类（便捷导出）
 * 用法：
 * ```ts
 * export class UserRepository extends PrismaRepository<User> {
 *   constructor(@Inject(DB_CLIENT) client: PrismaClientLike) { super(client, 'user'); }
 * }
 * ```
 */
export { PrismaRepository };