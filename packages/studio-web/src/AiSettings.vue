<!--
  @file AI 模型路由设置（PRD-017 FR-17-25）
  @description 在页面里填写供应商地址 / 模型 / 密钥，保存到本机 `~/.fw/studio-ai.json`：
    不写项目目录（避免密钥进版本库），服务端永不回显密钥，留空即保持原值。
    「测试连接」只打 `/models`，不产生推理费用。
  @author donttemo
  @created 2026-10-22
  @module studio-web
-->
<template>
  <div class="mask" @click.self="$emit('close')">
    <section class="dialog">
      <header class="head">
        <h2>AI 模型路由</h2>
        <button class="close" title="关闭" @click="$emit('close')">×</button>
      </header>

      <p class="hint">
        保存在 <code>{{ status?.file ?? '…' }}</code>，仅本机、不写项目。
        优先级：此处 &gt; 环境变量 <code>FW_AI_*</code>。
      </p>
      <p v-if="status?.error" class="warn">{{ status.error }}</p>

      <label>
        <span>接口地址</span>
        <input v-model="baseUrl" placeholder="https://api.deepseek.com/v1" spellcheck="false" />
        <span class="faint">对话地址：{{ chatPreview }}</span>
      </label>
      <label>
        <span class="label-row">
          模型名
          <button type="button" class="mini" :disabled="fetching" @click="loadModels(false)">
            {{ fetching ? '获取中…' : '从地址获取' }}
          </button>
        </span>
        <input v-model="model" list="ai-model-options" placeholder="deepseek-chat" spellcheck="false" />
        <datalist id="ai-model-options">
          <option v-for="item in models" :key="item" :value="item" />
        </datalist>
        <span v-if="models.length > 0" class="faint">
          {{ models.length }} 个可选（选不到也可以手填）
        </span>
      </label>
      <label>
        <span>调用超时（秒）</span>
        <input v-model.number="timeoutSec" type="number" min="5" max="600" step="5" />
        <span class="faint">推理模型 / 大 schema 建议 120~300</span>
      </label>
      <label>
        <span>密钥</span>
        <input
          v-model="apiKey"
          type="password"
          autocomplete="off"
          :placeholder="status?.apiKeySet ? '已保存（留空则不修改）' : 'sk-…'"
        />
      </label>

      <p class="state">
        当前来源：{{ sourceLabel }}｜{{ status?.apiKeySet ? '密钥已设置（不回显）' : '未设置密钥' }}
        <template v-if="status?.configured">｜已就绪</template>
      </p>

      <div class="actions">
        <button class="primary" :disabled="busy" @click="save">{{ busy ? '处理中…' : '保存' }}</button>
        <button :disabled="busy" @click="test">诊断链路</button>
        <button v-if="status?.apiKeySet" :disabled="busy" @click="clearKey">清除密钥</button>
        <span v-if="message" class="msg" :class="kind">{{ message }}</span>
      </div>

      <div v-if="diagnosis" class="diag">
        <p class="faint">对话地址：<code>{{ diagnosis.chatUrl || '—' }}</code></p>
        <ul>
          <li v-for="step in diagnosis.steps" :key="step.name" :class="step.ok ? 'ok' : 'bad'">
            {{ step.name === 'models' ? '模型列表' : '对话接口' }}：{{ step.message }}（{{ step.elapsedMs }}ms）
          </li>
        </ul>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import {
  diagnoseAiConfig,
  fetchAiModels,
  getAiConfig,
  saveAiConfig,
  type AiDiagnoseStep,
  type AiRouteStatus,
} from './api';

const emit = defineEmits<{ (event: 'close'): void; (event: 'saved'): void }>();

const status = ref<AiRouteStatus | null>(null);
const baseUrl = ref('');
const model = ref('');
const apiKey = ref('');
const timeoutSec = ref(120);
const models = ref<string[]>([]);
const diagnosis = ref<{ chatUrl: string; steps: AiDiagnoseStep[] } | null>(null);
const fetching = ref(false);
const busy = ref(false);
const message = ref('');
const kind = ref<'ok' | 'error'>('ok');

/** 对话地址预览：让「路径对不对」一眼可见，不用等超时 */
const chatPreview = computed(() => {
  const base = baseUrl.value.trim().replace(/\/+$/, '');
  return base === '' ? '—' : `${base}/chat/completions`;
});
const sourceLabel = computed(
  () => ({ file: '页面配置', env: '环境变量', none: '未配置' })[status.value?.source ?? 'none'],
);

/** 拉取当前状态（不回显密钥） */
async function load(): Promise<void> {
  try {
    status.value = await getAiConfig();
    baseUrl.value = status.value.baseUrl;
    model.value = status.value.model;
    timeoutSec.value = Math.round((status.value.timeoutMs ?? 120_000) / 1000);
    // 已配置的实例打开即自动拉一次模型名，省得每次手点
    if (status.value.configured) void loadModels(true);
  } catch (error) {
    kind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  }
}

/** 拉取模型名（{baseUrl}/models）；silent = 后台刷新，不覆盖用户当前提示 */
async function loadModels(silent: boolean): Promise<void> {
  if (baseUrl.value.trim() === '') {
    if (!silent) {
      kind.value = 'error';
      message.value = '先填接口地址，再获取模型';
    }
    return;
  }
  fetching.value = true;
  try {
    const result = await fetchAiModels({
      baseUrl: baseUrl.value,
      ...(apiKey.value.trim() === '' ? {} : { apiKey: apiKey.value }),
    });
    models.value = result.models;
    if (result.ok) {
      if (!silent) {
        kind.value = 'ok';
        message.value = result.message;
      }
    } else if (!silent) {
      kind.value = 'error';
      message.value = result.message;
    }
  } catch (error) {
    if (!silent) {
      kind.value = 'error';
      message.value = error instanceof Error ? error.message : String(error);
    }
  } finally {
    fetching.value = false;
  }
}

/** 保存后通知其他面板刷新可用状态 */
function notifyChanged(): void {
  window.dispatchEvent(new CustomEvent('fw-ai-config-changed'));
  emit('saved');
}

/** 保存（密钥留空 = 不修改） */
async function save(): Promise<void> {
  busy.value = true;
  message.value = '';
  try {
    status.value = await saveAiConfig({
      baseUrl: baseUrl.value,
      model: model.value,
      timeoutMs: Math.max(5, Math.min(600, Math.round(Number(timeoutSec.value) || 120))) * 1000,
      ...(apiKey.value.trim() === '' ? {} : { apiKey: apiKey.value }),
    });
    apiKey.value = '';
    kind.value = 'ok';
    message.value = status.value.configured ? '已保存，已就绪' : '已保存（还缺密钥或模型名）';
    notifyChanged();
    void loadModels(true);
  } catch (error) {
    kind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

/** 测试连接（只打 /models） */
async function test(): Promise<void> {
  busy.value = true;
  message.value = '';
  try {
    const result = await diagnoseAiConfig({
      baseUrl: baseUrl.value,
      model: model.value,
      timeoutMs: Math.max(5, Math.min(600, Math.round(Number(timeoutSec.value) || 120))) * 1000,
      ...(apiKey.value.trim() === '' ? {} : { apiKey: apiKey.value }),
    });
    diagnosis.value = { chatUrl: result.chatUrl, steps: result.steps };
    kind.value = result.ok ? 'ok' : 'error';
    message.value = result.message;
    if (result.ok) void loadModels(true);
  } catch (error) {
    kind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

/** 清除已保存的密钥 */
async function clearKey(): Promise<void> {
  busy.value = true;
  message.value = '';
  try {
    status.value = await saveAiConfig({ clearApiKey: true });
    apiKey.value = '';
    kind.value = 'ok';
    message.value = '已清除密钥';
    notifyChanged();
  } catch (error) {
    kind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

onMounted(() => {
  void load();
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
  padding-top: 12vh;
  z-index: 50;
}
.dialog {
  width: min(520px, calc(100vw - 32px));
  background: var(--surface);
  border: 0.5px solid var(--border-strong);
  border-radius: 12px;
  padding: 16px 18px 18px;
  box-shadow: 0 18px 48px rgb(0 0 0 / 18%);
}
.head {
  display: flex;
  align-items: center;
  margin-bottom: 8px;
}
.head h2 {
  font-size: 14px;
  margin: 0;
  flex: 1;
}
.close {
  border: none;
  background: transparent;
  font-size: 20px;
  line-height: 1;
  color: var(--text-muted);
  cursor: pointer;
}
.hint,
.state {
  font-size: 12px;
  color: var(--text-faint);
  line-height: 1.7;
  margin: 0 0 10px;
}
.warn {
  font-size: 12px;
  color: #a32d2d;
  margin: 0 0 10px;
}
label {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 10px;
  font-size: 12px;
  color: var(--text-muted);
}
input {
  padding: 7px 10px;
  border: 0.5px solid var(--border-strong);
  border-radius: 8px;
  background: var(--bg);
  color: var(--text);
  font: inherit;
}
.label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.mini {
  border: none;
  background: transparent;
  color: var(--accent);
  font-size: 12px;
  padding: 0;
  cursor: pointer;
}
.mini:disabled {
  color: var(--text-faint);
  cursor: default;
}
.faint {
  font-size: 11px;
  color: var(--text-faint);
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.msg {
  font-size: 12px;
  color: var(--accent);
}
.msg.error {
  color: #a32d2d;
}
.diag {
  margin-top: 10px;
  font-size: 12px;
  line-height: 1.8;
}
.diag ul {
  margin: 4px 0 0;
  padding-left: 16px;
}
.diag li.ok {
  color: #27500a;
}
.diag li.bad {
  color: #a32d2d;
}
</style>
