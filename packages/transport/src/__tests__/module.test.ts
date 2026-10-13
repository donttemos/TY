/*
 * @file 单测：传输模块装配与环境配置解析
 * @description 覆盖 buildTransportOptions（默认值、TRANSPORT_URL→CACHE_URL 回退、前缀缺省
 *   fw:<APP_ENV>、实例标识缺省 host-<pid>、秒→毫秒换算、overrides 优先级）、
 *   createTransportReadinessProbe（装配前后就绪判定）、forRoot 的 provider/imports/exports
 *   装配、驱动工厂分支（in-process / redis / 不支持的驱动报错）与探针绑定。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it } from 'vitest';
import { TransportUnavailableError } from '../errors.js';
import { InProcessTransportDriver } from '../drivers/in-process.driver.js';
import { RedisTransportDriver } from '../drivers/redis.driver.js';
import { TransportRegistry } from '../registry.js';
import { TransportService } from '../transport.service.js';
import {
  TransportModule,
  buildTransportOptions,
  createTransportReadinessProbe,
  type TransportEnvLike,
} from '../transport.module.js';
import { TRANSPORT_DRIVER, TRANSPORT_OPTIONS, TRANSPORT_REGISTRY, TRANSPORT_SERVICE } from '../tokens.js';

/** 取动态模块中某 token 对应的 provider */
function findProvider(mod: { providers: unknown[] }, token: unknown): {
  provide: unknown;
  useFactory?: (...args: never[]) => unknown;
  useValue?: unknown;
  useExisting?: unknown;
} {
  const found = (mod.providers as Array<{ provide: unknown }>).find((p) => p.provide === token);
  if (!found) throw new Error(`provider 未找到：${String(token)}`);
  return found as ReturnType<typeof findProvider>;
}

describe('buildTransportOptions', () => {
  it('空环境取全量默认值', () => {
    const opts = buildTransportOptions({});
    expect(opts.driver).toBe('in-process');
    expect(opts.url).toBeUndefined();
    expect(opts.prefix).toBe('fw:default');
    expect(opts.timeoutMs).toBe(5000);
    expect(opts.role).toBe('both');
    expect(opts.instanceId).toMatch(/^host-\d+$/);
    expect(opts.shutdownTimeoutMs).toBe(10_000);
  });

  it('redis 缺 TRANSPORT_URL 时回退 CACHE_URL；前缀缺省 fw:<APP_ENV>', () => {
    const env: TransportEnvLike = { TRANSPORT_DRIVER: 'redis', CACHE_URL: 'redis://127.0.0.1:6379/0', APP_ENV: 'prod' };
    const opts = buildTransportOptions(env);
    expect(opts.driver).toBe('redis');
    expect(opts.url).toBe('redis://127.0.0.1:6379/0');
    expect(opts.prefix).toBe('fw:prod');
  });

  it('显式 TRANSPORT_URL / TRANSPORT_PREFIX / 实例标识优先；秒配置换算毫秒', () => {
    const env: TransportEnvLike = {
      TRANSPORT_URL: 'redis://transport:6380/1',
      CACHE_URL: 'redis://cache:6379/0',
      TRANSPORT_PREFIX: 'myapp',
      TRANSPORT_TIMEOUT_MS: 1500,
      TRANSPORT_ROLE: 'caller',
      TRANSPORT_INSTANCE_ID: 'node-7',
      TRANSPORT_SHUTDOWN_TIMEOUT: 3,
    };
    const opts = buildTransportOptions(env);
    expect(opts.url).toBe('redis://transport:6380/1');
    expect(opts.prefix).toBe('myapp');
    expect(opts.timeoutMs).toBe(1500);
    expect(opts.role).toBe('caller');
    expect(opts.instanceId).toBe('node-7');
    expect(opts.shutdownTimeoutMs).toBe(3000);
  });

  it('空串 URL / 前缀按未配置处理（回退或缺省）', () => {
    const env: TransportEnvLike = { TRANSPORT_URL: '', TRANSPORT_PREFIX: '', APP_ENV: 'test' };
    const opts = buildTransportOptions(env);
    expect(opts.url).toBeUndefined();
    expect(opts.prefix).toBe('fw:test');
  });

  it('overrides 优先级最高', () => {
    const opts = buildTransportOptions({ TRANSPORT_TIMEOUT_MS: 1000, TRANSPORT_ROLE: 'caller' }, { timeoutMs: 2000, role: 'both' });
    expect(opts.timeoutMs).toBe(2000);
    expect(opts.role).toBe('both');
  });
});

describe('createTransportReadinessProbe', () => {
  it('装配前未就绪，绑定服务后按 ping 判定', async () => {
    const probe = createTransportReadinessProbe();
    expect(probe.name).toBe('transport');
    expect(await probe.check()).toBe(false);

    const registry = new TransportRegistry('both');
    const service = new TransportService(new InProcessTransportDriver(registry, { instanceId: 'x' }), registry, {
      instanceId: 'x',
      role: 'both',
      shutdownTimeoutMs: 500,
    });
    probe.markReady(service);
    expect(await probe.check()).toBe(true);
  });
});

describe('TransportModule.forRoot', () => {
  it('默认全局装配：导入 DiscoveryModule，导出服务与全部令牌', () => {
    const mod = TransportModule.forRoot({ env: {}, disableDiscovery: false });
    expect(mod.module).toBe(TransportModule);
    expect(mod.global).toBe(true);
    expect(mod.imports).toHaveLength(1);
    const tokens = (mod.providers as Array<{ provide: unknown }>).map((p) => p.provide);
    expect(tokens).toContain(TRANSPORT_REGISTRY);
    expect(tokens).toContain(TRANSPORT_DRIVER);
    expect(tokens).toContain(TRANSPORT_OPTIONS);
    expect(tokens).toContain(TransportService);
    expect(tokens).toContain(TRANSPORT_SERVICE);
    expect(mod.exports).toContain(TransportService);
    expect(mod.exports).toContain(TRANSPORT_SERVICE);
    expect(mod.exports).toContain(TRANSPORT_DRIVER);
    expect(mod.exports).toContain(TRANSPORT_REGISTRY);
    expect(mod.exports).toContain(TRANSPORT_OPTIONS);
  });

  it('disableDiscovery 时不导入 DiscoveryModule', () => {
    const mod = TransportModule.forRoot({ env: {}, disableDiscovery: true });
    expect(mod.imports).toEqual([]);
  });

  it('驱动工厂：in-process 与 redis 分支，不支持的驱动直接报错', () => {
    const inProcess = TransportModule.forRoot({ env: {}, disableDiscovery: true });
    const registry = new TransportRegistry('both');
    const inProcessDriver = findProvider(inProcess, TRANSPORT_DRIVER).useFactory!(registry as never) as { kind: string };
    expect(inProcessDriver).toBeInstanceOf(InProcessTransportDriver);
    expect(inProcessDriver.kind).toBe('in-process');

    const redis = TransportModule.forRoot({ env: { TRANSPORT_DRIVER: 'redis', TRANSPORT_URL: 'redis://x' }, disableDiscovery: true });
    const redisDriver = findProvider(redis, TRANSPORT_DRIVER).useFactory!(registry as never) as { kind: string };
    expect(redisDriver).toBeInstanceOf(RedisTransportDriver);
    expect(redisDriver.kind).toBe('redis');

    const kafka = TransportModule.forRoot({ env: { TRANSPORT_DRIVER: 'kafka' }, disableDiscovery: true });
    const badFactory = findProvider(kafka, TRANSPORT_DRIVER).useFactory!;
    expect(() => badFactory(registry as never)).toThrow(TransportUnavailableError);
    expect(() => badFactory(registry as never)).toThrow(/kafka/);

    const tcp = TransportModule.forRoot({ env: { TRANSPORT_DRIVER: 'tcp' }, disableDiscovery: true });
    expect(() => findProvider(tcp, TRANSPORT_DRIVER).useFactory!(registry as never)).toThrow(/暂不支持的传输驱动/);
  });

  it('自定义 driver 选项优先于环境驱动', () => {
    const custom = new InProcessTransportDriver(new TransportRegistry('both'), { instanceId: 'custom' });
    const mod = TransportModule.forRoot({ env: { TRANSPORT_DRIVER: 'redis' }, driver: custom, disableDiscovery: true });
    const registry = new TransportRegistry('both');
    const driver = findProvider(mod, TRANSPORT_DRIVER).useFactory!(registry as never);
    expect(driver).toBe(custom);
  });

  it('TRANSPORT_OPTIONS 提供生效的运行时配置', () => {
    const mod = TransportModule.forRoot({ env: { APP_ENV: 'prod' }, disableDiscovery: true });
    const runtime = findProvider(mod, TRANSPORT_OPTIONS).useValue as { prefix: string; instanceId: string };
    expect(runtime.prefix).toBe('fw:prod');
    expect(runtime.instanceId).toMatch(/^host-\d+$/);
  });

  it('服务工厂装配时把就绪探针绑定到传输服务', async () => {
    const probe = createTransportReadinessProbe();
    const mod = TransportModule.forRoot({ env: {}, readinessProbe: probe, disableDiscovery: true });
    const registry = new TransportRegistry('both');
    const driver = new InProcessTransportDriver(registry, { instanceId: 'inst-a' });
    const runtime = { instanceId: 'inst-a', role: 'both' as const, shutdownTimeoutMs: 500 };

    const service = findProvider(mod, TransportService).useFactory!(driver as never, registry as never, runtime as never) as TransportService;
    expect(service).toBeInstanceOf(TransportService);
    expect(await probe.check()).toBe(true);
  });

  it('TRANSPORT_SERVICE 与 TransportService 类令牌指向同一实例（useExisting）', () => {
    const mod = TransportModule.forRoot({ env: {}, disableDiscovery: true });
    expect(findProvider(mod, TRANSPORT_SERVICE).useExisting).toBe(TransportService);
  });
});
