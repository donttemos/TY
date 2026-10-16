/*
 * @file CrudTable 服务端排序参数构造（BUG-15）
 * @description 把列 prop（通常 camelCase）与 el-table 的排序方向，转换为 api-spec §1.5 约定的
 *   `sort=<snake_case 字段>:<asc|desc>` 查询值。抽成纯函数是为了可被单测直接断言
 *   （原先内联在组件事件处理里，只能靠挂载组件间接验证）。
 *
 *   规则：
 *   1) 列配置给了 `sortField` 则优先 —— 用于「展示字段 ≠ 排序字段」的场景（如按 id 排序但展示序号）；
 *   2) 否则把 prop 的驼峰转 snake_case（`createdAt` → `created_at`；本就是 snake_case 的保持不变）；
 *   3) `order` 为 null（用户取消排序）时返回 null，组件据此把 sort 从查询参数中移除；
 *   4) 除方向外不做任何校验：**字段合法性由后端白名单裁决**（未知字段 400）。
 *      前端不复制一份白名单，否则两处白名单不同步就会出现「前端放过、后端拒绝」的假成功。
 * @author donttemo
 * @created 2026-10-14
 * @module __APP_NAME__-web/components
 */

/** 排序所需的列最小结构（避免与 CrudColumn 形成循环依赖） */
export interface SortableColumn {
  /** 字段名（与接口返回字段一致） */
  prop: string;
  /** 服务端排序字段名（snake_case），配置后优先于 prop 转换 */
  sortField?: string;
}

/** el-table 的排序方向 */
export type TableSortOrder = 'ascending' | 'descending' | null;

/** 驼峰转 snake_case（已是 snake_case 的字符串原样返回） */
export function toSnakeCase(input: string): string {
  return input.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
}

/** 解析某列的**服务端**排序字段名：优先列配置的 sortField，否则由 prop 转 snake_case */
export function resolveSortField(prop: string, columns: readonly SortableColumn[]): string {
  const column = columns.find((item) => item.prop === prop);
  if (column?.sortField) return column.sortField;
  return toSnakeCase(prop);
}

/**
 * 构造 sort 查询值
 *
 * @param prop    触发排序的列 prop（el-table `sort-change` 事件载荷）
 * @param order   el-table 排序方向；null 表示取消排序
 * @param columns 列配置（用于查 sortField 覆盖）
 * @returns `字段:方向`（如 `created_at:desc`）；取消排序时返回 null
 */
export function buildSortParam(
  prop: string,
  order: TableSortOrder,
  columns: readonly SortableColumn[],
): string | null {
  if (!order) return null;
  return `${resolveSortField(prop, columns)}:${order === 'ascending' ? 'asc' : 'desc'}`;
}
