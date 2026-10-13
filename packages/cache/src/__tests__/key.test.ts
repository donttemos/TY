/*
 * @file key 规范与序列化单测
 * @description 验证 key 白名单/长度校验、前缀拼接、标签键、稳定哈希（跨调用一致、参数顺序无关）
 *   与信封序列化的往返正确性（含边界值 false / 0 / 空串）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { describe, expect, it } from 'vitest';
import {
  MAX_KEY_LENGTH,
  assertLogicalKey,
  decodeEntry,
  encodeNegative,
  encodeValue,
  hashArgs,
  stableHash,
  tagKeyOf,
  withPrefix,
} from '../key.js';
import { CacheKeyError } from '../errors.js';

describe('@fw/cache · key 规范', () => {
  it('接受合法逻辑键，前缀拼接为 `前缀:键`', () => {
    expect(() => assertLogicalKey('user:1:profile')).not.toThrow();
    expect(withPrefix('fw:dev', 'user:1')).toBe('fw:dev:user:1');
    expect(withPrefix('', 'user:1')).toBe('user:1');
  });

  it('拒绝空键、含空白/中文的键与超长键（TC-CACHE 前置校验）', () => {
    expect(() => assertLogicalKey('')).toThrow(CacheKeyError);
    expect(() => assertLogicalKey('user 1')).toThrow(CacheKeyError);
    expect(() => assertLogicalKey('用户:1')).toThrow(CacheKeyError);
    expect(() => assertLogicalKey('a'.repeat(MAX_KEY_LENGTH + 1))).toThrow(CacheKeyError);
  });

  it('标签映射键使用保留段名 __tag__', () => {
    expect(tagKeyOf('fw:dev', 'user:1')).toBe('fw:dev:__tag__:user:1');
  });

  it('稳定哈希对同一输入恒定、对不同输入区分', () => {
    expect(stableHash('abc')).toBe(stableHash('abc'));
    expect(stableHash('abc')).not.toBe(stableHash('abd'));
  });

  it('参数哈希与对象键顺序无关（默认 key 稳定性）', () => {
    expect(hashArgs([{ a: 1, b: 2 }])).toBe(hashArgs([{ b: 2, a: 1 }]));
    expect(hashArgs([1, 'x'])).not.toBe(hashArgs(['x', 1]));
    // 循环引用与函数不抛错，退化为稳定占位
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(typeof hashArgs([circular])).toBe('string');
  });

  it('信封序列化往返正确，含 false / 0 / 空串等假值边界', () => {
    for (const value of [false, 0, '', null, { a: 1 }, [1, 2], 'abc']) {
      const decoded = decodeEntry(encodeValue(value));
      expect(decoded.kind).toBe('positive');
      expect(decoded.value).toEqual(value);
    }
  });

  it('空值占位序列化为 `n` 且解码为 negative', () => {
    expect(encodeNegative()).toBe('n');
    expect(decodeEntry('n')).toEqual({ kind: 'negative', value: undefined });
  });

  it('兼容非信封历史数据（无前缀 JSON 与裸字符串）', () => {
    expect(decodeEntry('{"a":1}').value).toEqual({ a: 1 });
    expect(decodeEntry('plain-text').value).toBe('plain-text');
  });
});
