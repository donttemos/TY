/*
 * @file 相对时间格式化单测（M10 E-13）
 * @description 覆盖全部展示分支：刚刚 / N 分钟前 / N 小时前 / 昨天 / 具体日期，
 *   以及非法输入与「服务端时间略微超前」的容错（都不得渲染出 undefined / NaN）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

import { describe, expect, it } from 'vitest';
import { formatRelativeTime } from '../relative-time';

/** 参照时刻：2026-10-15 12:00:00（本地时区） */
const NOW = new Date(2026, 9, 15, 12, 0, 0).getTime();

/** 构造相对参照时刻偏移 ms 的 ISO 串 */
function at(offsetMs: number): string {
  return new Date(NOW + offsetMs).toISOString();
}

describe('formatRelativeTime', () => {
  it('一分钟内 → 刚刚（含服务端时间超前于本机的容错）', () => {
    expect(formatRelativeTime(at(-5_000), NOW)).toBe('刚刚');
    expect(formatRelativeTime(at(2_000), NOW)).toBe('刚刚');
  });

  it('分钟 / 小时 / 昨天 / 具体日期逐档降级', () => {
    expect(formatRelativeTime(at(-3 * 60_000), NOW)).toBe('3 分钟前');
    expect(formatRelativeTime(at(-59 * 60_000), NOW)).toBe('59 分钟前');
    expect(formatRelativeTime(at(-5 * 3_600_000), NOW)).toBe('5 小时前');
    expect(formatRelativeTime(at(-30 * 3_600_000), NOW)).toBe('昨天');
    expect(formatRelativeTime(at(-3 * 86_400_000), NOW)).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  it('空值与非法时间返回空串（不渲染 undefined / NaN）', () => {
    expect(formatRelativeTime(null, NOW)).toBe('');
    expect(formatRelativeTime(undefined, NOW)).toBe('');
    expect(formatRelativeTime('not-a-date', NOW)).toBe('');
  });
});
