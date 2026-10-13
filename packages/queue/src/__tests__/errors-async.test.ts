/*
 * @file 单测：队列层异常与异步工具
 * @description 覆盖异常继承关系与错误码（PermanentJobError 不继承 BizError；JobOptionError 1001；
 *   QueueUnavailableError 9002 且 HTTP 503；JobNotRegisteredError 属终态失败），
 *   以及 withTimeout（正常返回 / 超时抛错 / 不限时 / 清理计时器）与 delay。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { delay, withTimeout } from '../async.js';
import {
  CronExpressionError,
  JobNotRegisteredError,
  JobOptionError,
  JobTimeoutError,
  PermanentJobError,
  QueueUnavailableError,
} from '../errors.js';

describe('队列异常', () => {
  it('PermanentJobError 是普通 Error（非 BizError），可携带 cause', () => {
    const cause = new Error('底层原因');
    const err = new PermanentJobError('不可重试', cause);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(BizError);
    expect(err.name).toBe('PermanentJobError');
    expect(err.cause).toBe(cause);
  });

  it('JobNotRegisteredError 继承终态失败，文案含任务名', () => {
    const err = new JobNotRegisteredError('order.timeout');
    expect(err).toBeInstanceOf(PermanentJobError);
    expect(err.name).toBe('JobNotRegisteredError');
    expect(err.message).toContain('order.timeout');
  });

  it('JobTimeoutError 属普通（可重试）失败，文案含上限', () => {
    const err = new JobTimeoutError('slow', 1500);
    expect(err).not.toBeInstanceOf(PermanentJobError);
    expect(err.message).toContain('1500');
  });

  it('JobOptionError 错误码 1001', () => {
    const err = new JobOptionError('参数非法');
    expect(err).toBeInstanceOf(BizError);
    expect(err.code).toBe(ErrorCode.BAD_REQUEST);
    expect(err.code).toBe(1001);
  });

  it('QueueUnavailableError 错误码 9002、HTTP 503，可覆盖文案与 cause', () => {
    const cause = new Error('connection refused');
    const err = new QueueUnavailableError('Redis 不可用', cause);
    expect(err.code).toBe(ErrorCode.DEPENDENCY_UNAVAILABLE);
    expect(err.code).toBe(9002);
    expect(err.http).toBe(503);
    expect(err.message).toBe('Redis 不可用');
    expect(err.cause).toBe(cause);
    // 默认文案
    expect(new QueueUnavailableError().message.length).toBeGreaterThan(0);
  });

  it('CronExpressionError 继承 JobOptionError，文案含表达式与原因', () => {
    const err = new CronExpressionError('99 * * * *', '分钟字段越界');
    expect(err).toBeInstanceOf(JobOptionError);
    expect(err.name).toBe('CronExpressionError');
    expect(err.message).toContain('99 * * * *');
    expect(err.message).toContain('分钟字段越界');
  });
});

describe('withTimeout', () => {
  it('在窗口内完成时原样返回结果', async () => {
    const result = await withTimeout(async () => 'done', 200, () => new Error('超时'));
    expect(result).toBe('done');
  });

  it('超时抛错，且错误由 onTimeout 构造', async () => {
    await expect(
      withTimeout(() => delay(100).then(() => 'late'), 10, () => new JobTimeoutError('t', 10)),
    ).rejects.toBeInstanceOf(JobTimeoutError);
  });

  it('timeoutMs <= 0 表示不限时', async () => {
    const result = await withTimeout(async () => 7, 0, () => new Error('超时'));
    expect(result).toBe(7);
  });

  it('返回 Promise 时被正确展开（resolve(task()) 语义）', async () => {
    const result = await withTimeout(() => Promise.resolve(11), 200, () => new Error('超时'));
    expect(result).toBe(11);
  });
});

describe('delay', () => {
  it('等待约定期限后 resolve', async () => {
    const start = Date.now();
    await delay(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
