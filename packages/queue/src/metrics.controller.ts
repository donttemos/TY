/*
 * @file /metrics/queue 指标端点
 * @description 渲染入队/成功/失败/死信/幂等跳过/超时/cron 触发与失败次数、成功率与平均耗时，
 *   以及队列积压（waiting / active / deadLetter）等实时 gauge（PRD-007 FR-09）。
 *   路径 `/metrics/queue`：命中 C-05 `DEFAULT_PUBLIC_PATHS` 的 `/metrics` 前缀（免认证），
 *   同时命中统一响应拦截器的原始格式豁免（不包信封）；与 @fw/cache 的 `/metrics` 并存不冲突。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { Controller, Get, Inject, Res } from '@nestjs/common';
import { QueueMetrics } from './metrics.js';
import { QUEUE_SERVICE } from './tokens.js';
import type { QueueService } from './queue.service.js';

/** 指标暴露路径（免认证、免统一响应包装） */
export const QUEUE_METRICS_PATH = '/metrics/queue';

/** 响应对象最小接口（避免引入 express 类型依赖） */
interface ResponseLike {
  /** 设置 Content-Type */
  type(contentType: string): void;
}

/**
 * 指标控制器：GET /metrics/queue
 */
@Controller()
export class QueueMetricsController {
  constructor(@Inject(QUEUE_SERVICE) private readonly queue: QueueService) {}

  /**
   * 输出 Prometheus 文本格式指标（含积压 gauge）
   * @param res 响应对象（设置 text/plain）
   */
  @Get(QUEUE_METRICS_PATH)
  async render(@Res({ passthrough: true }) res: ResponseLike): Promise<string> {
    res.type('text/plain; version=0.0.4; charset=utf-8');
    const stats = await this.queue.stats();
    return QueueMetrics.render(this.queue.metricsSnapshot(), stats);
  }
}
