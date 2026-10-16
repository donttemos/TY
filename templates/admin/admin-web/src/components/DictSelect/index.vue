<!--
 * @file 字典下拉框
 * @description 由 useDict(code) 消费字典项（PRD-005 FR-07），禁止硬编码枚举；
 *   选项标签 / 值取自字典项，未加载完成时下拉显示加载态。
 * @author donttemo
 * @created 2026-10-13
 * @module __APP_NAME__-web/components
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useDict } from '@/composables/useDict';

const props = defineProps<{
  /** 字典编码 */
  dictCode: string;
  /** 绑定值（类型由使用方模型决定，组件内仅透传，故放宽为 unknown） */
  modelValue?: unknown;
  placeholder?: string;
  clearable?: boolean;
  disabled?: boolean;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: string | number | null): void;
}>();

// 编码可能动态变化（如切换分类），useDict 内部 watch 处理
const code = computed(() => props.dictCode);
const { items, loading } = useDict(code);

/** el-select 的标量绑定值：非标量（null / undefined / 对象）一律按「未选择」处理 */
const selectValue = computed<string | number>(() => {
  const value = props.modelValue;
  return typeof value === 'string' || typeof value === 'number' ? value : '';
});
</script>

<template>
  <el-select
    :model-value="selectValue"
    :placeholder="placeholder ?? '请选择'"
    :clearable="clearable ?? true"
    :disabled="disabled"
    :loading="loading"
    @update:model-value="(value: string | number | null) => emit('update:modelValue', value)"
  >
    <el-option v-for="item in items" :key="item.value" :label="item.label" :value="item.value" />
  </el-select>
</template>
