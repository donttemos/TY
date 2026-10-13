/*
 * @file 审计日志服务与脱敏
 * @description PRD-003 FR-08 / NFR：记录操作人、时间、IP、模块、动作、变更前后值（敏感字段脱敏）。
 *   落盘为「异步 + 本地兜底」：writeAuditLog 失败只告警不抛错，绝不阻塞业务主流程；
 *   日志与审计统一取 @fw/logger 的 traceId，便于与结构化日志串联排障。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

import { Logger, getRequestContext, getTraceId } from '@fw/logger';
import type { AuthStore } from './auth-store.js';
import { MASKED, SENSITIVE_FIELDS } from './constants.js';
import type { AuditAction, AuditLogRecord, AuditQuery, ID } from './types.js';
import type { PageResult } from '@fw/db';

const logger = Logger.for('auth.audit');

/** 脱敏递归深度上限（防深层对象膨胀） */
const MAX_DEPTH = 6;

/** 敏感字段名集合（大小写不敏感匹配） */
const SENSITIVE = new Set<string>(SENSITIVE_FIELDS.map((f) => f.toLowerCase()));

/** 审计记录入参 */
export interface AuditEntry {
  /** 操作人；缺省时自动取请求上下文 userId */
  userId?: ID | null;
  /** 模块名 */
  module: string;
  /** 动作 */
  action: AuditAction;
  /** 对象类型 */
  targetType?: string | null;
  /** 对象 ID */
  targetId?: string | null;
  /** 变更前（未脱敏，落盘前统一处理） */
  before?: unknown;
  /** 变更后 */
  after?: unknown;
  /** 来源 IP；缺省由调用方（拦截器）注入 */
  ip?: string | null;
  /** 客户端标识 */
  userAgent?: string | null;
}

/**
 * 审计数据脱敏：按字段名遮蔽敏感值，Date → ISO 串，保证可 JSON 序列化
 * @param value 任意待落盘值
 * @param depth 当前递归深度（内部使用）
 * @returns 脱敏后的可序列化值
 */
export function sanitizeForAudit(value: unknown, depth = 0): unknown {
  if (value === null || value === undefined) return value;
  if (depth > MAX_DEPTH) return '[too-deep]';
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeForAudit(item, depth + 1));
  if (typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
      out[key] = SENSITIVE.has(key.toLowerCase()) ? MASKED : sanitizeForAudit(val, depth + 1);
    }
    return out;
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function') return '[function]';
  return value;
}

/**
 * 审计日志服务
 */
export class AuditService {
  /**
   * @param store 鉴权存储（审计表读写）
   */
  constructor(private readonly store: AuthStore) {}

  /**
   * 异步记录一条审计日志（不阻塞、不抛错）
   * @param entry 审计内容
   */
  record(entry: AuditEntry): void {
    void this.persist(entry).catch((error: unknown) => {
      // 本地兜底：落盘失败时把关键字段写进结构化日志，至少可人工追溯
      logger.error('审计日志落盘失败，已降级为日志兜底', {
        module: entry.module,
        action: entry.action,
        targetType: entry.targetType ?? null,
        targetId: entry.targetId ?? null,
        userId: entry.userId ?? getRequestContext()?.userId ?? null,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /**
   * 同步等待落盘（用于测试与强一致场景）
   * @param entry 审计内容
   */
  async recordSync(entry: AuditEntry): Promise<void> {
    await this.persist(entry);
  }

  /**
   * 审计日志分页查询（按人 / 对象 / 时间）
   * @param query 查询条件
   */
  async page(query: AuditQuery): Promise<PageResult<AuditLogRecord>> {
    return this.store.pageAuditLogs(query);
  }

  /** 组装并写入记录 */
  private async persist(entry: AuditEntry): Promise<void> {
    await this.store.writeAuditLog({
      userId: entry.userId ?? getRequestContext()?.userId ?? null,
      module: entry.module,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      beforeValue: entry.before === undefined ? null : sanitizeForAudit(entry.before),
      afterValue: entry.after === undefined ? null : sanitizeForAudit(entry.after),
      ip: entry.ip ?? null,
      userAgent: entry.userAgent ?? null,
      traceId: getTraceId() || null,
      createdAt: new Date(),
    });
  }
}
