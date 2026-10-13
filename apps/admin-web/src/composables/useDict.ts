/*
 * @file useDict 组合式函数
 * @description 字典消费入口（PRD-005 FR-07）：按编码取字典项，页面不硬编码枚举。
 *   首次调用触发加载并缓存（store 级）；字典管理页维护后 invalidate 失效。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/composables
 */

import { computed, ref, watch, type Ref } from 'vue';
import { useDictStore } from '@/store/dict';
import type { DictItem } from '@/api/types';

/**
 * 消费指定编码的字典
 * @param code 字典编码（支持 ref，编码变化自动重新加载）
 * @returns items 字典项、loading 加载态、labelOf 按值取标签
 */
export function useDict(code: string | Ref<string>): {
  items: Ref<DictItem[]>;
  loading: Ref<boolean>;
  labelOf: (value: string | number) => string;
} {
  const store = useDictStore();
  const codeRef = typeof code === 'string' ? ref(code) : code;
  const loading = ref(false);

  async function load(): Promise<void> {
    loading.value = true;
    try {
      await store.load(codeRef.value);
    } finally {
      loading.value = false;
    }
  }

  // 首次与编码变化均触发加载
  watch(codeRef, () => void load(), { immediate: true });

  return {
    items: computed(() => store.items(codeRef.value)),
    loading,
    labelOf: (value: string | number) => store.labelOf(codeRef.value, value),
  };
}
