/*
 * @file 单测：客户端代理与装配期扫描
 * @description 覆盖 createTransportProxy 的方法→地址映射（`<前缀>.<方法名>`）、
 *   非方法属性黑名单（then/toJSON 等返回 undefined，防误触发传输调用）、symbol 属性直通，
 *   以及 scanTransportHandlers 的发现/去重/跳过语义与 @TransportHandler 元数据读写。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it, vi } from 'vitest';
import { createTransportProxy } from '../proxy.js';
import { META_TRANSPORT_HANDLER, TransportHandler, readTransportHandlerAddress } from '../decorators.js';
import { scanTransportHandlers } from '../discovery.js';
import { TransportService } from '../transport.service.js';
import { InProcessTransportDriver } from '../drivers/in-process.driver.js';
import { TransportRegistry } from '../registry.js';

/** 端口接口示例 */
interface EchoPort {
  echo(payload: { message: string }): Promise<{ message: string }>;
  stats(): Promise<{ calls: number }>;
}

/** 构造仅记录调用的传输服务桩 */
function makeTransportStub(): { stub: { call: ReturnType<typeof vi.fn> }; service: TransportService } {
  const stub = { call: vi.fn(async () => undefined) };
  return { stub, service: stub as unknown as TransportService };
}

describe('createTransportProxy', () => {
  it('方法调用映射为 <前缀>.<方法名> 的传输调用并透传载荷', async () => {
    const { stub, service } = makeTransportStub();
    const port = createTransportProxy<EchoPort>(service, 'demo-transport');

    await port.echo({ message: 'hi' });
    expect(stub.call).toHaveBeenCalledWith('demo-transport.echo', { message: 'hi' });

    await port.stats();
    expect(stub.call).toHaveBeenCalledWith('demo-transport.stats', undefined);
    expect(stub.call).toHaveBeenCalledTimes(2);
  });

  it('返回传输调用的 Promise（代理不吞结果）', async () => {
    const registry = new TransportRegistry('both');
    const driver = new InProcessTransportDriver(registry, { instanceId: 'inst-a' });
    const service = new TransportService(driver, registry, { instanceId: 'inst-a', role: 'both', shutdownTimeoutMs: 500 });
    service.register('demo-transport.echo', (payload) => payload);
    const port = createTransportProxy<EchoPort>(service, 'demo-transport');
    await expect(port.echo({ message: 'real' })).resolves.toEqual({ message: 'real' });
  });

  it('NON_METHOD_PROPS 黑名单属性返回 undefined（防序列化/展开/生命周期钩子误触发调用）', () => {
    const { service } = makeTransportStub();
    const port = createTransportProxy<EchoPort>(service, 'demo-transport') as unknown as Record<string, unknown>;
    for (const prop of ['then', 'catch', 'finally', 'toJSON', 'toString', 'valueOf', 'inspect', 'nodeType', 'tagName']) {
      expect(port[prop], prop).toBeUndefined();
    }
    // Nest 生命周期钩子：框架按「方法存在即调用」invoke provider，误映射会产生幽灵传输调用
    for (const hook of ['onModuleInit', 'onModuleDestroy', 'onApplicationBootstrap', 'onApplicationShutdown', 'beforeApplicationShutdown', 'configure']) {
      expect(port[hook], hook).toBeUndefined();
    }
  });

  it('constructor 返回哑构造器（维持对象契约，扫描器读 .constructor 不炸）', () => {
    const { stub, service } = makeTransportStub();
    const port = createTransportProxy<EchoPort>(service, 'demo-transport') as unknown as { constructor: unknown };
    expect(typeof port.constructor).toBe('function');
    // 哑构造器不携带 @TransportHandler 元数据：装配期扫描天然跳过代理 provider
    expect(readTransportHandlerAddress(port.constructor as object)).toBeUndefined();
    expect(stub.call).not.toHaveBeenCalled();
  });

  it('symbol 属性返回 undefined', () => {
    const { service } = makeTransportStub();
    const port = createTransportProxy<EchoPort>(service, 'demo-transport') as unknown as Record<symbol, unknown>;
    expect(port[Symbol.iterator]).toBeUndefined();
  });
});

@TransportHandler('demo-transport.decorated')
class DecoratedHandler {
  async handle(): Promise<unknown> {
    return 'ok';
  }
}

class UndecoratedHandler {
  async handle(): Promise<unknown> {
    return 'ok';
  }
}

describe('scanTransportHandlers', () => {
  it('发现带 @TransportHandler 的实例并读出地址', () => {
    const decorated = new DecoratedHandler();
    const scanned = scanTransportHandlers([{ instance: decorated }, { instance: new UndecoratedHandler() }]);
    expect(scanned).toHaveLength(1);
    expect(scanned[0].address).toBe('demo-transport.decorated');
    expect(scanned[0].instance).toBe(decorated);
    expect(readTransportHandlerAddress(DecoratedHandler)).toBe('demo-transport.decorated');
    expect(readTransportHandlerAddress(UndecoratedHandler)).toBeUndefined();
    expect(META_TRANSPORT_HANDLER).toBe('fw:transport:handler');
  });

  it('同一实例重复出现只登记一次（去重）', () => {
    const decorated = new DecoratedHandler();
    const scanned = scanTransportHandlers([{ instance: decorated }, { instance: decorated }]);
    expect(scanned).toHaveLength(1);
  });

  it('无实例 / 非对象实例被跳过', () => {
    const scanned = scanTransportHandlers([{ instance: undefined }, { instance: 'not-an-object' }, { instance: 42 }]);
    expect(scanned).toEqual([]);
  });

  it('空列表返回空结果', () => {
    expect(scanTransportHandlers([])).toEqual([]);
  });
});
