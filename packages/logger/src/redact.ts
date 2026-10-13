/*
 * @file 敏感字段脱敏
 * @description 两层防护：对象字段按键名匹配（password/token/idcard 及其变体）替换为 ***；消息字符串中的 key=value / key: value 字样同样替换。禁止绕过——Logger 输出前必须经过本模块。
 * @author donttemo
 * @created 2026-10-09
 * @module logger
 * @since v0.1.0
 */

/** 脱敏占位符 */
export const MASK = '***';

/** 敏感键名片段：命中其一即脱敏（不区分大小写；token 已覆盖 accessToken / refreshToken 等变体） */
const SENSITIVE_KEY_PATTERN = /password|token|idcard|secret|authorization/i;

/** 消息文本中的敏感赋值字样：password=xxx / token: xxx */
const SENSITIVE_TEXT_PATTERN = /((?:password|token|idcard|secret|authorization)[\w-]*)\s*[=:]\s*\S+/gi;

/** 最大递归深度，防御循环引用与超深结构 */
const MAX_DEPTH = 6;

/**
 * 递归脱敏对象中的敏感字段（返回新对象，不修改原值）
 * @param value 任意结构化字段
 * @param depth 当前递归深度
 * @returns 脱敏后的副本
 */
export function redactValue(value: unknown, depth = 0): unknown {
  if (depth >= MAX_DEPTH) return '[max-depth]';
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, depth + 1));
  }
  if (value instanceof Error) {
    return { name: value.name, message: redactText(value.message) };
  }
  if (value instanceof Date) return value.toISOString();
  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(value as Record<string, unknown>)) {
    result[key] = SENSITIVE_KEY_PATTERN.test(key) ? MASK : redactValue(val, depth + 1);
  }
  return result;
}

/**
 * 脱敏消息文本中的敏感赋值字样
 * @param text 原始消息
 * @returns 替换后的消息（password=*** 形式）
 */
export function redactText(text: string): string {
  return text.replace(SENSITIVE_TEXT_PATTERN, `$1=${MASK}`);
}
