/*
 * @file 字典 API（C-06 契约 / API 规格 §3.6）
 * @description 字典分类与项维护；GET /dict/:code 供 useDict 消费（登录后可用，避免枚举硬编码）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { DictCategory, DictItem } from './types';

/** 分类列表 */
export function fetchDictCategories(): Promise<DictCategory[]> {
  return request.get<DictCategory[]>('/dict/categories');
}

/** 新建分类 */
export function createDictCategory(data: { code: string; name: string; remark?: string }): Promise<DictCategory> {
  return request.post<DictCategory>('/dict/categories', data);
}

/** 更新分类 */
export function updateDictCategory(id: string, data: { name?: string; remark?: string }): Promise<DictCategory> {
  return request.put<DictCategory>(`/dict/categories/${id}`, data);
}

/** 删除分类（连带删除其下字典项） */
export function deleteDictCategory(id: string): Promise<{ id: string }> {
  return request.delete(`/dict/categories/${id}`);
}

/** 字典项列表（按分类） */
export function fetchDictItems(categoryId: string): Promise<DictItem[]> {
  return request.get<DictItem[]>('/dict/items', { params: { category_id: categoryId } });
}

/** 新建字典项 */
export function createDictItem(data: Omit<DictItem, 'id'>): Promise<DictItem> {
  return request.post<DictItem>('/dict/items', data);
}

/** 更新字典项 */
export function updateDictItem(id: string, data: Partial<Omit<DictItem, 'id'>>): Promise<DictItem> {
  return request.put<DictItem>(`/dict/items/${id}`, data);
}

/** 删除字典项 */
export function deleteDictItem(id: string): Promise<{ id: string }> {
  return request.delete(`/dict/items/${id}`);
}

/** 按分类编码取字典项（useDict 消费入口） */
export function fetchDictByCode(code: string): Promise<DictItem[]> {
  return request.get<DictItem[]>(`/dict/${code}`);
}
