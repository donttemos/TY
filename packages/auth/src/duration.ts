/*
 * @file 时长串解析
 * @description 把配置里的时长串（2h / 7d / 30m / 45s / 500ms）解析为秒数；裸数字按秒处理。
 *   注意：不使用 ms 作为单位换算基准，避免小数秒带来的取值歧义。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/auth
 */

/** 单位 → 秒 */
const UNIT_SECONDS: Record<string, number> = {
  ms: 0.001,
  s: 1,
  m: 60,
  h: 3600,
  d: 86400,
  w: 604800,
};

/**
 * 解析时长串为秒数
 * @param value 时长（数字按秒；字符串支持 ms/s/m/h/d/w，如 '2h'）
 * @returns 秒数（向上取整，最小 1 秒）
 * @throws Error 格式非法
 */
export function parseDurationSeconds(value: string | number): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`非法时长: ${value}`);
    return Math.max(1, Math.ceil(value));
  }
  const matched = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h|d|w)?$/.exec(value.trim());
  if (!matched) throw new Error(`非法时长格式: ${value}（示例：30s / 15m / 2h / 7d）`);
  const amount = Number(matched[1]);
  const unit = matched[2] ?? 's';
  const seconds = amount * UNIT_SECONDS[unit];
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`非法时长: ${value}`);
  return Math.max(1, Math.ceil(seconds));
}
