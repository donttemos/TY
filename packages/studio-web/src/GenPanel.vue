<!--
  @file 生成页（PRD-017 FR-17-12/13/16）
  @description 勾选模型 → 预演或生成；日志从服务端任务轮询回来，原样展示，不做美化。
    铁律：本页**只提交模型名与开关**，命令由服务端拼装——前端无法决定执行什么命令。
  @author donttemo
  @created 2026-10-22
  @modified 2026-10-22 S4：漂移提示按状态拆分——「改过」才会被跳过，「删除」会被重建，
    两者混在一句「会跳过」里会误导用户以为删除的产物不会回来。
  @modified 2026-10-22 接入「AI 检查」：调用 POST /api/review，复用同一份任务日志；
    未配置密钥时按钮禁用并说明缺哪个环境变量。
  @module studio-web
-->
<template>
  <div class="wrap">
    <section class="panel">
      <div class="head">
        <h2>选择模型</h2>
        <span class="pill num">{{ selected.length }}/{{ models.length }}</span>
        <button class="ghost" @click="toggleAll">{{ allSelected ? '全不选' : '全选' }}</button>
      </div>
      <div class="list">
        <label v-for="model in models" :key="model.name" class="item" :class="{ on: selected.includes(model.name) }">
          <input type="checkbox" :value="model.name" v-model="selected" />
          <span class="item-name">
            {{ model.name }}<span v-if="model.label" class="faint">（{{ model.label }}）</span>
          </span>
          <span class="item-meta num">
            {{ model.fields.length }} 字段
            <i v-if="hasDrift(model.name)" class="dot" title="产物被改过或缺失" />
          </span>
        </label>
        <p v-if="models.length === 0" class="empty">schema 中没有模型</p>
      </div>

      <div v-if="driftModified.length > 0 || driftMissing.length > 0" class="drift">
        <template v-if="driftModified.length > 0">
          <p class="drift-title">这些文件你改过，重新生成会跳过它们（不会更新）：</p>
          <ul>
            <li v-for="file in driftModified.slice(0, 6)" :key="file.path">
              <code>{{ file.path }}</code>
              <span class="tag">已修改</span>
            </li>
          </ul>
          <p v-if="driftModified.length > 6" class="faint">… 另有 {{ driftModified.length - 6 }} 个</p>
          <label class="force"><input type="checkbox" v-model="options.force" /> 覆盖这些文件（--force，会丢弃你的修改）</label>
        </template>
        <template v-if="driftMissing.length > 0">
          <p class="drift-title" :class="{ second: driftModified.length > 0 }">
            这些文件已被删除，重新生成会重新创建：
          </p>
          <ul>
            <li v-for="file in driftMissing.slice(0, 6)" :key="file.path">
              <code>{{ file.path }}</code>
              <span class="tag missing">已删除</span>
            </li>
          </ul>
          <p v-if="driftMissing.length > 6" class="faint">… 另有 {{ driftMissing.length - 6 }} 个</p>
        </template>
      </div>

      <p class="kicker">执行选项</p>
      <div class="options">
        <label><input type="checkbox" v-model="options.noMigrate" /> 不执行迁移</label>
        <label><input type="checkbox" v-model="options.noSeed" /> 不写权限种子</label>
        <label><input type="checkbox" v-model="options.allowDestructive" /> 允许破坏性迁移</label>
      </div>

      <div class="actions">
        <button class="primary" @click="run(false)" :disabled="busy || selected.length === 0">
          {{ busy ? '执行中…' : '生成' }}
        </button>
        <button @click="run(true)" :disabled="busy || selected.length === 0">预演（不改文件）</button>
        <span class="divider" />
        <button @click="runReview" :disabled="busy || !reviewConfigured" :title="reviewTitle">AI 检查</button>
      </div>
      <div class="split-row">
        <span class="faint">AI 检查切分方式</span>
        <select v-model="reviewSplit" class="split" :disabled="busy" title="AI 检查的切分策略">
          <option value="auto">按体积装箱（默认）</option>
          <option value="model">按模型分组</option>
          <option value="file">逐文件</option>
        </select>
      </div>
      <p v-if="!driftTracked && !busy" class="faint">尚无产物指纹（还没用新版生成过）</p>
      <p v-if="!reviewConfigured && !busy" class="faint review-hint">
        AI 检查需先在右上角「<strong>AI 路由</strong>」填写接口地址、模型与密钥（保存在本机，不写项目）。
      </p>

      <p class="tip">
        生成会调用 <code>fw gen crud</code>：创建文件、重写 <code>app.module.ts</code> / <code>seed.ts</code> 标记块、
        建并应用迁移、写权限点、跑前后端类型校验。想先看效果就用「预演」。
      </p>
    </section>

    <section class="panel logs">
      <div class="head">
        <h2>执行日志</h2>
        <span v-if="job" class="pill" :class="job.status === 'succeeded' ? 'ok' : job.status === 'failed' ? 'danger' : job.status === 'running' ? 'warn' : ''">
          {{ statusLabel }}
        </span>
        <span v-if="job" class="faint num">{{ elapsedLabel }}</span>
        <button v-if="job" class="ghost" @click="copyLog">复制</button>
      </div>
      <p v-if="message" class="message" :class="messageKind">{{ message }}</p>
      <pre v-if="job" ref="logBox" class="log">{{ job.lines.join('\n') || '（尚无输出）' }}</pre>
      <div v-else class="empty-log">
        <strong>还没有执行记录</strong>
        <p>点「生成」后，迁移、类型检查与文件写入会实时显示在这里；「预演」只列文件、不改动任何东西。</p>
      </div>
      <p v-if="job?.error" class="error">失败原因：{{ job.error }}</p>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import {
  getDrift,
  getJob,
  getReviewInfo,
  startGen,
  startReview,
  type GenOptions,
  type JobRecord,
  type ModelDrift,
  type ModelView,
} from './api';

const props = defineProps<{ models: ModelView[] }>();
const emit = defineEmits<{ (event: 'finished'): void }>();

const selected = ref<string[]>([]);
/** 漂移：被用户改过/删除的产物（重新生成会跳过它们） */
const drift = ref<ModelDrift[]>([]);
const driftTracked = ref(false);
const options = ref<GenOptions>({ noMigrate: false, noSeed: false, allowDestructive: false });
const job = ref<JobRecord | null>(null);
const busy = ref(false);
const message = ref('');
const messageKind = ref<'ok' | 'warn' | 'error'>('ok');
const logBox = ref<HTMLElement | null>(null);
let timer: ReturnType<typeof setTimeout> | null = null;

const allSelected = computed(() => props.models.length > 0 && selected.value.length === props.models.length);

/** 任务耗时：运行中显示已用时间，结束后显示总耗时 */
const elapsedLabel = computed(() => {
  if (!job.value) return '';
  const started = new Date(job.value.startedAt).getTime();
  const end = job.value.finishedAt ? new Date(job.value.finishedAt).getTime() : Date.now();
  if (!Number.isFinite(started)) return '';
  const seconds = Math.max(0, Math.round((end - started) / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
});

/** 该模型是否有漂移（改过/缺失） */
function hasDrift(name: string): boolean {
  return drift.value.some((item) => item.model === name && item.files.length > 0);
}

/** 复制日志（浏览器可能拒绝剪贴板权限） */
async function copyLog(): Promise<void> {
  if (!job.value) return;
  try {
    await navigator.clipboard.writeText(job.value.lines.join('\n'));
    messageKind.value = 'ok';
    message.value = '日志已复制';
  } catch {
    messageKind.value = 'warn';
    message.value = '复制失败：浏览器未授权剪贴板';
  }
}

/** 仅与当前勾选模型相关的漂移文件（按状态分开：改过=会跳过，删除=会重建） */
function driftByStatus(status: 'modified' | 'missing') {
  return drift.value
    .filter((item) => selected.value.includes(item.model))
    .flatMap((item) => item.files)
    .filter((file) => file.status === status);
}
const driftModified = computed(() => driftByStatus('modified'));
const driftMissing = computed(() => driftByStatus('missing'));
/** AI 审查是否可用（服务端读环境变量；未配置时按钮禁用并说明） */
const reviewConfigured = ref(false);
/** AI 检查的切分策略：按体积装箱 / 按模型分组 / 逐文件 */
const reviewSplit = ref<'auto' | 'model' | 'file'>('auto');
const reviewTitle = computed(() =>
  reviewConfigured.value
    ? selected.value.length > 0
      ? `审查勾选的 ${selected.value.length} 个模型的生成物`
      : '审查清单里全部生成物'
    : '需设置 FW_AI_API_KEY 与 FW_AI_MODEL（重启 fw studio 生效）',
);
const statusLabel = computed(
  () =>
    ({ running: '执行中', succeeded: '成功', failed: '失败', killed: '已终止' })[job.value?.status ?? 'running'] ?? '',
);

/** 读取漂移状态（生成前提示「哪些文件会被跳过」） */
async function loadDrift(): Promise<void> {
  try {
    const result = await getDrift();
    drift.value = result.models;
    driftTracked.value = result.tracked;
  } catch {
    // 漂移查不到不影响生成，只是少了提示
    drift.value = [];
    driftTracked.value = false;
  }
}

/** 读取 AI 审查配置状态（只决定按钮可用性） */
async function loadReviewInfo(): Promise<void> {
  try {
    const info = await getReviewInfo();
    reviewConfigured.value = info.configured;
  } catch {
    reviewConfigured.value = false;
  }
}

/** 全选 / 全不选 */
function toggleAll(): void {
  selected.value = allSelected.value ? [] : props.models.map((model) => model.name);
}

/** 轮询任务直到结束 */
async function poll(id: string): Promise<void> {
  try {
    const record = await getJob(id);
    job.value = record;
    await nextTick();
    if (logBox.value) logBox.value.scrollTop = logBox.value.scrollHeight;
    if (record.status === 'running') {
      timer = setTimeout(() => void poll(id), 400);
      return;
    }
    busy.value = false;
    messageKind.value = record.status === 'succeeded' ? 'ok' : 'error';
    message.value =
      record.status === 'succeeded' ? `完成：${record.action}` : `失败：${record.error ?? '见日志'}`;
    if (record.status === 'succeeded') {
      await loadDrift();
      emit('finished');
    }
  } catch (error) {
    busy.value = false;
    messageKind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
    // 连不上服务时不要再 400ms 一次地重试：停掉轮询，等用户重开 Studio
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

/** 启动（dry=true 走预演） */
async function run(dry: boolean): Promise<void> {
  if (selected.value.length === 0) return;
  busy.value = true;
  message.value = '';
  job.value = null;
  try {
    const { jobId } = await startGen(selected.value, { ...options.value, dry });
    void poll(jobId);
  } catch (error) {
    busy.value = false;
    messageKind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
    // 连不上服务时不要再 400ms 一次地重试：停掉轮询，等用户重开 Studio
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

/** 启动 AI 审查（勾选为空 = 审查全部生成物） */
async function runReview(): Promise<void> {
  busy.value = true;
  message.value = '';
  job.value = null;
  try {
    const { jobId } = await startReview(selected.value, reviewSplit.value);
    void poll(jobId);
  } catch (error) {
    busy.value = false;
    messageKind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
    // 连不上服务时不要再 400ms 一次地重试：停掉轮询，等用户重开 Studio
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  }
}

watch(
  () => props.models.map((model) => model.name).join(','),
  () => {
    selected.value = selected.value.filter((name) => props.models.some((model) => model.name === name));
  },
);

onMounted(() => {
  void loadDrift();
  void loadReviewInfo();
  window.addEventListener('fw-ai-config-changed', loadReviewInfo);
});

onBeforeUnmount(() => {
  if (timer) clearTimeout(timer);
  window.removeEventListener('fw-ai-config-changed', loadReviewInfo);
});
</script>

<style scoped>
.wrap {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  gap: var(--sp-3);
  padding: var(--sp-4) 18px var(--sp-5);
  align-items: start;
}
.panel {
  background: var(--surface);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-md);
  padding: var(--sp-3);
  box-shadow: var(--shadow-1);
}
.head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
}
.head h2 {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.02em;
  margin: 0;
  flex: 1;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  max-height: 320px;
  overflow: auto;
  margin-bottom: var(--sp-3);
}
.item {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 6px 8px;
  border-radius: var(--r-sm);
  font-size: 12.5px;
  cursor: pointer;
}
.item:hover {
  background: var(--bg);
}
.item.on {
  background: var(--accent-soft);
}
.item-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.item-meta {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 11px;
  color: var(--text-faint);
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  display: inline-block;
}
.options {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: var(--sp-3);
  font-size: 12px;
  color: var(--text-muted);
}
.options label {
  display: flex;
  align-items: center;
  gap: 6px;
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  padding-top: var(--sp-2);
  border-top: 0.5px solid var(--line-soft);
}
.divider {
  width: 1px;
  height: 18px;
  background: var(--border);
  margin: 0 2px;
}
.split-row {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.split-row .faint {
  flex: 1;
}
.split {
  height: 26px;
  font-size: 11px;
  color: var(--text-muted);
}
.review-hint {
  margin: var(--sp-2) 0 0;
  line-height: 1.6;
}
.tip {
  margin: var(--sp-3) 0 0;
  padding-top: var(--sp-2);
  border-top: 0.5px solid var(--line-soft);
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.7;
}
.drift {
  margin: var(--sp-3) 0;
  padding: 10px;
  border-radius: var(--r-sm);
  background: #fdf6e9;
  border: 0.5px solid #f0d8a8;
  font-size: 12px;
  color: var(--text-muted);
}
.drift-title {
  margin: 0 0 4px;
  color: #854f0b;
}
.drift-title.second {
  margin-top: 8px;
}
.drift ul {
  margin: 0;
  padding-left: 16px;
}
.drift li {
  display: flex;
  align-items: center;
  gap: 6px;
  line-height: 1.8;
}
.drift code {
  font-size: 11px;
}
.tag {
  font-size: 10px;
  padding: 0 6px;
  border-radius: 999px;
  background: #fff;
  border: 0.5px solid #f0d8a8;
  color: #854f0b;
}
.tag.missing {
  border-color: #f0c4c4;
  color: #a32d2d;
}
.force {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}
.logs .head .faint {
  font-size: 11px;
}
.logs {
  min-height: calc(100vh - 150px);
}
.empty-log {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 320px;
  border: 1px dashed var(--border);
  border-radius: var(--r-sm);
  background: #fdfdfb;
  color: var(--text-faint);
  text-align: center;
  padding: var(--sp-5) var(--sp-4);
}
.empty-log strong {
  font-size: 12px;
  color: var(--text-muted);
  font-weight: 500;
}
.empty-log p {
  margin: 0;
  max-width: 360px;
  font-size: 11.5px;
  line-height: 1.7;
}
.log {
  margin: 0;
  padding: 10px 12px;
  min-height: 260px;
  max-height: calc(100vh - 220px);
  overflow: auto;
  background: #1e1e1c;
  color: #e8e6df;
  border-radius: var(--r-sm);
  line-height: 1.65;
  font-size: 11.5px;
}
.message {
  margin: 0 0 var(--sp-2);
  padding: 7px 10px;
  border-radius: var(--r-sm);
  font-size: 12px;
  background: var(--accent-soft);
  color: var(--accent);
}
.message.warn {
  background: #faeeda;
  color: #854f0b;
}
.message.error {
  background: #fcebeb;
  color: #a32d2d;
}
.error {
  margin: var(--sp-2) 0 0;
  font-size: 12px;
  color: #a32d2d;
}
.empty {
  color: var(--text-faint);
  font-size: 12px;
  margin: 0;
}
.faint {
  color: var(--text-faint);
  font-size: 11px;
}
</style>
