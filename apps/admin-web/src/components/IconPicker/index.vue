<!--
 * @file 菜单图标选择器
 * @description E-06：菜单图标由自由文本改为从 icon-map 登记表中点选。手打未登记的名字不会报错，
 *   只会在侧边栏渲染时静默回退默认图标（假成功）；从登记表选择从根上消除该类错误。
 *   值仍是图标名字符串（MenuUpsertInput.icon 契约不变），仅交互形式变化。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/components
-->

<script setup lang="ts">
import { computed, ref } from 'vue';
import { ElButton, ElIcon, ElInput, ElPopover, ElTooltip } from 'element-plus';
import { ICON_NAMES, resolveIcon } from '@/layout/icon-map';

const props = defineProps<{ modelValue?: string | null }>();

const emit = defineEmits<{ (e: 'update:modelValue', value: string): void }>();

const keyword = ref('');

/** 当前值对应的图标组件（展示在输入框内） */
const resolved = computed(() => resolveIcon(props.modelValue ?? null));

/** 按关键字过滤登记名（大小写不敏感的包含匹配） */
const filtered = computed(() => {
  const kw = keyword.value.trim().toLowerCase();
  return kw ? ICON_NAMES.filter((name) => name.includes(kw)) : ICON_NAMES;
});

function pick(name: string): void {
  emit('update:modelValue', name);
}

function clear(): void {
  emit('update:modelValue', '');
}
</script>

<template>
  <el-popover placement="bottom-start" :width="380" trigger="click">
    <template #reference>
      <el-input
        :model-value="props.modelValue ?? ''"
        placeholder="点击选择图标"
        readonly
        data-test="icon-picker-input"
      >
        <template #prefix>
          <el-icon v-if="props.modelValue"><component :is="resolved" /></el-icon>
        </template>
      </el-input>
    </template>

    <div class="fw-icon-picker">
      <el-input v-model="keyword" placeholder="搜索图标名（如 user）" size="small" clearable />
      <div class="fw-icon-picker__grid">
        <el-tooltip v-for="name in filtered" :key="name" :content="name" placement="top" :show-after="200">
          <button
            type="button"
            class="fw-icon-picker__cell"
            :class="{ 'is-active': name === props.modelValue }"
            :data-test="`icon-cell-${name}`"
            @click="pick(name)"
          >
            <el-icon :size="18"><component :is="resolveIcon(name)" /></el-icon>
          </button>
        </el-tooltip>
      </div>
      <div v-if="filtered.length === 0" class="fw-icon-picker__empty">无匹配图标</div>
      <div v-if="props.modelValue" class="fw-icon-picker__footer">
        <el-button text type="danger" size="small" data-test="icon-picker-clear" @click="clear">清除图标</el-button>
      </div>
    </div>
  </el-popover>
</template>

<style scoped>
.fw-icon-picker__grid {
  display: grid;
  grid-template-columns: repeat(6, 1fr);
  gap: 6px;
  margin-top: 8px;
  max-height: 220px;
  overflow-y: auto;
}

.fw-icon-picker__cell {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 40px;
  border: 1px solid var(--el-border-color-lighter);
  border-radius: 6px;
  background: var(--el-fill-color-blank);
  color: var(--el-text-color-regular);
  cursor: pointer;
  transition: border-color 0.15s, color 0.15s, background-color 0.15s;
}

.fw-icon-picker__cell:hover {
  border-color: var(--el-color-primary);
  color: var(--el-color-primary);
}

.fw-icon-picker__cell.is-active {
  border-color: var(--el-color-primary);
  background: var(--el-color-primary-light-9);
  color: var(--el-color-primary);
}

.fw-icon-picker__empty {
  padding: 16px 0;
  text-align: center;
  color: var(--el-text-color-placeholder);
  font-size: 13px;
}

.fw-icon-picker__footer {
  margin-top: 8px;
  text-align: right;
}
</style>
