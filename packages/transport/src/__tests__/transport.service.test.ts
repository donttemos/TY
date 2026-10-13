/*
 * @file 单测：传输服务（TransportService）
 * @description 覆盖业务侧唯一入口的语义：注册委托、调用统计埋点（成功/失败/超时分列）、
 *   服务级地址校验（先于计数）、ping 委托、启动期扫描注册与驱动启动、停机期优雅关闭，
 *   以及 instanceId / driverKind 只读视图。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it, vi } from 'vitest';
import { HandlerNotRegisteredError, InvalidAddressError, TransportTimeoutError } from '../errors.js';
import { InProcessTransportDriver } from '../drivers/in-process.driver.js';
import { TransportRegistry } from '../registry.js';
import { TransportService } from '../transport.service.js';
import { TransportHandler } from '../decorators.js';
import { sleepMs } from './test-helpers.js';

/** 服务构造选项 */
interface ServiceOptions {
  role?: 'caller' | 'handler' | 'both';
  instanceId?: string;
  shutdownTimeoutMs?: number;
}

/** 构造直连 in-process 驱动的传输服务 */
function makeService(overrides: ServiceOptions = {}): { service: TransportService; driver: InProcessTransportDriver; registry: TransportRegistry } {
  const registry = new TransportRegistry(overrides.role ?? 'both');
  const driver = new InProcessTransportDriver(registry, { instanceId: overrides.instanceId ?? 'inst-a' });
  const service = new TransportService(driver, registry, {
    instanceId: overrides.instanceId ?? 'inst-a',
    role: overrides.role ?? 'both',
    shutdownTimeoutMs: overrides.shutdownTimeoutMs ?? 500,
  });
  return { service, driver, registry };
}

/** DiscoveryService 桩：包装实例列表 */
function makeDiscovery(instances: object[]): { getProviders: () => Array<{ instance: unknown }> } {
  return { getProviders: (): Array<{ instance: unknown }> => instances.map((instance) => ({ instance })) };
}

@TransportHandler('demo-transport.scanned')
class ScannedHandler {
  public calls: Array<{ payload: unknown; instanceId: string }> = [];

  async handle(payload: unknown, ctx: { instanceId: string }): Promise<unknown> {
    this.calls.push({ payload, instanceId: ctx.instanceId });
    return { ok: true };
  }
}

class PlainHandler {
  async handle(): Promise<unknown> {
    return { ok: true };
  }
}

describe('TransportService：注册与调用', () => {
  it('register 委托驱动注册，调用成功并计数', async () => {
    const { service } = makeService();
    service.register('demo-transport.echo', (payload) => payload);
    const result = await service.call<{ message: string }>('demo-transport.echo', { message: 'hi' });
    expect(result).toEqual({ message: 'hi' });

    const stats = service.stats();
    expect(stats.calls).toBe(1);
    expect(stats.successes).toBe(1);
    expect(stats.failures).toBe(0);
    expect(stats.timeouts).toBe(0);
    expect(stats.handled).toBe(1);
    expect(stats.started).toBe(false);
    expect(stats.addresses).toBe(1);
    expect(stats.addressList).toEqual(['demo-transport.echo']);
    expect(stats.driver).toBe('in-process');
    expect(stats.instanceId).toBe('inst-a');
    expect(stats.role).toBe('both');
  });

  it('调用失败计 failures；超时单列 timeouts', async () => {
    const { service } = makeService();
    service.register('demo-transport.slow', async () => {
      await sleepMs(200);
      return 'late';
    });

    await expect(service.call('demo-transport.absent', {})).rejects.toThrow(HandlerNotRegisteredError);
    await expect(service.call('demo-transport.slow', {}, { timeoutMs: 50 })).rejects.toThrow(TransportTimeoutError);

    const stats = service.stats();
    expect(stats.calls).toBe(2);
    expect(stats.successes).toBe(0);
    expect(stats.failures).toBe(2);
    expect(stats.timeouts).toBe(1);
  });

  it('非法地址在计数前即被拦截', async () => {
    const { service } = makeService();
    await expect(service.call('nodots', {})).rejects.toThrow(InvalidAddressError);
    expect(service.stats().calls).toBe(0);
  });

  it('ping 委托驱动；instanceId / driverKind 只读视图', async () => {
    const { service, driver } = makeService({ instanceId: 'inst-view' });
    expect(service.instanceId).toBe('inst-view');
    expect(service.driverKind).toBe('in-process');
    await expect(service.ping()).resolves.toBe(true);

    const pingSpy = vi.spyOn(driver, 'ping');
    await service.ping();
    expect(pingSpy).toHaveBeenCalledTimes(1);
  });
});

describe('TransportService：启动与停机', () => {
  it('启动期扫描 @TransportHandler 注册并启动驱动，调用经扫描处理器完成', async () => {
    const { service } = makeService();
    const scanned = new ScannedHandler();
    (
      service as unknown as { discovery: unknown }
    ).discovery = makeDiscovery([scanned, new PlainHandler(), { instance: undefined }]);

    await service.onApplicationBootstrap();
    expect(service.stats().started).toBe(true);
    expect(service.stats().addressList).toEqual(['demo-transport.scanned']);

    const result = await service.call<{ ok: boolean }>('demo-transport.scanned', { message: 'x' });
    expect(result).toEqual({ ok: true });
    expect(scanned.calls).toHaveLength(1);
    expect(scanned.calls[0].instanceId).toBe('inst-a');
  });

  it('无 DiscoveryService 时跳过扫描但仍启动驱动', async () => {
    const { service } = makeService();
    await service.onApplicationBootstrap();
    expect(service.stats().started).toBe(true);
    expect(service.stats().addressList).toEqual([]);
    await service.onApplicationShutdown();
    expect(service.stats().started).toBe(false);
  });

  it('扫描结果实例去重（同一实例出现两次只注册一次）', async () => {
    const { service } = makeService();
    const scanned = new ScannedHandler();
    (service as unknown as { discovery: unknown }).discovery = makeDiscovery([scanned, scanned]);

    await service.onApplicationBootstrap();
    expect(service.stats().addresses).toBe(1);
    await service.onApplicationShutdown();
  });

  it('停机时以 shutdownTimeoutMs 优雅关闭驱动', async () => {
    const registry = new TransportRegistry('both');
    const driver = new InProcessTransportDriver(registry, { instanceId: 'inst-a' });
    const closeSpy = vi.spyOn(driver, 'close');
    const service = new TransportService(driver, registry, { instanceId: 'inst-a', role: 'both', shutdownTimeoutMs: 750 });

    await service.onApplicationBootstrap();
    await service.onApplicationShutdown();
    expect(closeSpy).toHaveBeenCalledWith(750);
    expect(service.stats().started).toBe(false);
  });
});
