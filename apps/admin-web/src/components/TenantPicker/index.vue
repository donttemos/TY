<!--
 * @file TenantPicker —— 可搜索租户选择器（M14/PRD-014 FR-14-08/FR-14-10）
 * @description 远程搜索租户（复用 /tenants 管理面查询：keyword 匹配编码/名称），替代 SaaS 运营页
 *   手输租户 ID（PRD-014 U-14-5/租户上下文目标）：选项展示「名称（编码）」，值为租户 ID，
 *   支持 clearable；跨页携带 tenantId 由路由 query 承载（OQ-14-4 默认）。
 * @author donttemo
 * @created 2026-10-20
 * @module admin-web/components
-->

<script setup lang="ts">
import { ref } from 'vue';
import { fetchTenants } from '@/api/tenant';
import type { TenantView } from '@/api/types';
import { BizError, describeBizError } from '@/utils/biz-error';

const props = defineProps<{
  modelValue: string;
  placeholder?: string;
  /** 选择器宽度（默认 260px） */
  width?: string;
}>();

const emit = defineEmits<{
  (event: 'update:modelValue', value: string): void;
}>();

const options = ref<TenantView[]>([]);
const searching = ref(false);

/** 远程搜索：keyword 空时取第一页（提供常见租户候选） */
async function onSearch(keyword: string): Promise<void> {
  searching.value = true;
  try {
    const page = await fetchTenants({ keyword: keyword || undefined, page: 1, pageSize: 20 });
    options.value = page.items;
  } catch (e) {
    // 搜索失败静默保留既有候选（错误文案由请求层 toast；选择器不应阻断页面）
    if (e instanceof BizError) describeBizError(e);
  } finally {
    searching.value = false;
  }
}

function onChange(value: string): void {
  emit('update:modelValue', value);
}
</script>

<template>
  <el-select
    :model-value="modelValue"
    filterable
    remote
    clearable
    reserve-keyword
    :remote-method="onSearch"
    :loading="searching"
    :placeholder="placeholder ?? '搜索租户（编码 / 名称）'"
    :style="{ width: width ?? '260px' }"
    @change="onChange"
    @focus="options.length === 0 && onSearch('')"
  >
    <el-option v-for="t in options" :key="t.id" :value="t.id" :label="`${t.name}（${t.code}）`">
      <span>{{ t.name }}</span>
      <span class="tp-code">{{ t.code }}</span>
    </el-option>
  </el-select>
</template>

<style scoped>
.tp-code {
  float: right;
  color: var(--el-text-color-secondary);
  font-size: 12px;
}
</style>
