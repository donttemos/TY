/*
 * @file @fw/db 公共出口
 * @description 数据库抽象层：Repository 契约、Prisma 实现、DbModule、慢查询观测（PRD-002）
 * @author donttemo
 * @created 2026-10-12
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
export { DbModule, DB_CLIENT, type DbModuleOptions, type DbReadinessProbe } from './db.module.js';
export {
  DEFAULT_SLOW_QUERY_MS,
  createDbReadinessProbe,
  withSlowQueryLog,
  type PoolStats,
  type SlowQueryHook,
  type SlowQueryInfo,
} from './observability.js';
export type { ModelDelegate, PrismaClientLike, TxClient } from './types.js';
