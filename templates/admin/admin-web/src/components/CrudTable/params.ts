/*
 * @file CrudTable 查询参数构造（列表 / 导出共用同一份合并逻辑）
 * @description 列表与导出必须是「同一个筛选条件下的同一批数据」，因此参数构造只有这一处：
 *   ① 固定 filters（页面级筛选器，如平台审计的租户选择）先铺底；
 *   ② 查询区经 transformSearch 变换后覆盖（风险等级这类「不落库的展示维度」在变换里展开成接口参数）；
 *   ③ 剔除空值（空串 / null / undefined / 空数组都表示「未填写」）。
 *   早期 handleExport 只发查询区、不合并 filters：选了筛选器后列表被收窄、导出仍是全量范围。
 *   纯函数（不读组件状态）便于单测直接锁定合并语义。
 * @author donttemo
 * @created 2026-10-21
 * @module __APP_NAME__-web/components
 */

import type { SearchModel } from './types';

/** 空值判定：空串 / null / undefined / 空数组一律视为「未填写」，不进入请求参数 */
function isBlank(value: unknown): boolean {
  return value === '' || value === null || value === undefined || (Array.isArray(value) && value.length === 0);
}

/** 参数构造入参 */
export interface SearchParamOptions {
  /** 固定查询条件（不出现在查询区，如平台审计的 `tenant_id`） */
  filters?: SearchModel;
  /** 查询区原始值 */
  search: SearchModel;
  /** 查询条件变换（可选；在合并 filters 之前执行，只作用于查询区，与列表历史行为一致） */
  transformSearch?: (search: SearchModel) => SearchModel;
}

/**
 * 构造查询参数（不含分页 / 排序，由调用方按需追加）
 *
 * @param options 见 SearchParamOptions
 * @returns 已合并固定筛选、已变换、已剔除空值的新对象（不修改入参）
 */
export function buildSearchParams(options: SearchParamOptions): SearchModel {
  const { filters, search, transformSearch } = options;
  // transformSearch 拿到的是副本：变换函数内 delete / 赋值不得污染查询区模型
  const transformed = transformSearch ? transformSearch({ ...search }) : { ...search };
  // 固定 filters 铺底、查询区覆盖：同名键以用户显式填写的查询区值为准
  const params: SearchModel = { ...(filters ?? {}), ...transformed };
  for (const [key, value] of Object.entries(params)) {
    if (isBlank(value)) delete params[key];
  }
  return params;
}
