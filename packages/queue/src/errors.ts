/*
 * @file 队列层异常
 * @description 区分「可重试失败」与「终态失败」：普通异常由驱动按退避序列重试，
 *   `PermanentJobError` 直接进死信不再重试（PRD-007 FR-04 / TC-JOB-004）。
 *   统一继承 @fw/core 的 BizError，保证经全局异常过滤器输出结构一致的响应体。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { BizError, ErrorCode } from '@fw/core';

/**
 * 终态失败：任务重试无意义（参数非法、数据已删除、业务明确拒绝）
 * 处理体抛出本异常时，驱动不再重试，直接归档死信。
 */
export class PermanentJobError extends Error {
  /**
   * @param message 失败原因
   * @param cause 底层异常
   */
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'PermanentJobError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** 任务名未注册处理器（装配期问题，重试无意义） */
export class JobNotRegisteredError extends PermanentJobError {
  /**
   * @param name 任务名
   */
  constructor(name: string) {
    super(`任务未注册处理器：${name}（请用 @JobHandler('${name}') 标注实现类，或调用 queue.register）`);
    this.name = 'JobNotRegisteredError';
  }
}

/** 任务执行超时（按失败处理并记录，进入重试链路） */
export class JobTimeoutError extends Error {
  /**
   * @param name 任务名
   * @param timeoutMs 超时上限（毫秒）
   */
  constructor(name: string, timeoutMs: number) {
    super(`任务执行超时（${name}，上限 ${timeoutMs}ms）`);
    this.name = 'JobTimeoutError';
  }
}

/** 任务选项非法（延时串格式、负并发等），错误码 1001 */
export class JobOptionError extends BizError {
  /**
   * @param message 具体原因
   */
  constructor(message: string) {
    super(ErrorCode.BAD_REQUEST, message);
    this.name = 'JobOptionError';
  }
}

/** 队列依赖不可用（bullmq 连接失败等），错误码 9002 / HTTP 503 */
export class QueueUnavailableError extends BizError {
  /**
   * @param message 覆盖默认文案
   * @param cause 底层异常
   */
  constructor(message = '队列依赖不可用', cause?: unknown) {
    super(ErrorCode.DEPENDENCY_UNAVAILABLE, message);
    this.name = 'QueueUnavailableError';
    if (cause !== undefined) this.cause = cause;
  }
}

/** cron 表达式非法（装配期即失败，错误码 1001） */
export class CronExpressionError extends JobOptionError {
  /**
   * @param expression 非法表达式
   * @param reason 具体原因
   */
  constructor(expression: string, reason: string) {
    super(`非法 cron 表达式（${reason}）：${expression}`);
    this.name = 'CronExpressionError';
  }
}
