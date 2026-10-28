<!--
  @file AI 建模面板（PRD-017 FR-17-24 / AC-17-15 第一步）
  @description 自然语言 → 只读草案。刻意只做「生成 + 展示」：
    不写 schema、不生成代码、不支持在流里继续改（增量 revise 与可视化编辑是下一步）。
    服务端已做结构/语义校验，前端只渲染；校验失败时展示路径化问题，方便判断是需求没说清还是模型跑偏。
  @author donttemo
  @created 2026-10-22
  @module studio-web
-->
<template>
  <div class="wrap">
    <section class="panel">
      <div class="head">
        <h2>用自然语言描述业务</h2>
        <span class="faint">只读草案，不改 schema</span>
      </div>
      <textarea
        v-model="requirement"
        rows="5"
        placeholder="例：我要做一个商品管理模块，商品要有名称、唯一 SKU、价格、库存、商品详情和上下架状态。商品属于一个分类，需要支持按名称、分类和状态搜索。"
      />
      <textarea
        v-model="extra"
        class="extra"
        rows="2"
        placeholder="补充说明（可选）：回答 AI 的澄清问题，例如「复用 AuditLog，不新建模型」"
      />
      <div class="actions">
        <button class="primary" :disabled="busy || !configured || requirement.trim() === ''" @click="generate">
          {{ busy ? '生成中…' : draft ? '带补充说明重新生成' : '生成模型草案' }}
        </button>
        <button :disabled="busy || !canImport" :title="importHint" @click="importToEditor">导入编辑器</button>
        <button v-if="draft" :disabled="busy" @click="clearCache">清空草案</button>
        <span class="faint">{{ requirement.length }} / 4000</span>
      </div>
      <p v-if="!configured" class="hint">
        在右上角「<strong>AI 路由</strong>」里填写接口地址、模型与密钥（保存在本机，不写项目），保存即生效。
      </p>
      <div v-if="context" class="ctx">
        <div class="ctx-row">
          <span class="pill num">{{ context.models }} 个已有模型</span>
          <span class="pill">{{ context.database }}</span>
          <span v-if="context.truncated" class="pill warn">schema 已截断</span>
        </div>
        <p v-if="context.modelNames.length" class="ctx-names">
          {{ context.modelNames.slice(0, 6).join('、') }}{{ context.modelNames.length > 6 ? '…' : '' }}
        </p>
        <p class="ctx-note">{{ context.conventions }}</p>
      </div>
      <p v-if="message" class="message" :class="kind">{{ message }}</p>
      <ul v-if="issues.length > 0" class="issues">
        <li v-for="issue in issues" :key="issue.path + issue.code">
          <code>{{ issue.path }}</code> {{ issue.message }}
        </li>
      </ul>
    </section>

    <section v-if="!draft" class="panel empty-state">
      <h2>草案会出现在这里</h2>
      <ol>
        <li><strong>生成</strong>：读 schema 与约定，产出模型/字段/索引/关系草案，并做结构与语义校验。</li>
        <li><strong>继续修改</strong>：用一句话改草案（如「库存不能小于零」），只看 diff，确认后才覆盖。</li>
        <li><strong>导入编辑器</strong>：转成设计器草稿，再走「预览变更 → 写入 schema」。</li>
      </ol>
      <p class="faint">草案自动缓存在本机，刷新不丢；不写 schema、不生成代码。</p>
    </section>

    <section v-if="draft" class="panel result">
      <div class="head">
        <h2>草案</h2>
        <span class="pill" :class="draft.status === 'draft' ? 'ok' : 'warn'">{{ statusLabel }}</span>
        <span class="pill num">rev {{ draft.revision }}</span>
        <span class="pill num">{{ draft.models?.length ?? 0 }} 模型</span>
        <span class="pill num">{{ totalFields }} 字段</span>
        <span v-if="attempts > 1" class="pill">重试 {{ attempts - 1 }} 次</span>
      </div>
      <p class="summary">{{ draft.requirement_summary }}</p>

      <div class="revise">
        <div class="revise-row">
          <input
            v-model="instruction"
            placeholder="继续修改：例如「商品需要支持多张图片」或「库存不能小于零」"
            @keyup.enter="askRevise"
          />
          <button :disabled="busy || !canRevise" @click="askRevise">{{ busy ? '修改中…' : '让 AI 修改' }}</button>
        </div>
        <p v-if="reviseError" class="msg error">{{ reviseError }}</p>

        <div v-if="pending" class="pending">
          <h4>
            待确认变更 · {{ pending.changes.length }}
            <span v-if="pending.destructive" class="danger">（含破坏性变更）</span>
          </h4>
          <ul>
            <li v-for="change in pending.changes" :key="change.path + change.op">
              <code>{{ change.path }}</code>：<span class="before">{{ preview(change.before) }}</span>
              → <span class="after">{{ preview(change.after) }}</span>
              <span v-if="change.destructive" class="danger">破坏性</span>
            </li>
          </ul>
          <p v-if="pending.skipped.length > 0" class="faint">
            已跳过 {{ pending.skipped.length }} 条：{{ pending.skipped.map((item) => item.reason).join('；') }}
          </p>
          <p class="faint">只应用上面这些变更，其余字段保持你当前的样子。</p>
          <div class="actions">
            <button class="primary" @click="adoptRevise">采用变更（rev {{ pending.draft.revision }}）</button>
            <button @click="pending = null">放弃</button>
          </div>
        </div>
      </div>

      <article v-for="model in draft.models ?? []" :key="model.name" class="model">
        <header class="model-head">
          <h3>{{ model.name }}</h3>
          <span class="model-sub">{{ model.display_name }}</span>
          <span class="pill" :class="model.action === 'create' ? 'accent' : ''">{{ model.action }}</span>
          <span class="pill num">{{ model.fields.length }} 字段</span>
        </header>
        <table>
          <thead>
            <tr>
              <th>字段</th>
              <th>类型</th>
              <th>可空</th>
              <th>默认</th>
              <th>唯一</th>
              <th>索引</th>
              <th>来源</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="field in model.fields" :key="field.name">
              <td>
                <code>{{ field.name }}</code>
                <span class="faint"> {{ field.display_name }}</span>
              </td>
              <td>
                <span class="type">{{ field.type }}</span>
                <span v-if="field.enum_values?.length" class="faint">{{ field.enum_values.join(' / ') }}</span>
              </td>
              <td class="center">{{ field.nullable ? '是' : '·' }}</td>
              <td class="mono">{{ field.default === null || field.default === undefined ? '—' : String(field.default) }}</td>
              <td class="center">{{ field.unique ? '✓' : '·' }}</td>
              <td class="center">{{ field.indexed ? '✓' : '·' }}</td>
              <td>{{ sourceLabel(field.source) }}</td>
            </tr>
          </tbody>
        </table>
        <p v-if="model.indexes?.length" class="faint">
          索引：{{ model.indexes.map((item) => `${item.fields.join('+')}${item.unique ? '(唯一)' : ''}`).join('、') }}
        </p>
        <p v-if="model.relations?.length" class="faint">
          关系：{{ model.relations.map((item) => `${item.from ?? '?'} → ${item.target}（${item.cardinality}）`).join('、') }}
        </p>
      </article>

      <details v-if="autoFixes.length > 0" class="fold">
        <summary>自动修正 · {{ autoFixes.length }} 项</summary>
        <ul><li v-for="item in autoFixes" :key="item">{{ item }}</li></ul>
      </details>

      <p v-if="draft.status === 'needs_clarification'" class="clarify">
        待澄清：AI 判断与已有模型语义重叠，本轮没有生成新模型。先回答上面的问题（或在上方写补充说明），再点「带补充说明重新生成」。
      </p>

      <details v-if="draft.operations?.length" class="fold">
        <summary>增量操作 · {{ draft.operations.length }} 条（原始）</summary>
        <pre>{{ JSON.stringify(draft.operations, null, 2) }}</pre>
      </details>

      <div class="cols">
        <div v-if="draft.assumptions?.length">
          <h4>设计假设</h4>
          <ul><li v-for="item in draft.assumptions" :key="item">{{ item }}</li></ul>
        </div>
        <div v-if="draft.questions?.length">
          <h4>待确认</h4>
          <ul>
            <li v-for="item in draft.questions" :key="item.id">
              <strong>{{ item.id }}</strong> {{ item.question }}
              <span v-if="item.options?.length" class="faint">（{{ item.options.map(optionLabel).join(' / ') }}）</span>
            </li>
          </ul>
        </div>
        <div v-if="draft.warnings?.length">
          <h4>提示</h4>
          <ul><li v-for="item in draft.warnings" :key="item">{{ item }}</li></ul>
        </div>
        <div v-if="draft.migration_risks?.length">
          <h4>迁移风险</h4>
          <ul>
            <li v-for="(item, index) in draft.migration_risks" :key="index">
              <strong>{{ riskTarget(item) }}</strong> {{ riskImpact(item) }}
            </li>
          </ul>
        </div>
      </div>

      <details>
        <summary>原始 JSON</summary>
        <pre>{{ JSON.stringify(draft, null, 2) }}</pre>
      </details>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue';
import {
  clearDraftCache,
  createModelDraft,
  draftToEditor,
  getDraftContext,
  getSavedDraft,
  reviseDraft,
  saveDraftCache,
  StudioApiError,
  type DraftContextSummary,
  type EditorModel,
} from './api';

/** 草案字段（与服务端契约同构，仅取界面用到的键） */
interface DraftField {
  name: string;
  display_name: string;
  type: string;
  nullable: boolean;
  default?: unknown;
  unique: boolean;
  indexed: boolean;
  source: 'explicit' | 'convention' | 'inferred';
  reason?: string;
  enum_values?: string[];
}

/** 草案模型 */
interface DraftModel {
  name: string;
  display_name: string;
  action: string;
  fields: DraftField[];
  indexes?: { fields: string[]; unique: boolean }[];
  relations?: { from?: string; target: string; cardinality: string; field: string }[];
}

/** 草案视图 */
interface DraftView {
  revision: number;
  status: string;
  requirement_summary: string;
  models?: DraftModel[];
  operations?: unknown[];
  assumptions?: string[];
  questions?: { id: string; question: string; options?: (string | { label?: string; text?: string; value?: string })[] }[];
  warnings?: string[];
  migration_risks?: { model?: string; field?: string; kind?: string; impact?: string; description?: string }[];
}

interface Issue {
  path: string;
  code: string;
  message: string;
}

const requirement = ref('');
/** 补充说明：回答 AI 的澄清问题，追加在需求之后重新生成 */
const extra = ref('');
/** 增量修改的自然语言指令 */
const instruction = ref('');
const reviseError = ref('');
/** 待确认的增量结果（采用前不覆盖当前草案） */
const pending = ref<{
  draft: Record<string, unknown> & { revision?: number };
  changes: { op: string; path: string; before: unknown; after: unknown; destructive: boolean }[];
  skipped: { op: string; reason: string }[];
  destructive: boolean;
  warnings: string[];
} | null>(null);

/** 状态标签：draft 才是可用草案 */
const statusLabel = computed(() => (draft.value?.status === 'draft' ? '可用' : '待澄清'));

/** 草案字段总数（顶栏汇总用） */
const totalFields = computed(() =>
  (draft.value?.models ?? []).reduce((sum, model) => sum + (model.fields?.length ?? 0), 0),
);

const canRevise = computed(
  () => draft.value !== null && draft.value.status === 'draft' && instruction.value.trim() !== '',
);
const configured = ref(false);
const context = ref<DraftContextSummary | null>(null);
const draft = ref<DraftView | null>(null);
const attempts = ref(1);
const issues = ref<Issue[]>([]);
const busy = ref(false);
const message = ref('');
const kind = ref<'ok' | 'error'>('ok');
const importNotes = ref<string[]>([]);
/** 服务端自动修正项（补齐/丢弃），与模型自述的 warnings 分开显示 */
const autoFixes = ref<string[]>([]);

/** 草案里有没有可导入的模型（待澄清时没有） */
const canImport = computed(
  () => draft.value !== null && draft.value.status === 'draft' && (draft.value.models?.length ?? 0) > 0,
);

/** 导入按钮为什么不可用，直接说不清楚 */
const importHint = computed(() => {
  if (!draft.value) return '先生成草案';
  if (draft.value.status === 'needs_clarification') return '草案待澄清：没有生成任何模型，先回答问题再重新生成';
  if ((draft.value.models?.length ?? 0) === 0) return '草案里没有模型';
  return '把草案导入设计器（本地草稿，不写 schema）';
});

/** 选项可能是字符串或对象（不同模型写法不一） */
function optionLabel(option: string | { label?: string; text?: string; value?: string }): string {
  if (typeof option === 'string') return option;
  return option.label ?? option.text ?? option.value ?? JSON.stringify(option);
}

/** 迁移风险的目标与影响，字段缺失时降级显示 */
function riskTarget(item: { model?: string; field?: string; kind?: string }): string {
  const target = [item.model, item.field].filter(Boolean).join('.');
  return `${target === '' ? '变更' : target} · ${item.kind ?? '风险'}`;
}
function riskImpact(item: { impact?: string; description?: string }): string {
  return item.impact ?? item.description ?? '（模型未给影响说明）';
}
const emit = defineEmits<{ (event: 'imported', payload: { models: EditorModel[]; notes: string[] }): void }>();

const pretty = computed(() => (draft.value ? JSON.stringify(draft.value, null, 2) : ''));

/** 来源标签：让人一眼看出哪些字段是 AI 推断的 */
function sourceLabel(source: DraftField['source']): string {
  return { explicit: '需求', convention: '约定', inferred: '推断' }[source] ?? source;
}

/** 读取上下文与可用状态 */
async function loadContext(): Promise<void> {
  try {
    const result = await getDraftContext();
    configured.value = result.configured;
    context.value = result.context;
  } catch {
    configured.value = false;
  }
}

/** 把草案导入设计器（本地草稿，不写 schema） */
async function importToEditor(): Promise<void> {
  if (!draft.value) return;
  busy.value = true;
  try {
    const result = await draftToEditor(draft.value as unknown as Record<string, unknown>);
    importNotes.value = result.notes;
    if (result.models.length === 0) {
      kind.value = 'error';
      message.value = `没有可导入的模型：${result.notes.join('；') || '草案为空'}`;
      return;
    }
    emit('imported', { models: result.models, notes: result.notes });
    kind.value = 'ok';
    message.value = `已导入 ${result.models.length} 个模型到设计器（未写入 schema），请在「数据模型」页点「预览变更」确认`;
  } catch (error) {
    kind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

/** 生成草案 */
async function generate(): Promise<void> {
  busy.value = true;
  message.value = '';
  issues.value = [];
  draft.value = null;
  try {
    const suffix = extra.value.trim() === '' ? '' : `\n\n补充说明：${extra.value.trim()}`;
    const result = await createModelDraft(`${requirement.value}${suffix}`);
    draft.value = result.draft as unknown as DraftView;
    attempts.value = result.attempts;
    autoFixes.value = result.warnings;
    pending.value = null;
    void saveDraftCache(result.draft).catch(() => undefined);
    kind.value = 'ok';
    if (draft.value.status === 'needs_clarification') {
      // 待澄清不是失败：模型判断与已有模型重叠，需要人先拍板
      message.value = '需要澄清：AI 判断与已有模型语义重叠，本轮没有生成模型。请回答下面的问题（或写补充说明）后重新生成';
    } else {
      message.value = `草案已生成（第 ${result.attempts} 次输出通过校验）`;
      if (result.warnings.length > 0) message.value += `；${result.warnings.join('；')}`;
    }
  } catch (error) {
    kind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
    if (error instanceof StudioApiError) {
      const detail = error.details as { issues?: Issue[] } | undefined;
      issues.value = detail?.issues ?? [];
    }
  } finally {
    busy.value = false;
  }
}

/** 读取上次草案（刷新不丢） */
async function loadSaved(): Promise<void> {
  try {
    const result = await getSavedDraft();
    if (!result.saved) return;
    draft.value = result.saved.draft as unknown as DraftView;
    kind.value = 'ok';
    const at = result.saved.savedAt ? new Date(result.saved.savedAt).toLocaleString() : '';
    message.value = `已恢复上次草案${at ? `（${at}）` : ''}，可直接继续修改或导入编辑器`;
  } catch {
    // 缓存读不到不影响使用，静默即可
  }
}

/** 让 AI 只改指定内容（不重发整份草案） */
async function askRevise(): Promise<void> {
  if (!draft.value || !canRevise.value) return;
  busy.value = true;
  reviseError.value = '';
  pending.value = null;
  try {
    const result = await reviseDraft(draft.value as unknown as Record<string, unknown>, instruction.value.trim());
    pending.value = {
      draft: result.draft as Record<string, unknown>,
      changes: result.changes,
      skipped: result.skipped,
      destructive: result.destructive,
      warnings: result.warnings,
    };
    instruction.value = '';
    if (result.changes.length === 0) {
      reviseError.value = '模型没有提出任何变更：可以换个说法，或直接在设计器里改';
      pending.value = null;
    }
  } catch (error) {
    reviseError.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

/** 采用增量变更（此时才覆盖当前草案） */
function adoptRevise(): void {
  if (!pending.value) return;
  draft.value = pending.value.draft as unknown as DraftView;
  autoFixes.value = pending.value.warnings;
  message.value = `已应用 ${pending.value.changes.length} 处变更（rev ${pending.value.draft.revision}）`;
  kind.value = 'ok';
  void saveDraftCache(pending.value.draft).catch(() => undefined);
  pending.value = null;
}

/** 清空缓存与当前草案 */
async function clearCache(): Promise<void> {
  await clearDraftCache().catch(() => undefined);
  draft.value = null;
  pending.value = null;
  autoFixes.value = [];
  message.value = '已清空草案缓存';
}

/** diff 里的值预览（太长就截断，避免撑爆列表） */
function preview(value: unknown): string {
  if (value === null || value === undefined) return '∅';
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  return text.length > 120 ? `${text.slice(0, 117)}…` : text;
}

onMounted(() => {
  void loadContext();
  void loadSaved();
  window.addEventListener('fw-ai-config-changed', loadContext);
});

onBeforeUnmount(() => {
  window.removeEventListener('fw-ai-config-changed', loadContext);
});
</script>

<style scoped>
.wrap {
  display: grid;
  grid-template-columns: 380px minmax(0, 1fr);
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
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: var(--sp-3);
}
.head h2 {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.02em;
  margin: 0;
  margin-right: auto;
}
textarea {
  width: 100%;
  margin-bottom: var(--sp-2);
  font-size: 12.5px;
  line-height: 1.7;
}
.extra {
  font-size: 12px;
  background: var(--bg);
}
.actions {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  flex-wrap: wrap;
  margin-top: var(--sp-2);
}
.hint,
.ctx {
  margin: var(--sp-2) 0 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.7;
}
.ctx {
  padding: 9px 11px;
  background: var(--bg);
  border-radius: var(--r-sm);
  border: 0.5px solid var(--border);
}
.ctx-row {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  margin-bottom: 6px;
}
.ctx-names {
  margin: 0 0 4px;
  font-family: var(--mono);
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.7;
}
.ctx-note {
  margin: 0;
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.7;
}
.empty-state {
  min-height: 320px;
}
.empty-state h2 {
  margin: 0 0 var(--sp-3);
  font-size: 13px;
  font-weight: 600;
}
.empty-state ol {
  margin: 0 0 var(--sp-3);
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.9;
}
.empty-state li strong {
  color: var(--text);
  font-weight: 500;
}
.empty-state .faint {
  margin: 0;
}
.message {
  margin: var(--sp-2) 0 0;
  padding: 7px 10px;
  border-radius: var(--r-sm);
  font-size: 12px;
  background: var(--accent-soft);
  color: var(--accent);
}
.message.error {
  background: #fcebeb;
  color: #a32d2d;
}
.issues {
  margin: var(--sp-2) 0 0;
  padding-left: 16px;
  font-size: 12px;
  color: #a32d2d;
  line-height: 1.8;
}
.summary {
  margin: 0 0 var(--sp-3);
  padding: 9px 11px;
  background: var(--bg);
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
}
.revise {
  margin-bottom: var(--sp-3);
  padding-bottom: var(--sp-3);
  border-bottom: 0.5px solid var(--line-soft);
}
.revise-row {
  display: flex;
  gap: var(--sp-2);
}
.revise-row input {
  flex: 1;
  font-size: 12px;
}
.pending {
  margin-top: var(--sp-2);
  padding: 10px 12px;
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
}
.pending h4 {
  font-size: 12px;
  margin: 0 0 6px;
  color: var(--text-muted);
}
.pending ul {
  margin: 0;
  padding-left: 16px;
  font-size: 12px;
  line-height: 1.9;
  max-height: 240px;
  overflow: auto;
}
.model {
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
  padding: 10px 12px;
  margin-bottom: var(--sp-2);
  background: #fdfdfb;
}
.model-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.model-head h3 {
  font-size: 13px;
  font-weight: 600;
  margin: 0;
}
.model-sub {
  font-size: 11px;
  color: var(--text-faint);
  margin-right: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 12px;
}
th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--text-faint);
  padding: 4px 6px;
  border-bottom: 0.5px solid var(--border);
  white-space: nowrap;
}
td {
  padding: 4px 6px;
  border-bottom: 0.5px solid var(--line-soft);
}
tbody tr:last-child td {
  border-bottom: none;
}
td.center {
  text-align: center;
  color: var(--text-muted);
}
.type {
  display: inline-block;
  padding: 0 6px;
  border-radius: 4px;
  background: var(--accent-soft);
  color: var(--accent);
  font-family: var(--mono);
  font-size: 11px;
}
.mono {
  font-family: var(--mono);
  font-size: 11.5px;
}
.fold {
  margin-top: var(--sp-2);
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
  background: var(--bg);
}
.fold summary {
  cursor: pointer;
  padding: 7px 10px;
  font-size: 12px;
  color: var(--text-muted);
  user-select: none;
}
.fold ul {
  margin: 0;
  padding: 0 12px 10px 28px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.8;
}
.fold pre {
  margin: 0;
  padding: 0 12px 10px;
  max-height: 260px;
  overflow: auto;
  font-size: 11px;
  line-height: 1.6;
}
.before {
  color: var(--text-faint);
  text-decoration: line-through;
}
.after {
  color: var(--accent);
}
.danger {
  color: #a32d2d;
}
.msg {
  margin: var(--sp-1) 0 0;
  font-size: 12px;
  color: var(--accent);
}
.msg.error {
  color: #a32d2d;
}
.clarify {
  margin: var(--sp-2) 0;
  padding: 9px 11px;
  border-radius: var(--r-sm);
  background: #fdf6e9;
  border: 0.5px solid #f0d8a8;
  color: #854f0b;
  font-size: 12px;
  line-height: 1.7;
}
.ops {
  margin-top: var(--sp-2);
}
.cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: var(--sp-2);
  margin-top: var(--sp-2);
}
.faint {
  color: var(--text-faint);
  font-size: 11px;
}
</style>
