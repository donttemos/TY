<!--
 * @file 字典下拉框
 * @description 由 useDict(code) 消费字典项（PRD-005 FR-07），禁止硬编码枚举；
 *   选项标签 / 值取自字典项，未加载完成时下拉显示加载态。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/components
-->

<script setup lang="ts">
import { computed } from 'vue';
import { useDict } from '@/composables/useDict';

const props = defineProps<{
  /** 字典编码 */
  dictCode: string;
  modelValue: string | number | null | undefined;
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
</script>

<template>
  <el-select
    :model-value="modelValue"
    :placeholder="placeholder ?? '请选择'"
    :clearable="clearable ?? true"
    :disabled="disabled"
    :loading="loading"
    @update:model-value="(value: string | number | null) => emit('update:modelValue', value)"
  >
    <el-option v-for="item in items" :key="item.value" :label="item.label" :value="item.value" />
  </el-select>
</template>
