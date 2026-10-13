/*
 * @file 缓存层异常
 * @description 缓存不可用（fail-closed 时抛出，映射错误码 9002 / HTTP 503）与非法键异常；
 *   统一继承 @fw/core 的 BizError，保证经全局异常过滤器输出结构一致的响应体。
 *   说明：大 key 超限**不抛异常**——缓存永不让业务失败，只拒绝写入 + 告警 + 指标计数（TC-CACHE-010）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { BizError, ErrorCode } from '@fw/core';

/**
 * 缓存依赖不可用：`CACHE_FAIL_OPEN=false` 时读/写/锁失败抛出（HTTP 503 / 业务码 9002）
 */
export class CacheUnavailableError extends BizError {
  /**
   * @param message 覆盖默认文案
   * @param cause 底层异常（仅记录，不对外暴露）
   */
  constructor(message = '缓存依赖不可用', cause?: unknown) {
    super(ErrorCode.DEPENDENCY_UNAVAILABLE, message);
    this.name = 'CacheUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 非法缓存键（含空串、非法字符或超长） */
export class CacheKeyError extends BizError {
  /**
   * @param key 非法键
   * @param reason 具体原因
   */
  constructor(key: string, reason: string) {
    super(ErrorCode.BAD_REQUEST, `非法缓存键（${reason}）：${key}`);
    this.name = 'CacheKeyError';
  }
}
