/*
 * @file CrudTable 服务端排序参数构造单测（BUG-15）
 * @description 覆盖 `sort=<snake_case 字段>:<asc|desc>` 的构造规则：驼峰转 snake_case、
 *   `sortField` 显式覆盖、取消排序返回 null、方向映射，以及「已是 snake_case 的字段不被二次转换」。
 * @author donttemo
 * @created 2026-10-14
 * @module admin-web/components
 */

import { describe, expect, it } from 'vitest';
import { buildSortParam, resolveSortField, toSnakeCase } from '../sort';

/** 测试用列配置（含一个「展示字段 ≠ 排序字段」的用例） */
const COLUMNS = [
  { prop: 'username' },
  { prop: 'createdAt' },
  { prop: 'lastLoginAt' },
  { prop: 'sequence', sortField: 'id' },
];

describe('toSnakeCase', () => {
  it('驼峰转 snake_case', () => {
    expect(toSnakeCase('createdAt')).toBe('created_at');
    expect(toSnakeCase('lastLoginAt')).toBe('last_login_at');
  });

  it('已是 snake_case 的字符串保持不变（不产生双下划线）', () => {
    expect(toSnakeCase('created_at')).toBe('created_at');
    expect(toSnakeCase('id')).toBe('id');
  });
});

describe('resolveSortField', () => {
  it('缺省由 prop 转 snake_case', () => {
    expect(resolveSortField('createdAt', COLUMNS)).toBe('created_at');
  });

  it('列配置 sortField 优先（展示字段 ≠ 排序字段）', () => {
    expect(resolveSortField('sequence', COLUMNS)).toBe('id');
  });

  it('列未在配置中时仍返回转换结果（字段合法性交由后端白名单裁决，前端不复制白名单）', () => {
    expect(resolveSortField('unknownField', COLUMNS)).toBe('unknown_field');
  });
});

describe('buildSortParam', () => {
  it('升序 / 降序映射为 asc / desc', () => {
    expect(buildSortParam('createdAt', 'ascending', COLUMNS)).toBe('created_at:asc');
    expect(buildSortParam('createdAt', 'descending', COLUMNS)).toBe('created_at:desc');
  });

  it('取消排序返回 null（组件据此从查询参数中移除 sort）', () => {
    expect(buildSortParam('createdAt', null, COLUMNS)).toBeNull();
  });

  it('sortField 覆盖在最终查询串中生效', () => {
    expect(buildSortParam('sequence', 'descending', COLUMNS)).toBe('id:desc');
  });

  it('多字段场景由后端拼接（前端只发单字段），故输出中不含逗号', () => {
    expect(buildSortParam('username', 'ascending', COLUMNS)).not.toContain(',');
  });
});
