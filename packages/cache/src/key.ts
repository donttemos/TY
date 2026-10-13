/*
 * @file key 规范与序列化
 * @description 统一 `前缀:模块:标识` key 规范（PRD-004 FR-04）：字符白名单校验、长度上限、
 *   标签映射键构造、参数稳定哈希（装饰器默认 key 用）；信封序列化为 JSON（可读可排查，
 *   PRD-004 §9 结论），用单字符前缀区分「真实值」与「空值占位」。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { CacheKeyError } from './errors.js';
import type { CacheEntryKind } from './types.js';

/** 逻辑 key（未加全局前缀）允许的字符：字母数字与 `: . _ - # @ /` */
const LOGICAL_KEY_RE = /^[A-Za-z0-9:._\-#@/]+$/;

/** 逻辑 key 最大长度（含前缀后不得超过 512，兼容 Redis key 实践） */
export const MAX_KEY_LENGTH = 512;

/** 标签映射键的保留段名 */
export const TAG_SEGMENT = '__tag__';

/** 空值占位前缀字符 */
const NEGATIVE_PREFIX = 'n';

/** 真实值前缀字符 */
const POSITIVE_PREFIX = 'v';

/**
 * 校验逻辑 key（不含前缀）
 * @param key 逻辑 key
 * @throws CacheKeyError 含非法字符或超长
 */
export function assertLogicalKey(key: string): void {
  if (!key) throw new CacheKeyError(key, '不能为空');
  if (!LOGICAL_KEY_RE.test(key)) throw new CacheKeyError(key, '仅允许字母数字与 : . _ - # @ /');
  if (key.length > MAX_KEY_LENGTH) throw new CacheKeyError(key, `长度超过 ${MAX_KEY_LENGTH}`);
}

/**
 * 拼接全局前缀
 * @param prefix 全局前缀（已解析）
 * @param key 逻辑 key
 * @returns 完整键
 */
export function withPrefix(prefix: string, key: string): string {
  return prefix ? `${prefix}:${key}` : key;
}

/**
 * 构造标签映射键：`<前缀>:__tag__:<标签>`
 * @param prefix 全局前缀
 * @param tag 标签名
 */
export function tagKeyOf(prefix: string, tag: string): string {
  return withPrefix(prefix, `${TAG_SEGMENT}:${tag}`);
}

/**
 * FNV-1a 32 位哈希（base36）：跨进程稳定，用于装饰器默认 key
 * @param input 输入字符串
 * @returns 稳定哈希串
 */
export function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(36);
}

/**
 * 参数稳定哈希：对象键排序后序列化，避免 `{a:1,b:2}` 与 `{b:2,a:1}` 生成不同 key
 * @param args 方法参数
 * @returns 形如 `a1b2c3` 的短哈希
 */
export function hashArgs(args: readonly unknown[]): string {
  return stableHash(stableStringify(args));
}

/** 稳定序列化：对象键升序；不可序列化（循环引用/函数）退化为 String 形态 */
function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const walk = (node: unknown): unknown => {
    if (node === null || typeof node !== 'object') {
      return typeof node === 'function' ? '[fn]' : node;
    }
    if (seen.has(node as object)) return '[circular]';
    seen.add(node as object);
    if (Array.isArray(node)) return node.map(walk);
    const entries = Object.entries(node as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const out: Record<string, unknown> = {};
    for (const [k, v] of entries) out[k] = walk(v);
    return out;
  };
  try {
    return JSON.stringify(walk(value)) ?? 'undefined';
  } catch {
    return String(value);
  }
}

/**
 * 序列化真实值：`v` + JSON
 * @param value 业务值（非 undefined）
 */
export function encodeValue(value: unknown): string {
  return POSITIVE_PREFIX + JSON.stringify(value ?? null);
}

/** 空值占位（防穿透）序列化 */
export function encodeNegative(): string {
  return NEGATIVE_PREFIX;
}

/**
 * 反序列化缓存条目
 * @param raw 存储层原始字符串
 * @returns 条目类型与值；无法识别的历史数据按真实值尽力解析
 */
export function decodeEntry<T>(raw: string): { kind: CacheEntryKind; value: T | undefined } {
  if (raw.startsWith(NEGATIVE_PREFIX) && raw.length === 1) return { kind: 'negative', value: undefined };
  if (raw.startsWith(POSITIVE_PREFIX)) {
    const payload = raw.slice(1);
    try {
      return { kind: 'positive', value: JSON.parse(payload) as T };
    } catch {
      return { kind: 'positive', value: payload as unknown as T };
    }
  }
  // 兼容非信封数据（人工写入或早期版本）
  try {
    return { kind: 'positive', value: JSON.parse(raw) as T };
  } catch {
    return { kind: 'positive', value: raw as unknown as T };
  }
}
