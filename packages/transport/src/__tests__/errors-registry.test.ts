/*
 * @file 单测：注册表与异常族
 * @description 覆盖 TransportRegistry（角色语义、注册/解析/去重/非法地址）、
 *   assertAddress 的地址格式约束、serialize/deserializeTransportError 的跨进程错误对等
 *   （BizError 按错误码重建，两种驱动下调用方 catch 到同一错误类），以及异步工具
 *   withTimeout / delay 的超时与不限时语义。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import {
  DuplicateAddressError,
  HandlerNotRegisteredError,
  InvalidAddressError,
  TransportError,
  TransportTimeoutError,
  TransportUnavailableError,
  assertAddress,
  deserializeTransportError,
  serializeTransportError,
} from '../errors.js';
import { TransportRegistry, roleIncludesHandler } from '../registry.js';
import { delay, withTimeout } from '../async.js';
import { sleepMs } from './test-helpers.js';

describe('TransportRegistry', () => {
  it('handling 由角色推导：handler/both 为 true，caller 为 false', () => {
    expect(new TransportRegistry('caller').handling).toBe(false);
    expect(new TransportRegistry('handler').handling).toBe(true);
    expect(new TransportRegistry('both').handling).toBe(true);
    expect(roleIncludesHandler('caller')).toBe(false);
    expect(roleIncludesHandler('handler')).toBe(true);
    expect(roleIncludesHandler('both')).toBe(true);
  });

  it('注册后可解析、可查在、可按注册顺序列出', () => {
    const registry = new TransportRegistry('both');
    const handler = (): unknown => 'ok';
    registry.register('demo-transport.echo', handler);
    registry.register('demo-transport.stats', handler);
    expect(registry.resolve('demo-transport.echo')).toBe(handler);
    expect(registry.has('demo-transport.echo')).toBe(true);
    expect(registry.has('demo-transport.absent')).toBe(false);
    expect(registry.addresses()).toEqual(['demo-transport.echo', 'demo-transport.stats']);
    expect(registry.size).toBe(2);
    expect(registry.resolve('demo-transport.absent')).toBeUndefined();
  });

  it('重复注册抛 DuplicateAddressError', () => {
    const registry = new TransportRegistry('both');
    registry.register('a.b', () => undefined);
    expect(() => registry.register('a.b', () => undefined)).toThrow(DuplicateAddressError);
  });

  it('非法地址注册即抛 InvalidAddressError', () => {
    const registry = new TransportRegistry('both');
    expect(() => registry.register('nodots', () => undefined)).toThrow(InvalidAddressError);
    expect(() => registry.register('a..b', () => undefined)).toThrow(InvalidAddressError);
    expect(() => registry.register('a.b!', () => undefined)).toThrow(InvalidAddressError);
  });
});

describe('assertAddress', () => {
  it('合法地址：点分非空段（至少两段），段内字母/数字/下划线/连字符', () => {
    expect(() => assertAddress('a.b')).not.toThrow();
    expect(() => assertAddress('demo-transport.echo')).not.toThrow();
    expect(() => assertAddress('demo_transport.echo_v2')).not.toThrow();
    expect(() => assertAddress('a.b.c.d')).not.toThrow();
    expect(() => assertAddress('A1.b2')).not.toThrow();
  });

  it('非法地址：空段 / 单段 / 非法字符 / 非字符串', () => {
    for (const bad of ['', 'nodots', 'a..b', '.a.b', 'a.b.', 'a.b!', 'a b.c', 'a.b c']) {
      expect(() => assertAddress(bad), bad).toThrow(InvalidAddressError);
    }
    expect(() => assertAddress(undefined as unknown as string)).toThrow(InvalidAddressError);
    expect(() => assertAddress(42 as unknown as string)).toThrow(InvalidAddressError);
  });
});

describe('错误构造与字段', () => {
  it('各错误类携带定位字段', () => {
    const timeout = new TransportTimeoutError('a.b', 1500);
    expect(timeout).toBeInstanceOf(TransportError);
    expect(timeout.address).toBe('a.b');
    expect(timeout.timeoutMs).toBe(1500);
    expect(timeout.message).toContain('1500');

    const notRegistered = new HandlerNotRegisteredError('a.b');
    expect(notRegistered.address).toBe('a.b');
    expect(notRegistered.message).toContain('a.b');

    const unavailable = new TransportUnavailableError('缺连接串', new Error('root'));
    expect(unavailable.cause).toBeInstanceOf(Error);

    const dup = new DuplicateAddressError('a.b');
    expect(dup.address).toBe('a.b');
  });

  it('TransportError 可透传错误码与字段级错误', () => {
    const err = new TransportError('对端错误', { code: 1001, details: [{ field: 'message', message: '不能为空' }] });
    expect(err.code).toBe(1001);
    expect(err.details).toEqual([{ field: 'message', message: '不能为空' }]);
  });
});

describe('serializeTransportError / deserializeTransportError', () => {
  it('BizError 序列化携带错误码与字段级详情，并按原类型重建', () => {
    const original = new BizError(ErrorCode.BAD_REQUEST, 'message 不能为空', [{ field: 'message', message: '不能为空' }]);
    const payload = serializeTransportError(original);
    expect(payload).toEqual({
      name: 'BizError',
      message: 'message 不能为空',
      code: ErrorCode.BAD_REQUEST,
      details: [{ field: 'message', message: '不能为空' }],
    });

    const rebuilt = deserializeTransportError(payload);
    expect(rebuilt).toBeInstanceOf(BizError);
    expect((rebuilt as BizError).code).toBe(ErrorCode.BAD_REQUEST);
    expect(rebuilt.message).toBe('message 不能为空');
  });

  it('普通 Error 只带名称与消息；重建为通用 TransportError', () => {
    const payload = serializeTransportError(new TypeError('boom'));
    expect(payload).toEqual({ name: 'TypeError', message: 'boom' });
    const rebuilt = deserializeTransportError(payload);
    expect(rebuilt).toBeInstanceOf(TransportError);
    expect(rebuilt).not.toBeInstanceOf(BizError);
    expect(rebuilt.message).toBe('boom');
  });

  it('非 Error 抛出物转为字符串消息', () => {
    expect(serializeTransportError('oops')).toEqual({ name: 'Error', message: 'oops' });
    expect(serializeTransportError(42)).toEqual({ name: 'Error', message: '42' });
  });

  it('未知错误码不按 BizError 重建，但透传码', () => {
    const rebuilt = deserializeTransportError({ name: 'TransportError', message: 'x', code: 12345 });
    expect(rebuilt).toBeInstanceOf(TransportError);
    expect(rebuilt).not.toBeInstanceOf(BizError);
    expect((rebuilt as TransportError).code).toBe(12345);
  });

  it('带字段级详情的未知码错误透传 details', () => {
    const rebuilt = deserializeTransportError({
      name: 'TransportError',
      message: 'x',
      code: 12345,
      details: [{ field: 'f', message: 'm' }],
    });
    expect((rebuilt as TransportError).details).toEqual([{ field: 'f', message: 'm' }]);
  });
});

describe('withTimeout', () => {
  it('窗口内完成时返回结果', async () => {
    const result = await withTimeout(async () => {
      await sleepMs(10);
      return 'done';
    }, 500, 'a.b');
    expect(result).toBe('done');
  });

  it('超时抛 TransportTimeoutError（携带地址与上限）', async () => {
    await expect(
      withTimeout(async () => {
        await sleepMs(300);
        return 'late';
      }, 50, 'a.b'),
    ).rejects.toThrow(TransportTimeoutError);
  });

  it('timeoutMs <= 0 表示不限时', async () => {
    const result = await withTimeout(async () => {
      await sleepMs(30);
      return 'ok';
    }, 0, 'a.b');
    expect(result).toBe('ok');
  });

  it('同步任务同样受超时约束', async () => {
    expect(await withTimeout(() => 'sync', 100, 'a.b')).toBe('sync');
  });
});

describe('delay', () => {
  it('延迟指定毫秒后resolve', async () => {
    const start = Date.now();
    await delay(30);
    expect(Date.now() - start).toBeGreaterThanOrEqual(20);
  });
});
