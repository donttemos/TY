/*
 * @file 单测：装饰器元数据读写
 * @description 覆盖 @JobHandler / @Cron / @Idempotent 三类元数据的写入与读取口径：
 *   类上标注、方法上标注、幂等「先方法后类」的优先级，以及未标注时的 undefined。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { Cron, Idempotent, JobHandler, readCronMeta, readIdempotentMeta, readJobHandlerName } from '../decorators.js';

@JobHandler('order.timeout')
@Idempotent({ ttlSeconds: 120 })
class OrderTimeoutJob {
  async handle(): Promise<void> {
    /* noop */
  }

  @Cron('0 2 * * *', { name: 'order.settle', lock: true })
  async settle(): Promise<void> {
    /* noop */
  }
}

describe('decorators', () => {
  it('@JobHandler 写入类元数据，可按构造器读取', () => {
    expect(readJobHandlerName(OrderTimeoutJob)).toBe('order.timeout');
  });

  it('未标注的类读不出任务名', () => {
    class Plain {}
    expect(readJobHandlerName(Plain)).toBeUndefined();
  });

  it('@Cron 写入方法元数据，含表达式与选项', () => {
    const method = OrderTimeoutJob.prototype.settle;
    const meta = readCronMeta(method);
    expect(meta).toBeDefined();
    expect(meta!.expression).toBe('0 2 * * *');
    expect(meta!.options).toMatchObject({ name: 'order.settle', lock: true });
  });

  it('未标注的普通方法读不出 cron 元数据', () => {
    expect(readCronMeta(OrderTimeoutJob.prototype.handle)).toBeUndefined();
  });

  it('@Idempotent 类级元数据可读，且默认 ttlSeconds 可选', () => {
    const meta = readIdempotentMeta(undefined, OrderTimeoutJob);
    expect(meta).toBeDefined();
    expect(meta!.ttlSeconds).toBe(120);

    class Plain {}
    expect(readIdempotentMeta(undefined, Plain)).toBeUndefined();
  });

  it('方法级幂等元数据优先于类级', () => {
    @Idempotent({ ttlSeconds: 60 })
    class Mixed {
      @Idempotent({ ttlSeconds: 30 })
      async handle(): Promise<void> {
        /* noop */
      }
    }
    const methodMeta = readIdempotentMeta(Mixed.prototype.handle, Mixed);
    expect(methodMeta!.ttlSeconds).toBe(30);
    // 未传方法时回落到类级
    expect(readIdempotentMeta(undefined, Mixed)!.ttlSeconds).toBe(60);
  });

  it('@Idempotent 可携带自定义 key 推导函数', () => {
    const keyFn = (payload: unknown): string => `k:${String(payload)}`;
    @Idempotent({ key: keyFn as (payload: never) => string })
    class WithKey {}
    const meta = readIdempotentMeta(undefined, WithKey);
    expect(meta!.key).toBe(keyFn);
  });
});
