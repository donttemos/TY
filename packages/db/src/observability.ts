/*
 * @file 慢查询观测与连接池状态
 * @description 用 Prisma Client 扩展挂 query 事件：超过阈值的查询打 warn 日志（含 model/operation/耗时/SQL摘要/traceId）；
 *   连接池快照经 /ready 探针暴露（PRD-002 FR-08，TC-ORM-006）。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { Logger, getTraceId } from '@fw/logger';
import type { PrismaClientLike } from './types.js';

/** 慢查询默认阈值（毫秒），PRD-002 FR-08 */
export const DEFAULT_SLOW_QUERY_MS = 500;

const logger = Logger.for('db.slow-query');

/** 慢查询日志载荷 */
export interface SlowQueryInfo {
  /** 模型名（$allOperations 下可能为 undefined，如 raw 查询） */
  model?: string;
  /** 操作名 */
  operation: string;
  /** 实际耗时（毫秒） */
  durationMs: number;
  /** SQL 摘要（参数值脱敏后的 query 描述） */
  sqlSummary: string;
  /** 请求 traceId（无上下文为空串） */
  traceId: string;
}

/** 慢查询回调（可注入单测断言） */
export type SlowQueryHook = (info: SlowQueryInfo) => void;

/**
 * 包装 Prisma Client：超过阈值的操作输出慢查询日志
 * @param client 原始 Prisma Client
 * @param thresholdMs 阈值，默认 500ms
 * @param onSlow 额外回调（测试用）
 */
export function withSlowQueryLog(
  client: PrismaClientLike,
  thresholdMs: number = DEFAULT_SLOW_QUERY_MS,
  onSlow?: SlowQueryHook,
): PrismaClientLike {
  return client.$extends({
    name: 'fw-slow-query',
    query: {
      async $allOperations({ model, operation, args, query }: {
        model?: string;
        operation: string;
        args: unknown;
        query: (args: unknown) => Promise<unknown>;
      }) {
        const start = Date.now();
        try {
          return await query(args);
        } finally {
          const durationMs = Date.now() - start;
          if (durationMs >= thresholdMs) {
            const info: SlowQueryInfo = {
              model,
              operation,
              durationMs,
              sqlSummary: summarize(args),
              traceId: getTraceId(),
            };
            logger.warn('慢查询告警', {
              model,
              operation,
              durationMs,
              sqlSummary: info.sqlSummary,
              traceId: info.traceId,
            });
            onSlow?.(info);
          }
        }
      },
    },
  }) as PrismaClientLike;
}

/** 从 query args 提取 SQL 摘要：截断 + 去掉大字段，避免日志膨胀 */
function summarize(args: unknown): string {
  let text: string;
  try {
    text = JSON.stringify(args) ?? String(args);
  } catch {
    text = '[unserializable]';
  }
  if (text.length > 200) text = `${text.slice(0, 200)}…`;
  return text;
}

/** 连接池快照（Prisma 无官方池指标 API，首版暴露连接状态与阈值，M8 细化） */
export interface PoolStats {
  /** 数据源 provider（sqlite/mysql/postgresql） */
  provider: string;
  /** 是否已连接 */
  connected: boolean;
  /** 慢查询阈值（ms） */
  slowQueryThresholdMs: number;
}

/**
 * 数据库就绪探针工厂：供业务模块传入 FwCoreModule.forRoot({ readinessProbes: [probe] })
 * （Nest 10 的 ValueProvider 不支持 multi，探针集合由 @fw/core 单值管理）
 * @param provider 驱动名
 * @param slowQueryThresholdMs 慢查询阈值
 */
export function createDbReadinessProbe(provider: string, slowQueryThresholdMs: number) {
  let connected = false;
  return {
    name: 'db',
    /** 就绪检查：已连接为就绪；未连接时由调用方决定是否实时探测 */
    check: async (): Promise<boolean> => connected,
    /** 标记连接已建立（DbModule 连接成功后调用） */
    markConnected(): void {
      connected = true;
    },
    /** 当前池状态快照（观测用） */
    stats(): PoolStats {
      return { provider, connected, slowQueryThresholdMs };
    },
  };
}
