/*
 * @file 列表查询参数解析单测（BUG-15：sort 契约）
 * @description 覆盖 api-spec §1.5 的 `sort=<snake_case 字段>:<asc|desc>` 约定：
 *   未传/空串/纯空白/纯逗号 → undefined；单字段与多字段映射；方向大小写不敏感与缺省 asc；
 *   未知字段、非法方向、超出字段数上限 → BizError(400)；同字段重复后者覆盖；空白项忽略。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/db
 */

import { describe, expect, it } from 'vitest';
import { BizError, ErrorCode } from '@fw/core';
import { SORT_QUERY_MAX_ITEMS, parseSortItems, parseSortQuery } from '../query-params.js';

/** 用户列表的排序白名单（snake_case → 实体字段名） */
const USER_SORT = {
  id: 'id',
  username: 'username',
  created_at: 'createdAt',
  updated_at: 'updatedAt',
} as const;

/** 取 BizError 的业务码；非 BizError 返回 null（避免断言写成永远通过） */
function bizCode(error: unknown): number | null {
  return error instanceof BizError ? error.code : null;
}

describe('parseSortQuery（sort 查询串 → 框架排序结构）', () => {
  it('未传 / 空串 / 纯空白 / 纯逗号 → undefined（交由调用方使用默认排序）', () => {
    expect(parseSortQuery(undefined, USER_SORT)).toBeUndefined();
    expect(parseSortQuery(null, USER_SORT)).toBeUndefined();
    expect(parseSortQuery('', USER_SORT)).toBeUndefined();
    expect(parseSortQuery('   ', USER_SORT)).toBeUndefined();
    expect(parseSortQuery(',,,', USER_SORT)).toBeUndefined();
  });

  it('单字段 → 映射为实体字段名', () => {
    expect(parseSortQuery('created_at:desc', USER_SORT)).toEqual({ createdAt: 'desc' });
  });

  it('多字段 → 全部映射且保持声明顺序', () => {
    expect(parseSortQuery('created_at:desc,id:asc', USER_SORT)).toEqual({ createdAt: 'desc', id: 'asc' });
  });

  it('方向大小写不敏感', () => {
    expect(parseSortQuery('created_at:DESC', USER_SORT)).toEqual({ createdAt: 'desc' });
    expect(parseSortQuery('created_at:Desc', USER_SORT)).toEqual({ createdAt: 'desc' });
  });

  it('方向缺省为 asc（含仅写冒号的情形）', () => {
    expect(parseSortQuery('username', USER_SORT)).toEqual({ username: 'asc' });
    expect(parseSortQuery('username:', USER_SORT)).toEqual({ username: 'asc' });
  });

  it('忽略多余逗号与首尾空白', () => {
    expect(parseSortQuery(' created_at:desc , , id:asc ', USER_SORT)).toEqual({ createdAt: 'desc', id: 'asc' });
  });

  it('同字段重复 → 后者覆盖前者，且保持首次出现的位置', () => {
    const items = parseSortItems('created_at:desc,username:asc,created_at:asc', USER_SORT);
    expect(items.map((item) => `${item.param}:${item.direction}`)).toEqual(['created_at:asc', 'username:asc']);
  });

  it('返回项含原始参数名（供回显与审计）', () => {
    expect(parseSortItems('created_at:desc', USER_SORT)).toEqual([
      { param: 'created_at', field: 'createdAt', direction: 'desc' },
    ]);
  });

  it('未知字段 → BizError(400)，不静默忽略', () => {
    let caught: unknown;
    try {
      parseSortQuery('password:desc', USER_SORT);
    } catch (error) {
      caught = error;
    }
    expect(bizCode(caught)).toBe(ErrorCode.BAD_REQUEST);
  });

  it('非法方向 → BizError(400)', () => {
    let caught: unknown;
    try {
      parseSortQuery('created_at:up', USER_SORT);
    } catch (error) {
      caught = error;
    }
    expect(bizCode(caught)).toBe(ErrorCode.BAD_REQUEST);
  });

  it('空字段名（如 ":desc"）→ BizError(400)', () => {
    let caught: unknown;
    try {
      parseSortQuery(':desc', USER_SORT);
    } catch (error) {
      caught = error;
    }
    expect(bizCode(caught)).toBe(ErrorCode.BAD_REQUEST);
  });

  it('超出字段数上限 → BizError(400)', () => {
    const overflow = Array.from({ length: SORT_QUERY_MAX_ITEMS + 1 }, () => 'created_at:asc').join(',');
    let caught: unknown;
    try {
      parseSortQuery(overflow, USER_SORT);
    } catch (error) {
      caught = error;
    }
    expect(bizCode(caught)).toBe(ErrorCode.BAD_REQUEST);
  });

  it('恰好等于字段数上限 → 通过', () => {
    const exact = ['id:asc', 'username:asc', 'created_at:asc', 'updated_at:asc', 'id:desc'].slice(
      0,
      SORT_QUERY_MAX_ITEMS,
    );
    expect(() => parseSortQuery(exact.join(','), USER_SORT)).not.toThrow();
  });
});
