/*
 * @file cron 表达式解析单测
 * @description 覆盖 5 段 / 6 段、通配与区间步长、别名、日与周的「或」语义、时区换算、
 *   严格晚于起点、以及非法表达式在装配期即报错（TC-JOB-002 的前置保障）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { describe, expect, it } from 'vitest';
import { CronExpression, parseCron } from '../cron-expression.js';
import { CronExpressionError } from '../errors.js';

/** 构造某地本地时间的 Date */
function at(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): Date {
  return new Date(year, month - 1, day, hour, minute, second);
}

describe('CronExpression 5 段', () => {
  it('每天 02:00 的下一次触发', () => {
    const cron = new CronExpression('0 2 * * *');
    expect(cron.hasSeconds).toBe(false);
    expect(cron.next(at(2026, 10, 13, 1, 30))).toEqual(at(2026, 10, 13, 2, 0));
    expect(cron.next(at(2026, 10, 13, 2, 0))).toEqual(at(2026, 10, 14, 2, 0));
    expect(cron.next(at(2026, 10, 13, 3, 0))).toEqual(at(2026, 10, 14, 2, 0));
  });

  it('每 15 分钟（*/15）', () => {
    const cron = new CronExpression('*/15 * * * *');
    expect(cron.next(at(2026, 10, 13, 10, 1))).toEqual(at(2026, 10, 13, 10, 15));
    expect(cron.next(at(2026, 10, 13, 10, 15))).toEqual(at(2026, 10, 13, 10, 30));
    expect(cron.next(at(2026, 10, 13, 10, 46))).toEqual(at(2026, 10, 13, 11, 0));
  });

  it('区间与列表（1-5 / 逗号）', () => {
    const cron = new CronExpression('0 9-11 * * 1-5');
    // 2026-10-13 是周二
    expect(cron.next(at(2026, 10, 13, 8, 0))).toEqual(at(2026, 10, 13, 9, 0));
    expect(cron.next(at(2026, 10, 13, 11, 0))).toEqual(at(2026, 10, 14, 9, 0));
    // 周六（2026-10-17）不触发，顺延到周一
    expect(cron.next(at(2026, 10, 17, 10, 0))).toEqual(at(2026, 10, 19, 9, 0));
  });

  it('月份别名与步长', () => {
    const cron = new CronExpression('30 0 1 JAN,JUL *');
    expect(cron.next(at(2026, 10, 13))).toEqual(at(2027, 1, 1, 0, 30));
  });

  it('日与周同时受限时取「或」', () => {
    const cron = new CronExpression('0 0 13 * 5');
    // 每月 13 号 或 每周五 → 2026-10-13（周二）命中
    expect(cron.next(at(2026, 10, 1))).toEqual(at(2026, 10, 2, 0, 0)); // 2026-10-02 是周五
    expect(cron.next(at(2026, 10, 12, 1))).toEqual(at(2026, 10, 13, 0, 0));
  });

  it('问号等价于通配', () => {
    const cron = new CronExpression('0 0 ? * MON');
    expect(cron.matches(at(2026, 10, 19, 0, 0))).toBe(true); // 周一
    expect(cron.matches(at(2026, 10, 20, 0, 0))).toBe(false); // 周二
  });

  it('星期日可用 0 或 7', () => {
    const zero = new CronExpression('0 0 * * 0');
    const seven = new CronExpression('0 0 * * 7');
    expect(zero.next(at(2026, 10, 13))).toEqual(at(2026, 10, 18, 0, 0));
    expect(seven.next(at(2026, 10, 13))).toEqual(at(2026, 10, 18, 0, 0));
  });
});

describe('CronExpression 6 段（含秒）', () => {
  it('每 5 秒', () => {
    const cron = new CronExpression('*/5 * * * * *');
    expect(cron.hasSeconds).toBe(true);
    expect(cron.next(at(2026, 10, 13, 10, 0, 1))).toEqual(at(2026, 10, 13, 10, 0, 5));
    expect(cron.next(at(2026, 10, 13, 10, 0, 5))).toEqual(at(2026, 10, 13, 10, 0, 10));
  });

  it('matches 精确到秒', () => {
    const cron = new CronExpression('30 0 12 * * *');
    expect(cron.matches(at(2026, 10, 13, 12, 0, 30))).toBe(true);
    expect(cron.matches(at(2026, 10, 13, 12, 0, 31))).toBe(false);
  });
});

describe('时区', () => {
  it('按指定时区解释墙钟时间', () => {
    const shanghai = new CronExpression('0 2 * * *', 'Asia/Shanghai');
    const utc = new CronExpression('0 2 * * *', 'UTC');
    const from = new Date('2026-10-12T20:00:00.000Z');
    // 北京时间 02:00 = UTC 前一日 18:00；UTC 02:00 = 北京时间 10:00
    expect(shanghai.next(from).toISOString()).toBe('2026-10-13T18:00:00.000Z');
    expect(utc.next(from).toISOString()).toBe('2026-10-13T02:00:00.000Z');
  });

  it('非法时区名抛出异常（Intl 失败）', () => {
    expect(() => new CronExpression('0 2 * * *', 'Not/AZone')).toThrow();
  });
});

describe('异常与缓存', () => {
  it('段数或语法非法时抛 CronExpressionError', () => {
    expect(() => new CronExpression('0 2 * *')).toThrow(CronExpressionError);
    expect(() => new CronExpression('* * * * * * *')).toThrow(CronExpressionError);
    expect(() => new CronExpression('0 0 1 * *')).not.toThrow();
    expect(() => new CronExpression('0 24 * * *')).toThrow(CronExpressionError);
    expect(() => new CronExpression('5-1 * * * *')).toThrow(CronExpressionError);
    expect(() => new CronExpression('*/0 * * * *')).toThrow(CronExpressionError);
    expect(() => new CronExpression('1,, * * * *')).toThrow(CronExpressionError);
    expect(() => new CronExpression('  ')).toThrow(CronExpressionError);
  });

  it('一年内无匹配时刻时报错（2 月 30 日）', () => {
    expect(() => new CronExpression('0 0 30 2 *').next(new Date('2026-01-01T00:00:00'))).toThrow(CronExpressionError);
  });

  it('parseCron 返回缓存实例', () => {
    const a = parseCron('0 3 * * *');
    const b = parseCron('0 3 * * *');
    expect(a).toBe(b);
    expect(parseCron('0 3 * * *', 'UTC')).not.toBe(a);
  });

  it('严格晚于起点（同刻不再触发）', () => {
    const cron = new CronExpression('0 0 * * *');
    const now = at(2026, 10, 13, 0, 0);
    expect(cron.next(now).getTime()).toBeGreaterThan(now.getTime());
  });
});
