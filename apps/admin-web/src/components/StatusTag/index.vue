<!--
 * @file 状态标签
 * @description 状态统一用标签展示（原型 §6）；优先取字典项 color（useDict 消费），
 *   字典缺失时回退到 Element Plus tag 类型推断；同时提供文字，不只靠颜色区分（无障碍）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/components
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useDict } from '@/composables/useDict';

const props = defineProps<{
  /** 状态值 */
  value: string | number | null | undefined;
  /** 字典编码（提供时按字典渲染标签与颜色） */
  dictCode?: string;
}>();

const code = computed(() => props.dictCode ?? '');
const { items, labelOf } = useDict(code);

/** 颜色：字典 color → 值推断 */
const color = computed<'primary' | 'success' | 'warning' | 'danger' | 'info'>(() => {
  if (props.dictCode) {
    const item = items.value.find((i) => i.value === String(props.value));
    if (item?.color) return item.color;
  }
  // 值推断回退：0/禁用 → danger，其余按 success
  return String(props.value) === '0' ? 'danger' : 'success';
});

const label = computed(() => (props.dictCode ? labelOf(props.value ?? '') : String(props.value ?? '—')));
</script>

<template>
  <el-tag :type="color" size="small" effect="light">{{ label }}</el-tag>
</template>
