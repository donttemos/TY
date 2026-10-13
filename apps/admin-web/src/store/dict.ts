/*
 * @file 字典状态store（Pinia）
 * @description useDict 的缓存层：按字典编码缓存字典项，避免枚举硬编码（PRD-005 FR-07）。
 *   同一编码全局只拉一次；字典管理页维护后调用 invalidate 主动失效。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import * as dictApi from '@/api/dict';
import type { DictItem } from '@/api/types';

export const useDictStore = defineStore('dict', () => {
  /** 编码 → 字典项 */
  const cache = ref<Record<string, DictItem[]>>({});
  /** 加载中的编码（防并发重复请求） */
  const pending = new Set<string>();

  /** 取字典项（带缓存；未命中时拉接口） */
  async function load(code: string): Promise<DictItem[]> {
    const hit = cache.value[code];
    if (hit) return hit;
    if (pending.has(code)) {
      // 等待已在途的请求完成后再读缓存
      await new Promise((resolve) => setTimeout(resolve, 50));
      return cache.value[code] ?? [];
    }
    pending.add(code);
    try {
      const items = await dictApi.fetchDictByCode(code);
      cache.value = { ...cache.value, [code]: items };
      return items;
    } finally {
      pending.delete(code);
    }
  }

  /** 同步读缓存（未加载返回空数组；渲染前应确保已 load） */
  function items(code: string): DictItem[] {
    return cache.value[code] ?? [];
  }

  /** 主动失效（字典维护后调用） */
  function invalidate(code?: string): void {
    if (code) {
      const next = { ...cache.value };
      delete next[code];
      cache.value = next;
    } else {
      cache.value = {};
    }
  }

  /** 按值取标签（StatusTag / 表格回显用） */
  function labelOf(code: string, value: string | number): string {
    const item = items(code).find((i) => i.value === String(value));
    return item?.label ?? String(value);
  }

  return { cache, load, items, invalidate, labelOf };
});
