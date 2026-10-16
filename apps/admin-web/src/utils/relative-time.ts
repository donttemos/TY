/*
 * @file 相对时间格式化（M10 E-13）
 * @description 消息列表的「刚刚 / N 分钟前 / N 小时前 / 昨天 / 具体日期」展示。
 *   抽成纯函数便于单测（组件内不便断言时间文案），且不引第三方日期库
 *   ——只做展示降级，不做时区转换（服务端统一 UTC ISO，浏览器本地时区展示）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

/** 一分钟 / 一小时 / 一天的毫秒数 */
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * 相对时间文案
 * @param iso 时间（ISO 字符串）
 * @param now 参照时刻（缺省当前时间；便于单测注入）
 * @returns 展示文案；非法输入返回空串（列表不渲染空占位）
 */
export function formatRelativeTime(iso: string | null | undefined, now: number = Date.now()): string {
  if (!iso) return '';
  const timestamp = new Date(iso).getTime();
  if (!Number.isFinite(timestamp)) return '';
  const diff = now - timestamp;
  if (diff < 0) return '刚刚';
  if (diff < MINUTE) return '刚刚';
  if (diff < HOUR) return `${Math.floor(diff / MINUTE)} 分钟前`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)} 小时前`;
  if (diff < 2 * DAY) return '昨天';
  const date = new Date(timestamp);
  const pad = (value: number): string => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
