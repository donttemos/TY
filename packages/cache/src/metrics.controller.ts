/*
 * @file /metrics 指标端点
 * @description 渲染缓存命中率、平均耗时、错误数、降级数等指标为 Prometheus 文本格式（PRD-004 FR-10 / AC-008）。
 *   `/metrics` 已在统一响应拦截器与鉴权守卫的免包装/免认证名单内（C-05 DEFAULT_PUBLIC_PATHS）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { Controller, Get, Inject, Res } from '@nestjs/common';
import { CACHE_SERVICE } from './tokens.js';
import { CacheMetrics } from './metrics.js';
import type { CacheService } from './cache.service.js';
import { getGlobalRateLimiter } from './rate-limit.js';

/** 指标暴露路径（免认证、免统一响应包装） */
export const CACHE_METRICS_PATH = '/metrics';

/** 响应对象最小接口（避免引入 express 类型依赖） */
interface ResponseLike {
  /** 设置 Content-Type */
  type(contentType: string): void;
}

/**
 * 指标控制器：GET /metrics
 */
@Controller()
export class CacheMetricsController {
  constructor(@Inject(CACHE_SERVICE) private readonly cache: CacheService) {}

  /**
   * 输出 Prometheus 文本格式指标
   * @param res 响应对象（设置 text/plain）
   */
  @Get(CACHE_METRICS_PATH)
  render(@Res({ passthrough: true }) res: ResponseLike): string {
    res.type('text/plain; version=0.0.4; charset=utf-8');
    return CacheMetrics.render(this.cache.metricsSnapshot(), getGlobalRateLimiter()?.snapshot());
  }
}
