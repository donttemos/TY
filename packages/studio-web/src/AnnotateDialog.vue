<!--
  @file AI 补标注（PRD-017 FR-17-28 补充）
  @description 扫描 schema 里缺 `///` 注释的模型与字段，让模型给出中文标注建议；
    应用只写入**本地草稿**，仍需「预览变更 → 写入 schema」。不修改已有注释。
  @author donttemo
  @created 2026-10-28
  @module studio-web
-->
<template>
  <div class="mask" @click.self="$emit('close')">
    <section class="dialog">
      <header class="head">
        <h2>AI 补标注</h2>
        <button class="close" title="关闭" @click="$emit('close')">×</button>
      </header>

      <p v-if="loading" class="hint">正在扫描缺注释的模型与字段，请稍候（取决于模型速度）…</p>
      <p v-else-if="error" class="msg error">{{ error }}</p>
      <p v-else-if="result?.message" class="hint">{{ result.message }}</p>

      <template v-if="result && !loading && !error">
        <div class="summary">
          <span class="pill num">候选 {{ result.candidates.models }} 模型</span>
          <span class="pill num">候选 {{ result.candidates.fields }} 字段</span>
          <span class="pill num accent">建议 {{ result.suggestions.models.length + result.suggestions.fields.length }} 条</span>
        </div>

        <div v-if="result.suggestions.models.length > 0" class="group">
          <p class="kicker">模型标注</p>
          <ul>
            <li v-for="item in result.suggestions.models" :key="item.name">
              <code>{{ item.name }}</code>
              <span class="arrow">→</span>
              <span class="label">{{ item.label }}</span>
            </li>
          </ul>
        </div>

        <div v-if="result.suggestions.fields.length > 0" class="group">
          <p class="kicker">字段标注</p>
          <ul class="fields">
            <li v-for="item in result.suggestions.fields" :key="`${item.model}.${item.name}`">
              <span class="model">{{ item.model }}</span>
              <code>{{ item.name }}</code>
              <span class="arrow">→</span>
              <span class="label">{{ item.label }}</span>
            </li>
          </ul>
        </div>

        <p class="hint">只填入当前草稿，已有注释不会被覆盖；确认后再点「预览变更 → 写入 schema」。</p>

        <div class="actions">
          <button class="primary" :disabled="total === 0" @click="apply">应用 {{ total }} 条标注</button>
          <button @click="$emit('close')">取消</button>
          <button class="ghost" :disabled="loading" @click="scan">重新扫描</button>
        </div>
      </template>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import { annotateSchema, type AnnotationSuggestions } from './api';

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'applied', payload: { models: { name: string; label: string }[]; fields: { model: string; name: string; label: string }[] }): void;
}>();

const loading = ref(true);
const error = ref('');
const result = ref<AnnotationSuggestions | null>(null);

const total = computed(() =>
  result.value === null
    ? 0
    : result.value.suggestions.models.length + result.value.suggestions.fields.length,
);

/** 扫描（只读，不写盘） */
async function scan(): Promise<void> {
  loading.value = true;
  error.value = '';
  result.value = null;
  try {
    result.value = await annotateSchema();
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    loading.value = false;
  }
}

/** 应用到本地草稿 */
function apply(): void {
  if (!result.value) return;
  emit('applied', result.value.suggestions);
  emit('close');
}

onMounted(() => {
  void scan();
});
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 28%);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 10vh;
  z-index: 50;
}
.dialog {
  width: min(560px, calc(100vw - 32px));
  max-height: 76vh;
  overflow: auto;
  background: var(--surface);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-lg);
  padding: var(--sp-4);
  box-shadow: var(--shadow-2);
}
.head {
  display: flex;
  align-items: center;
  margin-bottom: var(--sp-2);
}
.head h2 {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  flex: 1;
}
.close {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: var(--text-faint);
  height: 28px;
}
.hint {
  margin: var(--sp-2) 0 0;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.7;
}
.msg.error {
  margin: 0;
  padding: 8px 10px;
  border-radius: var(--r-sm);
  background: #fcebeb;
  color: #a32d2d;
  font-size: 12px;
}
.summary {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin: var(--sp-2) 0;
}
.group {
  margin-top: var(--sp-2);
}
.group .kicker {
  margin-bottom: 4px;
}
.group ul {
  margin: 0;
  padding: 0;
  list-style: none;
  max-height: 200px;
  overflow: auto;
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
}
.group li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px;
  font-size: 12px;
  border-bottom: 0.5px solid var(--line-soft);
}
.group li:last-child {
  border-bottom: none;
}
.group .model {
  color: var(--text-faint);
  font-family: var(--mono);
  font-size: 11px;
  min-width: 72px;
}
.arrow {
  color: var(--text-faint);
}
.label {
  color: var(--text);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-3);
}
</style>
