/*
 * @file 单测：装配期扫描（@JobHandler / @Cron）
 * @description 覆盖 provider 列表中处理器与定时任务的发现规则：实例去重、未实例化跳过、
 *   未标注跳过、cron 名缺省规则（`<类名>.<方法名>`）、handler 的 this 绑定，
 *   以及扫描器只遍历原型上的函数成员。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it, vi } from 'vitest';
import { Cron, Idempotent, JobHandler } from '../decorators.js';
import { scanCrons, scanJobHandlers, type MetadataScannerLike } from '../discovery.js';

@JobHandler('order.timeout')
@Idempotent({ ttlSeconds: 300 })
class OrderTimeoutJob {
  async handle(): Promise<void> {
    /* noop */
  }
}

@JobHandler('report.export')
class ReportExportJob {
  async handle(): Promise<void> {
    /* noop */
  }
}

/** 未标注 @JobHandler 的普通服务 */
class PlainService {
  ping(): string {
    return 'pong';
  }
}

class CronHost {
  public readonly seen: string[] = [];

  @Cron('*/5 * * * *')
  async everyFiveMinutes(): Promise<void> {
    this.seen.push('every5');
  }

  @Cron('0 3 * * *', { name: 'named.cron' })
  async nightly(): Promise<void> {
    this.seen.push('nightly');
  }

  notACron(): void {
    /* noop */
  }
}

/** 最小方法扫描器桩：列出原型上的全部方法名（与 Nest MetadataScanner 语义一致） */
function makeScanner(): MetadataScannerLike {
  return {
    getAllMethodNames(prototype: object): string[] {
      return Object.getOwnPropertyNames(prototype).filter(
        (name) => name !== 'constructor' && typeof (prototype as Record<string, unknown>)[name] === 'function',
      );
    },
  };
}

describe('scanJobHandlers', () => {
  it('发现标注 @JobHandler 的实例并带出幂等元数据', () => {
    const timeout = new OrderTimeoutJob();
    const report = new ReportExportJob();
    const handlers = scanJobHandlers([{ instance: timeout }, { instance: report }, { instance: new PlainService() }]);
    expect(handlers.map((h) => h.name).sort()).toEqual(['order.timeout', 'report.export']);
    const found = handlers.find((h) => h.name === 'order.timeout');
    expect(found!.instance).toBe(timeout);
    expect(found!.idempotent!.ttlSeconds).toBe(300);
    expect(handlers.find((h) => h.name === 'report.export')!.idempotent).toBeUndefined();
  });

  it('跳过未实例化的 provider 与非对象实例', () => {
    const handlers = scanJobHandlers([{ instance: undefined }, { instance: null as unknown }, { instance: 42 }]);
    expect(handlers).toEqual([]);
  });

  it('同一实例重复出现时只记一次', () => {
    const shared = new OrderTimeoutJob();
    const handlers = scanJobHandlers([{ instance: shared }, { instance: shared }]);
    expect(handlers).toHaveLength(1);
  });
});

describe('scanCrons', () => {
  it('发现 @Cron 方法：缺省名用「类名.方法名」，显式名优先', () => {
    const host = new CronHost();
    const crons = scanCrons([{ instance: host }], makeScanner());
    expect(crons.map((c) => c.name).sort()).toEqual(['CronHost.everyFiveMinutes', 'named.cron']);
  });

  it('handler 绑定实例 this，可正常执行', async () => {
    const host = new CronHost();
    const crons = scanCrons([{ instance: host }], makeScanner());
    const target = crons.find((c) => c.name === 'named.cron')!;
    await target.handler();
    expect(host.seen).toContain('nightly');
  });

  it('未标注 cron 的方法不被扫描；未实例化 provider 跳过', () => {
    const host = new CronHost();
    const crons = scanCrons([{ instance: host }, { instance: undefined }], makeScanner());
    expect(crons.find((c) => c.name === 'CronHost.notACron')).toBeUndefined();
    expect(crons).toHaveLength(2);
  });

  it('同一实例只扫描一次，扫描器不被重复调用', () => {
    const host = new CronHost();
    const scanner = makeScanner();
    const spy = vi.spyOn(scanner, 'getAllMethodNames');
    scanCrons([{ instance: host }, { instance: host }], scanner);
    expect(spy).toHaveBeenCalledTimes(1);
  });
});
