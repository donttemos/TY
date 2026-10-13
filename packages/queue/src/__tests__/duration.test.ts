/*
 * @file 时长与退避解析单测
 * @description 覆盖时长串解析（含非法输入）、退避序列解析与「第 n 次重试取第 n 项」的语义，
 *   并逐字校验 MQ_BACKOFF 默认值 `1000,5000,30000`（与 PRD-007 FR-04 的 1s/5s/30s 对齐）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { backoffFor, parseBackoffSequence, parseDurationMs } from '../duration.js';
import { JobOptionError } from '../errors.js';

describe('parseDurationMs', () => {
  it('解析带单位与不带单位的时长串', () => {
    expect(parseDurationMs(0)).toBe(0);
    expect(parseDurationMs(1500)).toBe(1500);
    expect(parseDurationMs('250')).toBe(250);
    expect(parseDurationMs('30s')).toBe(30_000);
    expect(parseDurationMs('30m')).toBe(1_800_000);
    expect(parseDurationMs('1.5h')).toBe(5_400_000);
    expect(parseDurationMs('2d')).toBe(172_800_000);
    expect(parseDurationMs(' 5m ')).toBe(300_000);
  });

  it('非法输入抛 JobOptionError（错误码 1001）', () => {
    expect(() => parseDurationMs('abc')).toThrow(JobOptionError);
    expect(() => parseDurationMs('5y')).toThrow(JobOptionError);
    expect(() => parseDurationMs(-1)).toThrow(JobOptionError);
    expect(() => parseDurationMs('')).toThrow(JobOptionError);
    try {
      parseDurationMs('oops');
    } catch (error) {
      expect((error as JobOptionError).code).toBe(1001);
    }
  });
});

describe('parseBackoffSequence', () => {
  it('解析默认序列为 1s / 5s / 30s', () => {
    expect(parseBackoffSequence('1000,5000,30000')).toEqual([1000, 5000, 30000]);
    expect(parseBackoffSequence(' 1000 , 5000 ')).toEqual([1000, 5000]);
    expect(parseBackoffSequence('')).toEqual([]);
  });

  it('非法项抛 JobOptionError', () => {
    expect(() => parseBackoffSequence('1000,abc')).toThrow(JobOptionError);
    expect(() => parseBackoffSequence('0')).toThrow(JobOptionError);
    expect(() => parseBackoffSequence('1.5')).toThrow(JobOptionError);
  });
});

describe('backoffFor', () => {
  it('第 n 次重试取序列第 n 项，超出取最后一项', () => {
    const seq = [1000, 5000, 30000];
    expect(backoffFor(seq, 1)).toBe(1000);
    expect(backoffFor(seq, 2)).toBe(5000);
    expect(backoffFor(seq, 3)).toBe(30000);
    expect(backoffFor(seq, 4)).toBe(30000);
    expect(backoffFor(seq, 0)).toBe(1000);
    expect(backoffFor([], 1)).toBe(0);
  });
});
