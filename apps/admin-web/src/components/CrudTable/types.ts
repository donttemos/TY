/*
 * @file CrudTable 类型定义（PRD-005 FR-09）
 * @description 标准列表页四要素（原型 §6）：columns / searchForm / api / permission；
 *   formFields 可选，提供后组件内置新增 / 编辑弹窗（创建走 POST、编辑走 GET+PUT）。
 *   新增业务列表页只需一段配置（AC：代码 ≤ 80 行）。
 *   permission 前缀推导的 `<前缀>:create|update|delete|export` 可用 permissionActions 覆盖：
 *   后端权限码并非总是「前端名 + 标准动作」（如字典只有 dict:read / dict:write），
 *   只写 permission 会让按钮因权限码不存在而永不渲染。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-14 donttemo 新增 permissionActions 覆盖项与 FormField.multiple（多选下拉，
 *   修复 roleIds 这类「值为数组」的字段被单选框渲染导致回显为空、提交成字符串的缺陷）
 * @module admin-web/components
 */

import type { FormItemRule } from 'element-plus';

/** 表格列配置 */
export interface CrudColumn {
  /** 字段名（与接口返回字段一致） */
  prop: string;
  /** 列标题 */
  label: string;
  /** 列宽 */
  width?: string | number;
  /** 最小列宽 */
  minWidth?: string | number;
  /** 对齐 */
  align?: 'left' | 'center' | 'right';
  /** 是否固定列 */
  fixed?: 'left' | 'right' | boolean;
  /** 超出省略 */
  showOverflowTooltip?: boolean;
  /** 排序（服务端排序，透传 sort 参数） */
  sortable?: boolean;
  /**
   * 服务端排序字段名（BUG-15）
   *
   * api-spec §1.5 约定 `sort=<snake_case 字段>:<asc|desc>`，而列 prop 通常是 camelCase；
   * 未配置时由 prop 自动转 snake_case（`createdAt` → `created_at`）；
   * 若某列需要按「非展示字段」排序（如按 id 排序但展示序号），在此显式声明。
   */
  sortField?: string;
  /** 自定义单元格插槽名（默认取 prop） */
  slot?: string;
  /** 列设置默认隐藏（用户可自行打开） */
  defaultHidden?: boolean;
}

/** 查询区字段配置 */
export interface SearchField {
  prop: string;
  label: string;
  type: 'input' | 'select' | 'date' | 'daterange';
  /** 静态选项（type=select） */
  options?: { label: string; value: string | number }[];
  /** 字典编码（type=select 且走字典，优先级高于 options） */
  dictCode?: string;
  placeholder?: string;
  /** 栅格占位（24 分栏，默认 6） */
  span?: number;
  defaultValue?: unknown;
}

/** 表单字段配置（内置弹窗） */
export interface FormField {
  prop: string;
  label: string;
  type: 'input' | 'textarea' | 'number' | 'password' | 'select' | 'radio' | 'switch' | 'date' | 'datetime' | 'dict-select';
  /** 静态选项 */
  options?: { label: string; value: string | number | boolean }[];
  /** 字典编码（dict-select） */
  dictCode?: string;
  placeholder?: string;
  /** 多选（type=select，值为数组；roleIds / permissionIds 等关联字段必须开启） */
  multiple?: boolean;
  /** 栅格占位（24 分栏，默认 12） */
  span?: number;
  /** 校验规则（el-form rules） */
  rules?: FormItemRule[];
  /** 新建时禁用（如编码类字段仅创建可改） */
  disabledOnEdit?: boolean;
  /** 编辑时隐藏（如密码仅创建可填） */
  hiddenOnEdit?: boolean;
  /** 新建时隐藏（如创建时间仅编辑可见） */
  hiddenOnCreate?: boolean;
}

/** 查询模型（prop → 值） */
export type SearchModel = Record<string, unknown>;

/** 表单模型 */
export type FormModel = Record<string, unknown>;

/** 分页查询结果（与后端 PageResult 一致） */
export interface PagePayload<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}
