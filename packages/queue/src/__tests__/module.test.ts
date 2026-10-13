/*
 * @file 单测：队列模块装配与环境配置解析
 * @description 覆盖 buildQueueOptions（默认值、MQ_URL→CACHE_URL 回退、前缀缺省、退避解析、
 *   秒→毫秒换算、覆盖优先级）、createQueueReadinessProbe（装配前后就绪判定）、
 *   forRoot 的 provider/controller 装配与不支持驱动的报错，以及 QueueLifecycle 的启动/停机编排。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { JobHandler } from '../decorators.js';
import { MemoryGuardStore } from '../guard-store.js';
import { QueueMetrics } from '../metrics.js';
import { buildQueueOptions, createQueueReadinessProbe, QueueLifecycle, QueueModule, type QueueEnvLike } from '../queue.module.js';
import { QueueAdminController } from '../admin.controller.js';
import { QueueMetricsController } from '../metrics.controller.js';
import { QueueService } from '../queue.service.js';
import { CronScheduler } from '../scheduler.js';
import { QUEUE_DRIVER, QUEUE_GUARD, QUEUE_SCHEDULER, QUEUE_SERVICE } from '../tokens.js';
import type { MetadataScannerLike, ProviderLike } from '../discovery.js';
import { createQueueFixture, type QueueFixture } from './test-helpers.js';

describe('buildQueueOptions', () => {
  it('空环境下取全量默认值', () => {
    const opts = buildQueueOptions({});
    expect(opts.driver).toBe('memory');
    expect(opts.concurrency).toBe(10);
    expect(opts.maxAttempts).toBe(4);
    expect(opts.backoff).toEqual([1000, 5000, 30000]);
    expect(opts.jobTimeoutMs).toBe(60_000);
    expect(opts.cronEnabled).toBe(true);
    expect(opts.rateLimit).toBe(0);
    expect(opts.deadLetterMax).toBe(1000);
    expect(opts.shutdownTimeoutMs).toBe(30_000);
    expect(opts.stalledIntervalMs).toBe(30_000);
  });

  it('bullmq 缺 MQ_URL 时回退 CACHE_URL；前缀缺省为 fw:<APP_ENV>', () => {
    const env: QueueEnvLike = { MQ_DRIVER: 'bullmq', CACHE_URL: 'redis://127.0.0.1:6379/0', APP_ENV: 'prod' };
    const opts = buildQueueOptions(env);
    expect(opts.driver).toBe('bullmq');
    expect(opts.url).toBe('redis://127.0.0.1:6379/0');
    expect(opts.prefix).toBe('fw:prod');
  });

  it('显式 MQ_URL / MQ_PREFIX 优先于回退；秒配置换算为毫秒', () => {
    const env: QueueEnvLike = {
      MQ_URL: 'redis://mq:6380/1',
      CACHE_URL: 'redis://cache:6379/0',
      MQ_PREFIX: 'myapp',
      MQ_JOB_TIMEOUT: 15,
      MQ_SHUTDOWN_TIMEOUT: 5,
      MQ_BACKOFF: '200,800',
      MQ_CONCURRENCY: 3,
      MQ_CRON_ENABLED: false,
      MQ_RATE_LIMIT: 50,
      MQ_STALLED_MS: 2500,
    };
    const opts = buildQueueOptions(env);
    expect(opts.url).toBe('redis://mq:6380/1');
    expect(opts.prefix).toBe('myapp');
    expect(opts.jobTimeoutMs).toBe(15_000);
    expect(opts.shutdownTimeoutMs).toBe(5_000);
    expect(opts.backoff).toEqual([200, 800]);
    expect(opts.concurrency).toBe(3);
    expect(opts.cronEnabled).toBe(false);
    expect(opts.rateLimit).toBe(50);
    expect(opts.stalledIntervalMs).toBe(2_500);
  });

  it('overrides 优先级最高', () => {
    const opts = buildQueueOptions({ MQ_CONCURRENCY: 3, MQ_DRIVER: 'bullmq' }, { concurrency: 7, driver: 'memory' });
    expect(opts.concurrency).toBe(7);
    expect(opts.driver).toBe('memory');
  });
});

describe('createQueueReadinessProbe', () => {
  it('装配前未就绪，绑定队列服务后按 ping 判定', async () => {
    const probe = createQueueReadinessProbe();
    expect(probe.name).toBe('queue');
    expect(await probe.check()).toBe(false);

    let fx: QueueFixture | undefined = createQueueFixture();
    probe.markReady(fx.queue);
    expect(await probe.check()).toBe(true);
    await fx.stop();
    fx = undefined;
  });
});

describe('QueueModule.forRoot', () => {
  it('默认装配指标与管理端点，导入 DiscoveryModule', () => {
    const mod = QueueModule.forRoot({ env: {}, disableDiscovery: false });
    expect(mod.module).toBe(QueueModule);
    expect(mod.global).toBe(true);
    expect(mod.imports!.length).toBe(1);
    expect(mod.controllers).toContain(QueueMetricsController);
    expect(mod.controllers).toContain(QueueAdminController);
    expect(mod.exports).toContain(QueueService);
    expect(mod.exports).toContain(QUEUE_SCHEDULER);
  });

  it('可关闭端点暴露与自动扫描', () => {
    const mod = QueueModule.forRoot({ env: {}, exposeMetrics: false, exposeAdmin: false, disableDiscovery: true });
    expect(mod.controllers).toEqual([]);
    expect(mod.imports).toEqual([]);
  });

  it('memory 驱动工厂创建 MemoryQueueDriver；不支持的驱动直接报错', () => {
    const mod = QueueModule.forRoot({ env: {}, disableDiscovery: true });
    const driverProvider = (mod.providers as Array<{ provide: unknown; useFactory?: (...a: never[]) => unknown }>).find(
      (p) => p.provide === QUEUE_DRIVER,
    )!;
    const guard = new MemoryGuardStore();
    const driver = driverProvider.useFactory!(guard as never) as { kind: string };
    expect(driver.kind).toBe('memory');

    const bad = QueueModule.forRoot({ env: { MQ_DRIVER: 'kafka' }, disableDiscovery: true });
    const badFactory = (bad.providers as Array<{ provide: unknown; useFactory?: (...a: never[]) => unknown }>).find(
      (p) => p.provide === QUEUE_DRIVER,
    )!.useFactory!;
    expect(() => badFactory(guard as never)).toThrow(/kafka/);
  });

  it('导出可注入的队列服务与守卫', () => {
    const mod = QueueModule.forRoot({ env: {}, disableDiscovery: true });
    const tokens = (mod.providers as Array<{ provide: unknown }>).map((p) => p.provide);
    expect(tokens).toContain(QUEUE_SERVICE);
    expect(tokens).toContain(QUEUE_GUARD);
  });
});

@JobHandler('module.demo')
class DemoJob {
  public calls = 0;

  async handle(): Promise<void> {
    this.calls++;
  }
}

/** 生命周期用的 DiscoveryService 桩 */
function makeDiscovery(instances: object[]): { getProviders: () => ProviderLike[] } {
  return { getProviders: (): ProviderLike[] => instances.map((instance) => ({ instance })) };
}

/** 生命周期用的 MetadataScanner 桩：列出原型函数成员 */
function makeScanner(): MetadataScannerLike {
  return {
    getAllMethodNames(prototype: object): string[] {
      return Object.getOwnPropertyNames(prototype).filter(
        (name) => name !== 'constructor' && typeof (prototype as Record<string, unknown>)[name] === 'function',
      );
    },
  };
}

describe('QueueLifecycle', () => {
  it('启动时注册扫描到的处理器并开始消费，停机时停调度再关队列', async () => {
    const fx = createQueueFixture();
    const scheduler = new CronScheduler({ guard: fx.guard, metrics: fx.metrics, enabled: true, defaultTimeoutMs: 1000 });
    const demo = new DemoJob();
    const lifecycle = new QueueLifecycle(
      fx.queue,
      scheduler,
      fx.runtime,
      fx.guard,
      makeDiscovery([demo]) as never,
      makeScanner() as never,
    );

    await lifecycle.onApplicationBootstrap();
    expect(fx.queue.registeredNames()).toContain('module.demo');

    await fx.queue.dispatch('module.demo', {});
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(demo.calls).toBe(1);

    await lifecycle.onApplicationShutdown();
  });

  it('无 DiscoveryService 时不做扫描也能正常启动', async () => {
    const fx = createQueueFixture();
    const scheduler = new CronScheduler({ guard: fx.guard, metrics: fx.metrics, enabled: true, defaultTimeoutMs: 1000 });
    const lifecycle = new QueueLifecycle(fx.queue, scheduler, fx.runtime, fx.guard);
    await lifecycle.onApplicationBootstrap();
    expect(fx.queue.registeredNames()).toEqual([]);
    await lifecycle.onApplicationShutdown();
  });
});

describe('QueueMetrics（装配复用）', () => {
  it('forRoot 传入的指标实例被复用（同一对象）', () => {
    const metrics = new QueueMetrics();
    const mod = QueueModule.forRoot({ env: {}, metrics, disableDiscovery: true });
    const metricsProvider = (mod.providers as Array<{ provide: unknown; useValue?: unknown }>).find(
      (p) => p.useValue === metrics,
    );
    expect(metricsProvider).toBeDefined();
  });
});
