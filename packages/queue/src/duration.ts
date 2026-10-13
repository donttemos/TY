/*
 * @file 时长与选项解析
 * @description 把 `delay` 的时长串（`'30s'` / `'1.5h'` / `'2d'`）与退避序列字符串（`'1000,5000,30000'`）
 *   解析为毫秒；非法输入一律抛 JobOptionError（错误码 1001），不做静默兜底。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/queue
 */

import { JobOptionError } from './errors.js';
import type { Duration } from './types.js';

/** 单位 → 毫秒 */
const UNIT_MS: Record<string, number> = {
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** 时长串格式：数字（可含小数）+ 可选单位 */
const DURATION_RE = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)?$/;

/**
 * 解析时长（毫秒）
 * @param value 毫秒数或时长串
 * @param label 出错时用于提示的字段名
 * @returns 毫秒数（非负整数）
 */
export function parseDurationMs(value: Duration, label = 'delay'): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) {
      throw new JobOptionError(`${label} 必须为非负数（毫秒），收到：${String(value)}`);
    }
    return Math.round(value);
  }
  const matched = DURATION_RE.exec(value.trim());
  if (!matched) {
    throw new JobOptionError(`${label} 格式非法：${value}（支持 30s / 5m / 1.5h / 2d 或纯数字毫秒）`);
  }
  const amount = Number.parseFloat(matched[1]);
  const unit = matched[2] ?? 'ms';
  return Math.round(amount * UNIT_MS[unit]);
}

/**
 * 解析退避序列（毫秒）
 * @param raw 逗号分隔的毫秒串（如 `'1000,5000,30000'`）；空串返回空数组
 * @param label 出错提示字段名
 * @returns 毫秒数组（每项 > 0）
 */
export function parseBackoffSequence(raw: string, label = 'MQ_BACKOFF'): number[] {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return [];
  return trimmed.split(',').map((part) => {
    const item = part.trim();
    if (!/^\d+$/.test(item) || Number(item) <= 0) {
      throw new JobOptionError(`${label} 各项必须为正整数毫秒：${item}`);
    }
    return Number(item);
  });
}

/**
 * 计算第 n 次重试前的等待时间（毫秒）
 * @param backoff 退避序列
 * @param attempt 已执行次数（重试次数 = attempt，即第 attempt 次重试）
 * @returns 等待毫秒；序列为空返回 0
 */
export function backoffFor(backoff: readonly number[], attempt: number): number {
  if (backoff.length === 0) return 0;
  const index = Math.min(Math.max(attempt, 1), backoff.length) - 1;
  return backoff[index];
}
