/*
 * @file 列表查询参数解析（api-spec §1.5 的 HTTP 契约 → 框架查询结构）
 * @description 把 HTTP 层约定的 snake_case 查询串解析成框架内部结构，供列表端点直接消费：
 *   - `parseSortQuery('created_at:desc,id:asc', MAP)` → `{ createdAt: 'desc', id: 'asc' }`
 *   - `parseSortItems(...)` 返回带原始参数名的明细（供审计/回显用）
 *
 *   设计取舍（BUG-15）：
 *   1) **字段名走显式映射表白名单**，未知字段一律 400 —— 静默忽略会让客户端以为排序已生效（假成功），
 *      且直接把 query 参数拼进 orderBy 会引入未授权字段排序（可据此推断未暴露字段的存在性与分布）。
 *   2) 方向大小写不敏感；方向缺省为 `asc`（与 api-spec §1.5 示例一致，允许简写）。
 *   3) 空串 / 未传 / 全为空白 → 返回 `undefined`，由调用方决定默认排序（框架默认带主键 tie-breaker）。
 *   4) 项数上限 `SORT_QUERY_MAX_ITEMS`，超出即 400 —— 多字段排序对索引不友好，需显式放开。
 *   5) 重复字段按「后者覆盖前者」处理，与 query 参数语义一致（避免同字段两个方向导致方言差异）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/db
 */

import { BizError, ErrorCode } from '@fw/core';
import type { Sort, SortDir } from './repository.interface.js';

/** 排序字段白名单：HTTP 参数名（snake_case）→ 实体字段名（camelCase） */
export type SortFieldMap = Readonly<Record<string, string>>;

/** 单个排序项（含原始参数名，供回显与审计） */
export interface ParsedSortItem {
  /** HTTP 传入的原始参数名（snake_case） */
  param: string;
  /** 映射后的实体字段名 */
  field: string;
  /** 方向 */
  direction: SortDir;
}

/** 单次请求允许的最大排序字段数（超出即 400） */
export const SORT_QUERY_MAX_ITEMS = 5;

/**
 * 解析 `sort` 查询串为排序项数组。
 *
 * @param raw     原始查询串，如 `created_at:desc,id:asc`；`undefined` / 空串 → 空数组
 * @param fieldMap 字段白名单（snake_case → 实体字段名）
 * @throws BizError(400) 未知字段 / 非法方向 / 超出项数上限
 */
export function parseSortItems(raw: string | undefined | null, fieldMap: SortFieldMap): ParsedSortItem[] {
  const source = (raw ?? '').trim();
  if (source === '') return [];

  const segments = source
    .split(',')
    .map((segment) => segment.trim())
    .filter((segment) => segment !== '');

  if (segments.length === 0) return [];
  if (segments.length > SORT_QUERY_MAX_ITEMS) {
    throw new BizError(ErrorCode.BAD_REQUEST, `sort 字段数超出上限（最多 ${SORT_QUERY_MAX_ITEMS} 个）`);
  }

  const items: ParsedSortItem[] = [];
  const seen = new Map<string, number>();

  for (const segment of segments) {
    const separator = segment.indexOf(':');
    const param = (separator === -1 ? segment : segment.slice(0, separator)).trim();
    const rawDirection = (separator === -1 ? '' : segment.slice(separator + 1)).trim();

    if (param === '') {
      throw new BizError(ErrorCode.BAD_REQUEST, 'sort 字段名不能为空');
    }
    const field = fieldMap[param];
    if (!field) {
      throw new BizError(ErrorCode.BAD_REQUEST, `sort 字段不支持：${param}`);
    }

    let direction: SortDir = 'asc';
    if (rawDirection !== '') {
      const lowered = rawDirection.toLowerCase();
      if (lowered !== 'asc' && lowered !== 'desc') {
        throw new BizError(ErrorCode.BAD_REQUEST, `sort 方向只能为 asc 或 desc：${param}`);
      }
      direction = lowered;
    }

    const item: ParsedSortItem = { param, field, direction };
    const previous = seen.get(field);
    // 同字段重复：后者覆盖前者（就地替换，保持首次出现的位置）
    if (previous === undefined) {
      seen.set(field, items.length);
      items.push(item);
    } else {
      items[previous] = item;
    }
  }

  return items;
}

/**
 * 解析 `sort` 查询串为框架排序结构（可直接传给 Repository.page / list）。
 *
 * @returns 无有效排序项时返回 `undefined`（调用方据此使用默认排序）
 */
export function parseSortQuery<T extends object>(
  raw: string | undefined | null,
  fieldMap: SortFieldMap,
): Sort<T> | undefined {
  const items = parseSortItems(raw, fieldMap);
  if (items.length === 0) return undefined;

  const sort: Record<string, SortDir> = {};
  for (const item of items) sort[item.field] = item.direction;
  return sort as Sort<T>;
}
