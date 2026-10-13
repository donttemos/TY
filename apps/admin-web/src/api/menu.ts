/*
 * @file 菜单 API（C-06 契约 / API 规格 §3.5）
 * @description 菜单树查询（管理页配置用）与菜单维护 CRUD。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { MenuManageItem, MenuUpsertInput } from './types';

/** 完整菜单（扁平列表，管理页自行渲染树） */
export function fetchMenuTree(): Promise<MenuManageItem[]> {
  return request.get<MenuManageItem[]>('/menus/tree');
}

/** 新建菜单 */
export function createMenu(data: MenuUpsertInput): Promise<MenuManageItem> {
  return request.post<MenuManageItem>('/menus', data);
}

/** 更新菜单 */
export function updateMenu(id: string, data: MenuUpsertInput): Promise<MenuManageItem> {
  return request.put<MenuManageItem>(`/menus/${id}`, data);
}

/** 删除菜单（有子菜单时拒绝） */
export function deleteMenu(id: string): Promise<{ id: string }> {
  return request.delete(`/menus/${id}`);
}
