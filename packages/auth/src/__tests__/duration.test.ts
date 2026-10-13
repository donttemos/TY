/*
 * @file 时长解析单测
 * @description 覆盖 30s / 15m / 2h / 7d / 裸数字 / 非法格式分支（配置键 AUTH_ACCESS_TTL 等的解析入口）
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */
import { describe, expect, it } from 'vitest';
import { parseDurationSeconds } from '../duration.js';

describe('parseDurationSeconds', () => {
  it('解析常用单位', () => {
    expect(parseDurationSeconds('45s')).toBe(45);
    expect(parseDurationSeconds('15m')).toBe(900);
    expect(parseDurationSeconds('2h')).toBe(7200);
    expect(parseDurationSeconds('7d')).toBe(604800);
    expect(parseDurationSeconds('1w')).toBe(604800);
  });

  it('裸数字按秒处理，毫秒向上取整到 1 秒', () => {
    expect(parseDurationSeconds(30)).toBe(30);
    expect(parseDurationSeconds('30')).toBe(30);
    expect(parseDurationSeconds('500ms')).toBe(1);
  });

  it('非法输入抛错', () => {
    expect(() => parseDurationSeconds('abc')).toThrow(/非法时长/);
    expect(() => parseDurationSeconds('')).toThrow(/非法时长/);
    expect(() => parseDurationSeconds(0)).toThrow(/非法时长/);
    expect(() => parseDurationSeconds(-5)).toThrow(/非法时长/);
  });
});
