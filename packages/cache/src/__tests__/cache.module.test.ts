/*
 * @file CacheModule 装配单测（真实 Nest 容器）
 * @description 用 Test.createTestingModule().compile() 做**真实装配**（M3 教训：仅手动 new 会漏掉
 *   DI 元数据/异步工厂问题），验证：memory 驱动装配、CacheService 与 CACHE_SERVICE 同实例、
 *   配置映射（前缀自动补全）、/metrics 控制器注册、就绪探针绑定、全局 @Cacheable 兜底实例、
 *   自定义 store 注入与 redis 缺连接串时的装配失败。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { CacheModule, buildCacheOptions, createCacheReadinessProbe } from '../cache.module.js';
import { CacheService } from '../cache.service.js';
import { resolveCacheService } from '../cacheable.decorator.js';
import { CacheMetrics } from '../metrics.js';
import { CacheMetricsController } from '../metrics.controller.js';
import { CACHE_METRICS, CACHE_OPTIONS, CACHE_SERVICE } from '../tokens.js';
import { FaultyStore } from './test-helpers.js';

describe('@fw/cache · buildCacheOptions', () => {
  it('缺省值与前缀自动补全（含 APP_ENV 兜底 default）', () => {
    const options = buildCacheOptions({});
    expect(options.driver).toBe('memory');
    expect(options.prefix).toBe('fw:default');
    expect(options.defaultTtlSeconds).toBe(300);
    expect(options.failOpen).toBe(true);
    expect(options.nullTtlSeconds).toBe(60);
    expect(options.maxItems).toBe(10000);
    expect(options.maxValueBytes).toBe(1048576);
  });

  it('环境变量与覆盖项优先级：overrides > env > 默认值', () => {
    const options = buildCacheOptions(
      { APP_ENV: 'prod', CACHE_DRIVER: 'redis', CACHE_URL: 'redis://127.0.0.1:6379', CACHE_PREFIX: 'myapp:prod', CACHE_TTL: 60, CACHE_FAIL_OPEN: false },
      { defaultTtlSeconds: 15, failOpen: true },
    );
    expect(options.driver).toBe('redis');
    expect(options.url).toBe('redis://127.0.0.1:6379');
    expect(options.prefix).toBe('myapp:prod');
    expect(options.defaultTtlSeconds).toBe(15);
    expect(options.failOpen).toBe(true);
  });

  it('前缀为空串时回落到 fw:<APP_ENV>', () => {
    expect(buildCacheOptions({ APP_ENV: 'test', CACHE_PREFIX: '' }).prefix).toBe('fw:test');
  });
});

describe('@fw/cache · CacheModule 真实装配', () => {
  it('memory 驱动装配成功：服务可注入、token 同实例、指标控制器与就绪探针就位', async () => {
    const probe = createCacheReadinessProbe();
    const metrics = new CacheMetrics();
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ env: { APP_ENV: 'test', CACHE_DRIVER: 'memory' }, readinessProbe: probe, metrics })],
    }).compile();

    // 真实装配后 /ready 探针可用（此前应为未就绪）
    expect(await probe.check()).toBe(true);

    const service = moduleRef.get(CacheService);
    expect(moduleRef.get(CACHE_SERVICE)).toBe(service);
    expect(moduleRef.get(CACHE_OPTIONS).prefix).toBe('fw:test');
    expect(moduleRef.get(CACHE_METRICS)).toBe(metrics);
    expect(service.driver).toBe('memory');
    expect(moduleRef.get(CacheMetricsController)).toBeInstanceOf(CacheMetricsController);

    // 真实读写（走容器实例）
    await service.set('k', 'v', { ttlSeconds: 30 });
    expect(await service.get('k')).toBe('v');

    // 全局兜底实例已注册：无属性注入的类也能用 @Cacheable
    expect(resolveCacheService({})).toBe(service);

    await moduleRef.close();
    expect(await service.has('k')).toBe(false);
  });

  it('自定义 store 注入时忽略 CACHE_DRIVER，指标按 store.kind 归集', async () => {
    const store = new FaultyStore();
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ env: { APP_ENV: 'test', CACHE_DRIVER: 'memory' }, store })],
    }).compile();

    const service = moduleRef.get(CacheService);
    // 注入的 store 决定 kind（CACHE_DRIVER=memory 被忽略）
    expect(service.driver).toBe('redis');
    await service.set('k', 'v');
    expect(service.metricsSnapshot().driver).toBe('redis');
    await moduleRef.close();
  });

  it('exposeMetrics=false 时不注册 /metrics 控制器', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ env: { APP_ENV: 'test' }, exposeMetrics: false })],
    }).compile();
    expect(moduleRef.get(CacheService)).toBeInstanceOf(CacheService);
    expect(() => moduleRef.get(CacheMetricsController)).toThrow();
    await moduleRef.close();
  });

  it('memory 驱动下 CACHE_URL 可缺省；redis 驱动缺连接串时装配直接失败', async () => {
    const memory = await Test.createTestingModule({ imports: [CacheModule.forRoot({ env: { APP_ENV: 'test' } })] }).compile();
    expect(memory.get(CacheService).driver).toBe('memory');
    await memory.close();

    await expect(
      Test.createTestingModule({ imports: [CacheModule.forRoot({ env: { APP_ENV: 'test', CACHE_DRIVER: 'redis' } })] }).compile(),
    ).rejects.toThrow(/CACHE_URL/);
  });

  it('memory 驱动的 store 为 MemoryCacheStore 且应用容量上限', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CacheModule.forRoot({ env: { APP_ENV: 'test', CACHE_MAX_ITEMS: 2 } })],
    }).compile();
    const service = moduleRef.get(CacheService);
    await service.set('a', 1);
    await service.set('b', 2);
    await service.set('c', 3);
    expect(await service.get('a')).toBeUndefined();
    expect(await service.get('c')).toBe(3);
    await moduleRef.close();
  });
});
