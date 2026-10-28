<!--
  @file JSON 识别导入（PRD-017 FR-17-04 补充）
  @description 粘贴 JSON → 识别成设计器草稿，走「预览变更 → 写入 schema」，本组件不写盘。
    宽容接受 {models:[...]} / [{name,fields}] / {Tag:{fields}} / {tables:[...]} 四种形态，
    识别失败只报结构原因，不做猜测性补全。
  @author donttemo
  @created 2026-10-28
  @module studio-web
-->
<template>
  <div class="mask" @click.self="$emit('close')">
    <section class="dialog">
      <header class="head">
        <h2>从 JSON 识别模型</h2>
        <button class="close" title="关闭" @click="$emit('close')">×</button>
      </header>

      <p class="hint">
        支持：<code>{"models":[…]}</code>、<code>[{"name":"Tag","fields":[…]}]</code>、
        <code>{"Tag":{"fields":{"name":"String?"}}}</code>、<code>{"tables":[…]}</code>。
        只识别成草稿，<strong>不写 schema</strong>。
      </p>

      <textarea
        v-model="text"
        rows="12"
        spellcheck="false"
        placeholder='{"models":[{"name":"Tag","fields":[{"name":"name","type":"String","nullable":false,"unique":true},{"name":"color","type":"String?"}]}]}'
      />

      <div class="actions">
        <button class="primary" :disabled="busy || text.trim() === ''" @click="recognize">
          {{ busy ? '识别中…' : '识别' }}
        </button>
        <button class="ghost" :disabled="busy" @click="fillSample">填入示例</button>
        <span v-if="error" class="msg error">{{ error }}</span>
      </div>

      <div v-if="result" class="result">
        <div class="summary">
          <span class="pill num">{{ result.models.length }} 模型</span>
          <span class="pill num">{{ fieldCount }} 字段</span>
          <span v-if="result.skipped.length > 0" class="pill warn">跳过 {{ result.skipped.length }}</span>
        </div>

        <ul class="models">
          <li v-for="model in result.models" :key="model.name">
            <code>{{ model.name }}</code>
            <span class="faint num">{{ model.fields.length }} 字段</span>
          </li>
        </ul>

        <ul v-if="result.notes.length > 0" class="notes">
          <li v-for="note in result.notes" :key="note">{{ note }}</li>
        </ul>
        <p v-if="result.skipped.length > 0" class="faint">
          跳过：{{ result.skipped.map((item) => `${item.model}（${item.reason}）`).join('；') }}
        </p>

        <div class="actions">
          <button class="primary" @click="confirm">导入到设计器</button>
          <button @click="$emit('close')">取消</button>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { importModelsJson, type EditorModel, type ImportedModels } from './api';

const emit = defineEmits<{
  (event: 'close'): void;
  (event: 'imported', payload: { models: EditorModel[]; notes: string[] }): void;
}>();

const text = ref('');
const busy = ref(false);
const error = ref('');
const result = ref<ImportedModels | null>(null);

const fieldCount = computed(() =>
  (result.value?.models ?? []).reduce((sum, model) => sum + model.fields.length, 0),
);

/** 识别（只解析，不落盘） */
async function recognize(): Promise<void> {
  busy.value = true;
  error.value = '';
  result.value = null;
  try {
    result.value = await importModelsJson(text.value);
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err);
  } finally {
    busy.value = false;
  }
}

/** 导入到设计器：交给父组件并入本地草稿 */
function confirm(): void {
  if (!result.value || result.value.models.length === 0) return;
  emit('imported', { models: result.value.models, notes: result.value.notes });
  emit('close');
}

/** 示例：覆盖简写、可空、唯一、索引 */
function fillSample(): void {
  text.value = JSON.stringify(
    {
      models: [
        {
          name: 'Tag',
          display_name: '标签',
          fields: [
            { name: 'name', display_name: '名称', type: 'String', nullable: false, unique: true, indexed: true },
            { name: 'color', display_name: '颜色', type: 'String?' },
            { name: 'sortOrder', type: 'Int', default: 0 },
            { name: 'enabled', type: 'Boolean', default: true },
          ],
        },
      ],
    },
    null,
    2,
  );
}
</script>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgb(0 0 0 / 28%);
  display: flex;
  align-items: flex-start;
  justify-content: center;
  padding-top: 8vh;
  z-index: 50;
}
.dialog {
  width: min(640px, calc(100vw - 32px));
  max-height: 84vh;
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
  margin: 0 0 var(--sp-2);
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.8;
}
.hint code {
  font-size: 11px;
  background: var(--bg);
  border: 0.5px solid var(--border);
  border-radius: 4px;
  padding: 0 4px;
}
textarea {
  width: 100%;
  font-family: var(--mono);
  font-size: 12px;
  line-height: 1.7;
  min-height: 180px;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
  flex-wrap: wrap;
}
.msg {
  font-size: 12px;
  color: var(--accent);
}
.msg.error {
  color: #a32d2d;
}
.result {
  margin-top: var(--sp-3);
  padding-top: var(--sp-3);
  border-top: 0.5px solid var(--line-soft);
}
.summary {
  display: flex;
  gap: 6px;
  margin-bottom: var(--sp-2);
}
.models {
  margin: 0 0 var(--sp-2);
  padding: 0;
  list-style: none;
  max-height: 160px;
  overflow: auto;
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
}
.models li {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 10px;
  font-size: 12px;
  border-bottom: 0.5px solid var(--line-soft);
}
.models li:last-child {
  border-bottom: none;
}
.notes {
  margin: 0 0 var(--sp-2);
  padding-left: 18px;
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.8;
}
.faint {
  color: var(--text-faint);
  font-size: 11px;
}
</style>
