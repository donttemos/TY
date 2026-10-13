/*
 * @file 单测：redis 驱动（fake redis 注入，无真实连接）
 * @description 以内存版 FakeRedis 经 createClient 工厂注入驱动，验证跨进程 RPC 协议语义：
 *   请求/应答键命名与清理、信封字段、结果往返、BizError 跨进程按码重建、普通错误透传、
 *   无处理方超时 fail-fast、处理方执行上限取信封超时、caller 角色不起消费循环、
 *   启动后注册即时补起消费循环、坏消息丢弃、ping/close 连接管理。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { TransportError, TransportTimeoutError, TransportUnavailableError } from '../errors.js';
import { RedisTransportDriver } from '../drivers/redis.driver.js';
import { TransportRegistry } from '../registry.js';
import type { CallOptions, TransportContext } from '../types.js';
import { FakeRedis, sleepMs } from './test-helpers.js';

/** 传输测试环境 */
interface TransportFixture {
  /** 驱动 */
  driver: RedisTransportDriver;
  /** 注册表 */
  registry: TransportRegistry;
  /** fake redis（caller 与 worker 共用同一实例） */
  fake: FakeRedis;
  /** 停机并等待循环退出 */
  stop(): Promise<void>;
}

/**
 * 构造 redis 驱动测试环境
 * @param role 进程角色
 * @param runtimeOverrides 默认超时等覆盖
 */
function makeFixture(role: 'caller' | 'handler' | 'both' = 'both', runtimeOverrides: { defaultTimeoutMs?: number } = {}): TransportFixture {
  const fake = new FakeRedis();
  const registry = new TransportRegistry(role);
  const driver = new RedisTransportDriver(registry, {
    url: 'redis://fake',
    prefix: 'fw:test',
    instanceId: 'inst-a',
    defaultTimeoutMs: runtimeOverrides.defaultTimeoutMs ?? 5000,
    shutdownTimeoutMs: 500,
    createClient: () => fake,
  });
  return { driver, registry, fake, stop: () => driver.close() };
}

describe('RedisTransportDriver：请求/应答往返', () => {
  it('round trip：LPUSH 信封 → BRPOP 消费 → LPUSH 应答 → BLPOP 读取 → DEL 清理', async () => {
    const fx = makeFixture();
    const seen: { payload: unknown; ctx: TransportContext }[] = [];
    fx.driver.register('demo-transport.echo', (payload, ctx) => {
      seen.push({ payload, ctx });
      return { message: (payload as { message: string }).message, handledBy: ctx.instanceId };
    });
    await fx.driver.start();

    const result = await fx.driver.call<{ message: string; handledBy: string }>('demo-transport.echo', { message: 'hi' });
    expect(result).toEqual({ message: 'hi', handledBy: 'inst-a' });

    // 请求键已被消费；应答键被调用方 DEL；处理方对应答键设置了 60s 兜底 TTL
    expect(fx.fake.lengthOf('fw:test:req:demo-transport.echo')).toBe(0);
    expect(fx.fake.lists.size).toBe(0);
    expect(fx.fake.expired.some((e) => e.seconds === 60 && e.key.startsWith('fw:test:rpl:'))).toBe(true);

    // 处理方上下文：驱动名与实例标识随信封回传
    expect(seen).toHaveLength(1);
    expect(seen[0].payload).toEqual({ message: 'hi' });
    expect(seen[0].ctx.driver).toBe('redis');
    expect(seen[0].ctx.instanceId).toBe('inst-a');
    expect(seen[0].ctx.address).toBe('demo-transport.echo');
    expect(fx.driver.handledCount()).toBe(1);

    await fx.stop();
  });

  it('信封携带关联 id / 应答键 / 调用方标识 / 超时', async () => {
    const fx = makeFixture();
    let rawEnvelope: string | undefined;
    // 在 fake 上拦一层 BRPOP：worker 消费时记录原始报文，用于断言信封字段
    const originalBrpop = fx.fake.brpop.bind(fx.fake);
    fx.fake.brpop = async (key: string, timeoutSeconds: number) => {
      const popped = await originalBrpop(key, timeoutSeconds);
      if (popped && key === 'fw:test:req:demo-transport.echo') rawEnvelope = popped[1];
      return popped;
    };
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();

    await fx.driver.call('demo-transport.echo', { message: 'envelope' }, { timeoutMs: 1234 });
    expect(rawEnvelope).toBeDefined();
    const envelope = JSON.parse(rawEnvelope as string) as Record<string, unknown>;
    expect(envelope.address).toBe('demo-transport.echo');
    expect(envelope.payload).toEqual({ message: 'envelope' });
    expect(envelope.replyTo).toMatch(/^fw:test:rpl:/);
    expect(envelope.callerId).toBe('inst-a');
    expect(envelope.timeoutMs).toBe(1234);
    expect(typeof envelope.id).toBe('string');
    expect((envelope.id as string).length).toBeGreaterThan(0);
    expect(typeof envelope.sentAt).toBe('number');

    await fx.stop();
  });

  it('BizError 跨进程按错误码重建（调用方 catch 与 in-process 同类）', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.echo', () => {
      throw new BizError(ErrorCode.BAD_REQUEST, 'message 不能为空', [{ field: 'message', message: '不能为空' }]);
    });
    await fx.driver.start();

    await expect(fx.driver.call('demo-transport.echo', { message: '' })).rejects.toThrow(BizError);
    const error = await fx.driver.call('demo-transport.echo', { message: '' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BizError);
    expect((error as BizError).code).toBe(ErrorCode.BAD_REQUEST);
    expect((error as BizError).message).toBe('message 不能为空');

    await fx.stop();
  });

  it('普通错误跨进程重建为通用 TransportError 并保留消息', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.echo', () => {
      throw new TypeError('handler boom');
    });
    await fx.driver.start();

    const error = await fx.driver.call('demo-transport.echo', {}).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect(error).not.toBeInstanceOf(BizError);
    expect((error as Error).message).toBe('handler boom');

    await fx.stop();
  });

  it('不可 JSON 序列化的载荷在投递前即失败', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();

    await expect(fx.driver.call('demo-transport.echo', { big: 10n })).rejects.toThrow(TransportError);
    expect(fx.fake.lengthOf('fw:test:req:demo-transport.echo')).toBe(0);

    await fx.stop();
  });

  it('坏消息（不可解析 JSON）被静默丢弃，不影响后续请求', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();

    // 直接向请求键投递坏消息（模拟对端写脏数据）
    await fx.fake.lpush('fw:test:req:demo-transport.echo', 'not-json');
    // 等待 worker 丢弃后再发正常请求，round trip 仍然成立
    await sleepMs(50);
    const result = await fx.driver.call('demo-transport.echo', { message: 'after-bad' });
    expect(result).toEqual({ message: 'after-bad' });

    await fx.stop();
  });
});

describe('RedisTransportDriver：超时语义', () => {
  it('无处理方消费时按调用超时 fail-fast（不等满）', async () => {
    const fx = makeFixture(); // 注册了但不 start → 无消费循环
    fx.driver.register('demo-transport.echo', (payload) => payload);

    const start = Date.now();
    const options: CallOptions = { timeoutMs: 900 };
    await expect(fx.driver.call('demo-transport.echo', {}, options)).rejects.toThrow(TransportTimeoutError);
    // BLPOP 秒粒度 1s + 一轮循环即到 deadlines：总耗时应在 1s 量级而非 5s 默认超时
    expect(Date.now() - start).toBeLessThan(2000);

    await fx.stop();
  }, 10_000);

  it('处理方执行上限取信封内调用方超时（慢处理器回传错误而非挂死消费循环）', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.slow', async () => {
      await sleepMs(600);
      return 'late';
    });
    await fx.driver.start();

    const error = await fx.driver.call('demo-transport.slow', {}, { timeoutMs: 400 }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TransportError);
    expect((error as Error).message).toContain('demo-transport.slow');
    // 处理方计数仍 +1（请求已被处理，只是执行超时）
    expect(fx.driver.handledCount()).toBe(1);

    await fx.stop();
  }, 10_000);

  it('默认超时取构造选项 defaultTimeoutMs', async () => {
    const fx = makeFixture('both', { defaultTimeoutMs: 700 });
    fx.driver.register('demo-transport.echo', (payload) => payload);
    // 不 start：无消费方，按默认 700ms 超时
    await expect(fx.driver.call('demo-transport.echo', {})).rejects.toThrow(TransportTimeoutError);
    await fx.stop();
  }, 10_000);
});

describe('RedisTransportDriver：启动期配置守卫', () => {
  it('缺连接串时 start 即失败（懒加载不把错误推迟到首次调用）', async () => {
    const driver = new RedisTransportDriver(new TransportRegistry('both'), {
      url: undefined,
      prefix: 'fw:test',
      instanceId: 'inst-a',
      defaultTimeoutMs: 5000,
      shutdownTimeoutMs: 500,
      createClient: () => new FakeRedis(),
    });
    await expect(driver.start()).rejects.toThrow(TransportUnavailableError);
    await expect(driver.start()).rejects.toThrow(/TRANSPORT_URL/);
  });

  it('caller 角色同样要求连接串（投递请求也需要 Redis）', async () => {
    const driver = new RedisTransportDriver(new TransportRegistry('caller'), {
      url: '',
      prefix: 'fw:test',
      instanceId: 'inst-a',
      defaultTimeoutMs: 5000,
      shutdownTimeoutMs: 500,
      createClient: () => new FakeRedis(),
    });
    await expect(driver.start()).rejects.toThrow(TransportUnavailableError);
  });

  it('配置了连接串时 start 正常放行', async () => {
    const fx = makeFixture();
    await expect(fx.driver.start()).resolves.toBeUndefined();
    await fx.stop();
  });
});

describe('RedisTransportDriver：角色与生命周期', () => {
  it('caller 角色不起消费循环（start 后仍无处理方）', async () => {
    const fx = makeFixture('caller');
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();
    await expect(fx.driver.call('demo-transport.echo', {}, { timeoutMs: 900 })).rejects.toThrow(TransportTimeoutError);
    expect(fx.driver.handledCount()).toBe(0);
    await fx.stop();
  }, 10_000);

  it('handler 角色起消费循环并能处理请求', async () => {
    const fx = makeFixture('handler');
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();
    // 同进程内自证往返：投递 → worker 消费 → 应答
    await expect(fx.driver.call('demo-transport.echo', { message: 'self' })).resolves.toEqual({ message: 'self' });
    await fx.stop();
  });

  it('启动后注册即时补起该地址的消费循环', async () => {
    const fx = makeFixture();
    await fx.driver.start(); // 无已注册地址，无循环
    fx.driver.register('demo-transport.late', (payload) => payload);
    await expect(fx.driver.call('demo-transport.late', { message: 'spawned' })).resolves.toEqual({ message: 'spawned' });
    await fx.stop();
  });

  it('ping：无连接时先建调用方连接并探测；有连接时逐连接探测', async () => {
    const fx = makeFixture();
    await fx.driver.start();
    expect(await fx.driver.ping()).toBe(true);
    expect(fx.fake.pingCount).toBe(1); // 仅调用方连接（无已注册地址 → 无 worker 连接）

    fx.driver.register('demo-transport.echo', (payload) => payload);
    await sleepMs(30); // 等 worker 连接建立
    expect(await fx.driver.ping()).toBe(true);
    expect(fx.fake.pingCount).toBe(3); // 调用方 1 + worker 2（两次 ping 调用各覆盖全部存活连接）

    await fx.stop();
  });

  it('close：停消费循环并断开全部连接（可传等待上限）', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();
    await sleepMs(30); // 等 worker 连接建立
    await fx.driver.close(200);
    expect(fx.fake.closed).toBe(true);
  });

  it('close 是终态闩：停机后不再补起消费循环（调用按超时失败而非静默丢消息）', async () => {
    const fx = makeFixture();
    fx.driver.register('demo-transport.echo', (payload) => payload);
    await fx.driver.start();
    await fx.driver.close();
    expect(fx.fake.closed).toBe(true);

    // closing 单向闩：close 后 register 不补起循环，调用方在超时窗口内得到明确失败
    await expect(fx.driver.call('demo-transport.echo', { message: 'after-close' }, { timeoutMs: 900 })).rejects.toThrow(
      TransportTimeoutError,
    );
    await fx.driver.close();
  }, 10_000);
});
