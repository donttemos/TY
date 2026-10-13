/*
 * @file @fw/db 公共出口
 * @description 数据库抽象层：Repository 契约、Prisma 实现、DbModule、慢查询观测（PRD-002）、
 *   租户数据源路由（M8 T-M8-02，PRD-008 FR-02）
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-14 donttemo M8 T-M8-02 导出 TenantDataSource（dedicated 独立库路由）
 * @module @fw/db
 */

export type {
  BaseEntity,
  CursorQuery,
  FieldFilter,
  FilterOp,
  ID,
  IsolationLevel,
  PageQuery,
  PageResult,
  Projection,
  Repository,
  Sort,
  SortDir,
  Tx,
  Where,
} from './repository.interface.js';
export { PrismaRepository } from './prisma-repository.js';
export type { PrismaRepositoryOptions } from './prisma-repository.js';
export { DbModule, DB_CLIENT, TENANT_DATA_SOURCE, type DbModuleOptions, type DbReadinessProbe } from './db.module.js';
export { TenantDataSource, type TenantDataSourceOptions, type TenantDataSourceStats } from './tenant-datasource.js';
export {
  DEFAULT_SLOW_QUERY_MS,
  createDbReadinessProbe,
  withSlowQueryLog,
  type PoolStats,
  type SlowQueryHook,
  type SlowQueryInfo,
} from './observability.js';
export type { ModelDelegate, PrismaClientLike, TxClient } from './types.js';
