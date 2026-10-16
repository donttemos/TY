/*
 * @file 前端错误上报服务（M10/E-17）
 * @description RUM（admin-web 实时用户监控）的服务端接收面：逐条以 error 级结构化日志落盘
 *   （对齐「错误全采」理念——前端异常与后端异常同一管道可检索），并按 source 维度内存计数，
 *   作为被动观测面随摄取响应回带（不新增查询端点与权限码）。
 *   设计纪律（PRD-010 E-17）：
 *   ① 观测旁路——本服务只读日志与计数，不写业务库、不抛业务异常（摄取失败由控制器统一 400/500）；
 *   ② 单批上限与前端 RUM_MAX_BATCH 对齐（10 条），体积上限防御恶意大包；
 *   ③ 多实例语义：计数是进程内视图（与 cache /metrics 同口径），跨实例合计需日志侧聚合。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/client-errors
 */

import { Logger } from '@fw/logger';

/** 单批最多接收条数（与前端 rum.ts 的 RUM_MAX_BATCH 对齐） */
export const CLIENT_ERROR_MAX_BATCH = 10;

/** 错误来源（与前端 rum.ts 的 RumSource 同集合） */
export const CLIENT_ERROR_SOURCES = ['error', 'rejection', 'vue', 'resource'] as const;

/** 单条前端错误上报（与前端 rum.ts 的 ClientErrorReport 同构） */
export interface ClientErrorReport {
  /** 来源：window 未捕获 / 未处理拒绝 / Vue / 资源加载 */
  source: (typeof CLIENT_ERROR_SOURCES)[number];
  /** 错误消息（已截断） */
  message: string;
  /** 堆栈（已截断；无堆栈为 null） */
  stack: string | null;
  /** 资源 URL（资源加载失败时；其余为 null） */
  resource: string | null;
  /** 发生页面（pathname + search） */
  page: string;
  /** 完整 URL */
  url: string;
  /** 最近一次后端 traceId（无则 null）——与后端日志同链关联 */
  traceId: string | null;
  /** 同签名第几次上报（1 起） */
  repeat: number;
  /** 采集时间（ISO 8601） */
  at: string;
}

/** 批量上报信封（与前端 rum.ts 的 ClientErrorBatch 同构） */
export interface ClientErrorBatch {
  /** 应用标识（采集端按应用分流） */
  app: string;
  /** 本条数 */
  reports: ClientErrorReport[];
}

/** 摄取结果：received = 本批接收条数；total = 本实例累计接收条数（观测面回带） */
export interface ClientErrorsResult {
  received: number;
  total: number;
}

/** 计数快照（stats 内部视图，暂无 HTTP 暴露面） */
export interface ClientErrorsStats {
  total: number;
  bySource: Record<string, number>;
}

/**
 * 前端错误上报服务
 *
 * 单例（进程内计数）。ingest 是唯一入口：控制器完成入参校验后调用，
 * 服务内不再抛业务异常——日志与计数失败也仅静默降级（观测旁路不得反噬业务）。
 */
export class ClientErrorsService {
  private readonly logger = Logger.for('rum');

  /** source → 累计条数（进程内） */
  private readonly bySource = new Map<string, number>();

  /** 累计接收条数（进程内） */
  private totalCount = 0;

  /**
   * 接收一批前端错误：逐条 error 级结构化日志 + 计数
   * @param batch 已通过控制器校验的上报信封
   * @returns 接收条数与累计计数
   */
  ingest(batch: ClientErrorBatch): ClientErrorsResult {
    for (const report of batch.reports) {
      // error 级逐条落盘：msg 固定人话，上下文字段化（可按 source / page / traceId 检索）
      this.logger.error('前端错误上报', {
        app: batch.app,
        source: report.source,
        message: report.message,
        stack: report.stack,
        resource: report.resource,
        page: report.page,
        url: report.url,
        traceId: report.traceId,
        repeat: report.repeat,
        at: report.at,
      });
      this.bySource.set(report.source, (this.bySource.get(report.source) ?? 0) + 1);
      this.totalCount += 1;
    }
    return { received: batch.reports.length, total: this.totalCount };
  }

  /**
   * 计数快照（进程内视图；多实例合计需日志侧聚合）
   * @returns 累计条数与按来源分布
   */
  stats(): ClientErrorsStats {
    return {
      total: this.totalCount,
      bySource: Object.fromEntries(this.bySource),
    };
  }
}
