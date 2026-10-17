/*
 * @file key 规范与序列化
 * @description 统一 `前缀:模块:标识` key 规范（PRD-004 FR-04）：字符白名单校验、长度上限、
 *   标签映射键构造、参数稳定哈希（装饰器默认 key 用）；信封序列化为 JSON（可读可排查，
 *   PRD-004 §9 结论），用单字符前缀区分「真实值」与「空值占位」。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-17 donttemo Cache 缺陷清单复核修复（C-06）：参数哈希升级——① 序列化改为
 *   **类型可区分的规范化编码**（原 JSON.stringify 把数组内 undefined 折叠成 null、丢弃对象的
 *   undefined 属性、NaN/Infinity 折叠成 null，产生确定性碰撞）；② 摘要从 32 位 FNV-1a 升级为
 *   SHA-256（256 bit，哈希碰撞在缓存键场景下可忽略）。注意：升级后装饰器默认键与旧缓存条目
 *   不兼容，属一次性失效（旧条目等 TTL 自然过期），无脏读风险（新键读不到旧值只会回源）。
 * @module @fw/cache
 */

import { createHash } from 'node:crypto';
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
 * SHA-256 摘要（hex）：跨进程稳定，用于装饰器默认 key（C-06 修复——原 32 位 FNV-1a
 * 在数万不同参数集即有可观碰撞概率，按用户/租户区分结果的方法存在错误结果复用风险）
 * @param input 输入字符串
 * @returns 64 位十六进制摘要
 */
export function stableHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * 参数稳定哈希：类型可区分的规范化编码后取 SHA-256，避免 `{a:1,b:2}` 与 `{b:2,a:1}` 生成不同 key，
 * 同时区分 `[undefined]`/`[null]`、`{a:undefined}`/`{}`、`NaN`/`null` 等历史碰撞对（C-06 修复）
 * @param args 方法参数
 * @returns 64 位十六进制摘要
 */
export function hashArgs(args: readonly unknown[]): string {
  try {
    return stableHash(canonicalize(args, new WeakSet<object>()));
  } catch {
    // getter 抛错等极端输入：退化为稳定占位，不阻塞业务方法
    return stableHash(`~fallback:${String(args)}`);
  }
}

/**
 * 类型可区分的规范化编码（C-06）：每个值都带类型前缀，杜绝跨类型折叠——
 * undefined/null/NaN/±Infinity/bigint/boolean/string/function/circular 各有独立编码；
 * 数组保序、对象键升序、Set/Map/Date/RegExp 有专属编码。
 */
function canonicalize(node: unknown, seen: WeakSet<object>): string {
  if (node === undefined) return '~u';
  if (node === null) return '~z';
  switch (typeof node) {
    case 'number':
      if (Number.isNaN(node)) return '~nan';
      if (node === Number.POSITIVE_INFINITY) return '~pinf';
      if (node === Number.NEGATIVE_INFINITY) return '~ninf';
      return `~n:${node}`;
    case 'bigint':
      return `~i:${node}`;
    case 'boolean':
      return node ? '~b1' : '~b0';
    case 'string':
      return `~s:${JSON.stringify(node)}`;
    case 'function': {
      // 按函数源码区分（回归测试设计 §8.1：不同函数不得仅因类型相同就得到相同键）；
      // toString 对部分宿主函数可能抛错，退化为无源码占位
      try {
        return `~fn:${node.toString()}`;
      } catch {
        return '~fn';
      }
    }
    case 'symbol':
      return `~y:${String(node)}`;
    case 'object':
      break;
    default:
      return `~?${String(node)}`;
  }
  if (seen.has(node as object)) return '~circular';
  seen.add(node as object);
  try {
    if (node instanceof Date) return Number.isNaN(node.getTime()) ? '~date:invalid' : `~date:${node.getTime()}`;
    if (node instanceof RegExp) return `~re:${node.toString()}`;
    if (Array.isArray(node)) return `~a[${node.map((item) => canonicalize(item, seen)).join(',')}])`;
    if (node instanceof Set) return `~S[${[...node].map((item) => canonicalize(item, seen)).sort().join(',')}])`;
    if (node instanceof Map) {
      const entries = [...node.entries()].map(([k, v]) => `${canonicalize(k, seen)}=>${canonicalize(v, seen)}`).sort();
      return `~M[${entries.join(',')}])`;
    }
    const entries = Object.entries(node as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, value]) => `${JSON.stringify(key)}:${canonicalize(value, seen)}`);
    return `~o{${entries.join(',')}}`;
  } finally {
    // 同一对象非循环地出现两次（DAG）应正常展开两次，仅祖先链计入循环检测
    seen.delete(node as object);
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
