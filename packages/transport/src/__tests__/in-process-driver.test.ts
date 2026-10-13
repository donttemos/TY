/*
 * @file 单测：in-process 驱动
 * @description 单体形态驱动的本地分发语义：调用直达本地处理器、处理上下文字段、
 *   handledCount 计数、caller 角色按设计不处理请求、超时窗口约束、ping 恒真、停机空转。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it } from 'vitest';
import { HandlerNotRegisteredError, TransportTimeoutError } from '../errors.js';
import { InProcessTransportDriver } from '../drivers/in-process.driver.js';
import { TransportRegistry } from '../registry.js';
import { sleepMs } from './test-helpers.js';

/** 构造 both 角色的 in-process 驱动 */
function makeDriver(role: 'caller' | 'handler' | 'both' = 'both', instanceId = 'inst-a'): InProcessTransportDriver {
  return new InProcessTransportDriver(new TransportRegistry(role), { instanceId });
}

describe('InProcessTransportDriver', () => {
  it('kind 为 in-process；start/close 为空操作，ping 恒真', async () => {
    const driver = makeDriver();
    expect(driver.kind).toBe('in-process');
    await expect(driver.start()).resolves.toBeUndefined();
    await expect(driver.ping()).resolves.toBe(true);
    await expect(driver.close()).resolves.toBeUndefined();
  });

  it('调用直达本地处理器并回传结果', async () => {
    const driver = makeDriver();
    driver.register('demo-transport.echo', (payload) => ({ message: (payload as { message: string }).message }));
    const result = await driver.call<{ message: string }>('demo-transport.echo', { message: 'hi' });
    expect(result).toEqual({ message: 'hi' });
    expect(driver.handledCount()).toBe(1);
  });

  it('处理上下文携带地址/驱动名/实例标识/收到时刻', async () => {
    const driver = makeDriver('both', 'inst-ctx');
    let seen: { address: string; driver: string; instanceId: string; receivedAt: number } | undefined;
    driver.register('demo-transport.echo', (_payload, ctx) => {
      seen = { address: ctx.address, driver: ctx.driver, instanceId: ctx.instanceId, receivedAt: ctx.receivedAt };
      return null;
    });
    const before = Date.now();
    await driver.call('demo-transport.echo', {});
    expect(seen).toBeDefined();
    expect(seen!.address).toBe('demo-transport.echo');
    expect(seen!.driver).toBe('in-process');
    expect(seen!.instanceId).toBe('inst-ctx');
    expect(seen!.receivedAt).toBeGreaterThanOrEqual(before);
  });

  it('处理器抛出的异常原样传播给调用方', async () => {
    const driver = makeDriver();
    driver.register('demo-transport.echo', () => {
      throw new Error('handler boom');
    });
    await expect(driver.call('demo-transport.echo', {})).rejects.toThrow('handler boom');
  });

  it('未注册地址抛 HandlerNotRegisteredError', async () => {
    const driver = makeDriver();
    await expect(driver.call('demo-transport.absent', {})).rejects.toThrow(HandlerNotRegisteredError);
  });

  it('非法地址在调用前即被 assertAddress 拦截', async () => {
    const driver = makeDriver();
    await expect(driver.call('nodots', {})).rejects.toThrow(/传输地址非法/);
  });

  it('caller 角色下本进程按设计不处理请求（即使本地已注册）', async () => {
    const driver = makeDriver('caller');
    driver.register('demo-transport.echo', () => 'should-not-run');
    await expect(driver.call('demo-transport.echo', {})).rejects.toThrow(HandlerNotRegisteredError);
    expect(driver.handledCount()).toBe(0);
  });

  it('传入超时选项时慢处理器触发 TransportTimeoutError', async () => {
    const driver = makeDriver();
    driver.register('demo-transport.slow', async () => {
      await sleepMs(300);
      return 'late';
    });
    await expect(driver.call('demo-transport.slow', {}, { timeoutMs: 50 })).rejects.toThrow(TransportTimeoutError);
  });

  it('未传超时选项时不限时（与 redis 信封超时语义对齐由调用方决定）', async () => {
    const driver = makeDriver();
    driver.register('demo-transport.slow', async () => {
      await sleepMs(50);
      return 'done';
    });
    await expect(driver.call('demo-transport.slow', {})).resolves.toBe('done');
  });
});
