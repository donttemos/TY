<!--
  @file 数据模型设计器（PRD-017 S2 / FR-17-04~11）
  @description 左侧模型列表、中间字段表格、右侧预览与风险。所有判断都来自服务端：
    风险分级、diff、结构问题一律由 /api/schema/preview 返回，前端只负责呈现与提交。
    有副作用的两步必须分开：先「预览变更」（不落盘），再「写入 schema」（风险非 safe 时需勾选确认）。
    刻意不支持：删除模型（会连带丢表与生成物，留到有专门确认流程时再做）、关系配置（下一迭代）。
  @author donttemo
  @created 2026-10-22
  @modified 2026-10-22 新增「AI 建模」页签：自然语言生成只读模型草案（FR-17-24）。
  @module studio-web
-->
<template>
  <div class="shell">
    <header class="topbar">
      <div class="brand">
        <span class="mark">TY</span>
        <span class="brand-text">
          <strong>Studio</strong>
          <span class="sub">数据建模工作台</span>
        </span>
      </div>

      <nav class="tabs">
        <button :class="{ on: tab === 'design' }" @click="tab = 'design'">
          数据模型<span class="count num">{{ models.length }}</span>
        </button>
        <button :class="{ on: tab === 'gen' }" @click="tab = 'gen'">生成代码</button>
        <button :class="{ on: tab === 'draft' }" @click="tab = 'draft'">AI 建模</button>
      </nav>

      <div class="meta">
        <span class="chip path" :title="project?.root ?? ''">{{ shortRoot }}</span>
        <span class="pill">{{ shapeLabel || '—' }}</span>
        <span v-if="editCount > 0" class="pill warn">{{ editCount }} 待写入</span>
        <span class="dots" v-if="(project?.environment ?? []).length > 0">
          <i
            v-for="item in project?.environment ?? []"
            :key="item.name"
            :class="item.status"
            :title="`${item.name}：${item.detail}`"
          />
        </span>
        <button class="ghost" title="配置 AI 接口地址、模型与密钥（保存在本机）" @click="aiOpen = true">AI 路由</button>
      </div>
    </header>

    <GenPanel v-if="tab === 'gen'" :models="models" @finished="load" />

    <ModelDraftPanel v-if="tab === 'draft'" @imported="importDraftModels" />

    <AiSettings v-if="aiOpen" @close="aiOpen = false" @saved="aiOpen = false" />
    <JsonImport v-if="jsonOpen" @close="jsonOpen = false" @imported="importDraftModels" />
    <AnnotateDialog v-if="annotateOpen" @close="annotateOpen = false" @applied="applyAnnotations" />

    <main v-show="tab === 'design'" class="grid">
      <section class="col models">
        <div class="col-head">
          <h2>模型 <span class="num">{{ filteredModels.length }}/{{ models.length }}</span></h2>
          <button class="ghost" @click="addModel">＋ 新建</button>
        </div>
        <input v-model="search" class="search" placeholder="搜索模型…" />
        <div class="tools">
          <button class="tool" @click="jsonOpen = true">＋ 从 JSON 导入</button>
          <button class="tool" @click="annotateOpen = true">AI 补标注</button>
        </div>
        <div class="list">
          <button
            v-for="model in filteredModels"
            :key="model.key"
            class="item"
            :class="{ active: model.key === selectedKey }"
            @click="selectModel(model.key)"
          >
            <span class="item-name">
              {{ model.name || '（未命名）' }}
              <span
                v-if="model.label"
                class="label"
                :class="{ suggested: model.labelSource === 'suggested' }"
                :title="model.label + (model.labelSource === 'comment' ? '（来自 schema 注释）' : '（按命名推断，未写入 schema）')"
                >（{{ shortLabel(model.label) }}）</span
              >
              <i v-if="isDirty(model)" class="dot" title="有未写入的修改" />
            </span>
            <span class="item-meta num">
              {{ model.fields.length }} 字段<template v-if="relCount(model) > 0"> · {{ relCount(model) }} 关系</template>
            </span>
          </button>
          <p v-if="filteredModels.length === 0" class="empty">
            {{ models.length === 0 ? 'schema 中没有模型' : '没有匹配的模型' }}
          </p>
        </div>
      </section>

      <section class="col fields">
        <template v-if="current">
          <div class="col-head">
            <input v-model="current.name" class="name-input" placeholder="模型名（PascalCase）" />
            <div class="head-actions">
              <button class="ghost" @click="addField">＋ 字段</button>
              <button
                @click="toggleRelation"
                :disabled="editCount > 0"
                :title="editCount > 0 ? '先保存当前修改，再建立关系' : '建立多对一关系'"
              >
                ＋ 关系
              </button>
            </div>
          </div>
          <p class="meta-line">
            <span class="num">{{ current.fields.length }}</span> 字段 ·
            <span class="num">{{ relCount(current) }}</span> 关系
            <label class="meta-label">
              标注
              <input
                v-model="current.comment"
                class="label-input"
                placeholder="写回 /// 注释"
                title="写入 schema 的模型级 /// 注释；留空则删除"
              />
            </label>
          </p>

          <div v-if="relationOpen" class="relation">
            <span>本模型多对一指向</span>
            <select v-model="relationTarget">
              <option value="" disabled>选择模型</option>
              <option v-for="model in otherModels" :key="model.key" :value="model.name">{{ model.name }}</option>
            </select>
            <label class="inline"><input type="checkbox" v-model="relationRequired" /> 外键必填</label>
            <button class="primary" @click="confirmRelation" :disabled="busy || !relationTarget">确定</button>
            <button @click="relationOpen = false">取消</button>
          </div>

          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th style="width: 19%">字段名</th>
                  <th style="width: 13%" title="灰字是按命名推断的建议；输入后作为 /// 注释写回 schema">标注</th>
                  <th style="width: 19%">类型</th>
                  <th style="width: 7%">可空</th>
                  <th style="width: 30%">属性（原样写入）</th>
                  <th style="width: 12%"></th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(field, index) in current.fields" :key="index">
                  <td><input v-model="field.name" placeholder="camelCase" /></td>
                  <td>
                    <input
                      v-model="field.comment"
                      class="label-input"
                      :placeholder="field.labelSource === 'suggested' ? field.label : '中文标注'"
                      :title="'写入 schema 的 /// 注释；留空则删除该注释'"
                    />
                  </td>
                  <td><input v-model="field.type" list="type-options" /></td>
                  <td class="center"><input type="checkbox" v-model="field.optional" /></td>
                  <td><input v-model="field.attrs" placeholder="@default(...) @unique" class="mono" /></td>
                  <td class="center"><button class="link" @click="removeField(index)" title="删除该行">移除</button></td>
                </tr>
                <tr v-if="current.fields.length === 0">
                  <td colspan="6" class="empty-row">
                    还没有字段
                    <button class="ghost" @click="addField">＋ 加一个</button>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
          <datalist id="type-options">
            <option v-for="type in typeOptions" :key="type" :value="type" />
          </datalist>
          <div class="hint">
            属性按原文写入——`@relation(onDelete: Cascade)` 这类细节不会被改坏。
          </div>
        </template>
        <p v-else class="empty">左侧选择一个模型</p>
      </section>

      <section class="col preview">
        <div class="col-head">
          <h2>预览与写入</h2>
          <span class="pill" :class="editCount > 0 ? 'accent' : ''">{{ editCount }} 个模型待变更</span>
        </div>
        <div class="actions">
          <button @click="doPreview" :disabled="busy || editCount === 0">预览变更</button>
          <button class="primary" @click="doApply" :disabled="busy || !preview || editCount === 0">写入 schema</button>
        </div>

        <p v-if="message" class="message" :class="messageKind">{{ message }}</p>

        <template v-if="preview">
          <div class="risk" :class="preview.assessment.risk">
            <strong>{{ riskLabel }}</strong>
            <ul v-if="preview.assessment.findings.length > 0">
              <li v-for="(finding, index) in preview.assessment.findings" :key="index">{{ finding.reason }}</li>
            </ul>
            <p v-else>无数据风险</p>
          </div>

          <label v-if="preview.assessment.risk !== 'safe'" class="confirm">
            <input type="checkbox" v-model="confirmed" />
            我已确认上述 {{ preview.assessment.findings.length }} 项风险，理解该操作可能影响存量数据
          </label>

          <div v-if="preview.issues.length > 0" class="issues">
            <p v-for="(issue, index) in preview.issues" :key="index">
              <b>{{ issue.level === 'error' ? '错误' : '告警' }}</b> {{ issue.message }}
            </p>
          </div>

          <div class="diff-block">
            <div class="diff-head">
              <span class="kicker">schema diff</span>
              <button class="ghost" @click="copyDiff">复制</button>
            </div>
            <pre class="diff">{{ preview.diff || '（无差异）' }}</pre>
          </div>
        </template>
        <p v-else class="empty">点「预览变更」查看将写入的内容与风险</p>
      </section>
    </main>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue';
import GenPanel from './GenPanel.vue';
import ModelDraftPanel from './ModelDraftPanel.vue';
import type { EditorModel } from './api';
import AiSettings from './AiSettings.vue';
import JsonImport from './JsonImport.vue';
import AnnotateDialog from './AnnotateDialog.vue';
import {
  applyEdits,
  getProject,
  getSchema,
  planRelation,
  previewEdits,
  type FieldDoc,
  type ModelEdit,
  type ModelView,
  type PreviewResult,
  type ProjectInfo,
} from './api';

/** 草稿模型（带前端内部 key，用于识别「同一个模型」） */
interface DraftModel extends ModelView {
  key: string;
}

/** Prisma 标量类型（类型下拉的固定部分） */
const SCALARS = ['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes'];

/** 页签可从 URL 深链进来（?tab=gen），刷新/分享后停在原页 */
function initialTab(): 'design' | 'gen' | 'draft' {
  const value = new URLSearchParams(location.search).get('tab');
  return value === 'gen' || value === 'draft' ? value : 'design';
}
const tab = ref<'design' | 'gen' | 'draft'>(initialTab());
/** 模型列表搜索 */
const search = ref('');
/** AI 路由设置弹层 */
const aiOpen = ref(false);
/** JSON 识别弹层（?import=1 可直接打开，便于把「导入链接」发给同事） */
const jsonOpen = ref(new URLSearchParams(location.search).get('import') === '1');
/** AI 补标注弹层 */
const annotateOpen = ref(false);
const project = ref<ProjectInfo | null>(null);
const models = ref<DraftModel[]>([]);
const selectedKey = ref<string>('');
/** 服务端的原始状态（key → 模型），用于算增量编辑 */
const original = ref<Map<string, ModelView>>(new Map());
const preview = ref<PreviewResult | null>(null);
/** 关系表单 */
const relationOpen = ref(false);
const relationTarget = ref('');
const relationRequired = ref(false);
const confirmed = ref(false);
const busy = ref(false);
const message = ref('');
const messageKind = ref<'ok' | 'warn' | 'error'>('ok');
let keySeed = 0;

const current = computed(() => models.value.find((model) => model.key === selectedKey.value) ?? null);

/** 搜索过滤（只过滤列表，不影响选中项） */
const filteredModels = computed(() => {
  const keyword = search.value.trim().toLowerCase();
  if (keyword === '') return models.value;
  return models.value.filter((model) => model.name.toLowerCase().includes(keyword));
});

/** 顶部只显示路径末两段，完整路径放 title */
const shortRoot = computed(() => {
  const root = project.value?.root ?? '';
  const parts = root.split(/[\\/]/).filter(Boolean);
  return parts.slice(-2).join('/') || root || '加载中…';
});

const shapeLabel = computed(
  () => ({ monorepo: 'monorepo', 'admin-template': 'admin 模板', single: '单项目' })[project.value?.shape ?? ''] ?? '',
);

/** 类型下拉：标量 + 已有模型名（枚举名可直接输入） */
const typeOptions = computed(() => [...SCALARS, ...models.value.map((model) => model.name).filter(Boolean)]);

/** 可作为关系目标的模型（排除自身） */
const otherModels = computed(() => models.value.filter((model) => model.key !== selectedKey.value));

const riskLabel = computed(
  () => ({ safe: '安全变更', confirm: '需要确认', blocked: '高风险（阻断级）' })[preview.value?.assessment.risk ?? 'safe'],
);

/** 把服务端模型装入草稿 */
function loadModels(list: ModelView[]): void {
  models.value = list.map((model) => ({ ...model, key: `m${(keySeed += 1)}` }));
  original.value = new Map(
    models.value.map((model) => [
      model.key,
      {
        name: model.name,
        fields: cloneFields(model.fields),
        blockAttrs: [...model.blockAttrs],
        ...(model.comment === undefined ? {} : { comment: model.comment }),
      },
    ]),
  );
  selectedKey.value = models.value[0]?.key ?? '';
  preview.value = null;
  confirmed.value = false;
}

/** 深拷贝字段，避免草稿改动影响原始快照 */
function cloneFields(fields: FieldDoc[]): FieldDoc[] {
  return fields.map((field) => ({ ...field }));
}

/** 模型是否有未提交改动 */
function isDirty(model: DraftModel): boolean {
  const base = original.value.get(model.key);
  if (!base) return true;
  return (
    base.name !== model.name ||
    (base.comment ?? '') !== (model.comment ?? '') ||
    JSON.stringify(base.fields) !== JSON.stringify(model.fields)
  );
}

/** 计算增量编辑（只发改过的模型） */
function collectEdits(): ModelEdit[] {
  const edits: ModelEdit[] = [];
  for (const model of models.value) {
    const base = original.value.get(model.key);
    if (!base) {
      edits.push({ model: model.name, create: true, fields: model.fields, blockAttrs: model.blockAttrs });
      continue;
    }
    const renamed = base.name !== model.name;
    const fieldsChanged = JSON.stringify(base.fields) !== JSON.stringify(model.fields);
    const commentChanged = (base.comment ?? '') !== (model.comment ?? '');
    if (!renamed && !fieldsChanged && !commentChanged) continue;
    edits.push({
      model: base.name,
      ...(renamed ? { renameTo: model.name } : {}),
      fields: model.fields,
      blockAttrs: model.blockAttrs,
      comment: model.comment ?? '',
    });
  }
  return edits;
}

const editCount = computed(() => collectEdits().length);

/** 选中模型 */
function selectModel(key: string): void {
  selectedKey.value = key;
  preview.value = null;
  confirmed.value = false;
  message.value = '';
}

/**
 * 把 AI 草案导入设计器：只进本地草稿（不写盘），
 * 之后走现有的「预览变更 → 写入 schema」，风险分级与令牌校验都沿用原链路。
 */
function importDraftModels(payload: { models: EditorModel[]; notes: string[] }): void {
  for (const model of payload.models) {
    // 没有 original 快照 → isDirty 为 true → collectEdits 会按「新建模型」提交
    models.value.push({ ...model, key: `m${(keySeed += 1)}` });
  }
  const first = payload.models[0];
  const target = first ? models.value.find((model) => model.name === first.name) : null;
  if (target) selectedKey.value = target.key;
  tab.value = 'design';
  preview.value = null;
  confirmed.value = false;
  messageKind.value = 'ok';
  const notes = payload.notes.length > 0 ? `；${payload.notes.join('；')}` : '';
  message.value = `已导入 ${payload.models.length} 个模型到设计器（草稿，未写盘）。请检查字段后点「预览变更」再写入${notes}`;
}

/** 列表里只显示注释的第一段（`用户（PRD-003 FR-01）` → `用户`），完整值在 title 里 */
function shortLabel(label: string): string {
  const head = label.split(/[（(]/)[0].trim();
  return head === '' ? label : head;
}

/** 关系字段数（属性里出现 @relation 即算） */
function relCount(model: { fields: { attrs: string }[] }): number {
  return model.fields.filter((field) => /@relation\b/.test(field.attrs)).length;
}

/** 新增字段：给一个合法占位，直接可改 */
function addField(): void {
  if (!current.value) return;
  current.value.fields.push({
    name: `field${current.value.fields.length + 1}`,
    type: 'String',
    optional: true,
    isList: false,
    attrs: '',
  });
  preview.value = null;
  confirmed.value = false;
}

/** 复制 diff（浏览器可能拒绝剪贴板权限，失败要说明） */
async function copyDiff(): Promise<void> {
  if (!preview.value?.diff) return;
  try {
    await navigator.clipboard.writeText(preview.value.diff);
    messageKind.value = 'ok';
    message.value = 'diff 已复制到剪贴板';
  } catch {
    messageKind.value = 'warn';
    message.value = '复制失败：浏览器未授权剪贴板';
  }
}

/** 应用 AI 标注：只改本地草稿，仍需预览写入 */
function applyAnnotations(payload: {
  models: { name: string; label: string }[];
  fields: { model: string; name: string; label: string }[];
}): void {
  let count = 0;
  for (const item of payload.models) {
    const model = models.value.find((candidate) => candidate.name === item.name);
    if (!model) continue;
    model.comment = item.label;
    model.label = item.label;
    model.labelSource = 'comment';
    count += 1;
  }
  for (const item of payload.fields) {
    const model = models.value.find((candidate) => candidate.name === item.model);
    const field = model?.fields.find((candidate) => candidate.name === item.name);
    if (!field) continue;
    field.comment = item.label;
    field.label = item.label;
    field.labelSource = 'comment';
    count += 1;
  }
  preview.value = null;
  confirmed.value = false;
  messageKind.value = 'ok';
  message.value = `已填入 ${count} 处标注（未写盘）：请点「预览变更」确认后再写入`;
}

/** 新增模型（默认给一个主键字段，避免空模型） */
function addModel(): void {
  const key = `m${(keySeed += 1)}`;
  models.value.push({
    key,
    name: `Model${models.value.length + 1}`,
    fields: [{ name: 'id', type: 'String', optional: false, isList: false, attrs: '@id @default(uuid())' }],
    blockAttrs: [],
  });
  selectModel(key);
}

/** 删除字段（阻断级操作，需在预览里确认） */
function removeField(index: number): void {
  if (!current.value) return;
  current.value.fields.splice(index, 1);
  preview.value = null;
  confirmed.value = false;
}

/** 打开/关闭关系表单 */
function toggleRelation(): void {
  relationOpen.value = !relationOpen.value;
  relationTarget.value = '';
  relationRequired.value = false;
}

/**
 * 建立关系：由服务端生成两端字段，再把结果并回草稿并进入预览态。
 * 只在「无未保存修改」时可用——否则并回去会覆盖用户正在编辑的内容。
 */
async function confirmRelation(): Promise<void> {
  if (!current.value || !relationTarget.value) return;
  busy.value = true;
  message.value = '';
  try {
    const result = await planRelation(current.value.name, relationTarget.value, relationRequired.value);
    for (const edit of result.edits) {
      const draft = models.value.find((model) => model.name === edit.model);
      if (draft && edit.fields) draft.fields = edit.fields.map((field) => ({ ...field }));
    }
    preview.value = result;
    confirmed.value = false;
    relationOpen.value = false;
    messageKind.value = 'ok';
    message.value = `已生成关系：${result.touched.join(' ↔ ')}（确认后写入）`;
  } catch (error) {
    messageKind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

/** 载入项目与 schema */
async function load(): Promise<void> {
  busy.value = true;
  try {
    project.value = await getProject();
    const schema = await getSchema();
    loadModels(schema.models);
    message.value = '';
  } catch (error) {
    message.value = error instanceof Error ? error.message : String(error);
    messageKind.value = 'error';
  } finally {
    busy.value = false;
  }
}

/** 预览：只算不写 */
async function doPreview(): Promise<void> {
  busy.value = true;
  message.value = '';
  try {
    preview.value = await previewEdits(collectEdits());
    confirmed.value = false;
  } catch (error) {
    preview.value = null;
    message.value = error instanceof Error ? error.message : String(error);
    messageKind.value = 'error';
  } finally {
    busy.value = false;
  }
}

/** 写入：风险非 safe 时必须勾选确认并携带令牌 */
async function doApply(): Promise<void> {
  if (!preview.value) return;
  if (preview.value.assessment.risk !== 'safe' && !confirmed.value) {
    message.value = '存在风险项：请先勾选确认，再写入';
    messageKind.value = 'warn';
    return;
  }
  busy.value = true;
  try {
    // 必须用预览时那份 edits：重新 collect 可能与预览时的指纹不一致，令牌会失效
    const result = await applyEdits(preview.value.edits, preview.value.confirmToken);
    messageKind.value = 'ok';
    message.value = `已写入：${result.touched.join('、')}｜备份 ${result.backupFile ?? '（无）'}`;
    await load();
  } catch (error) {
    messageKind.value = 'error';
    message.value = error instanceof Error ? error.message : String(error);
  } finally {
    busy.value = false;
  }
}

// 草稿一改，旧预览（含令牌）立即失效：避免「看着旧的 diff 点写入」
watch(
  () => JSON.stringify(models.value.map((model) => [model.name, model.fields])),
  () => {
    if (preview.value) {
      preview.value = null;
      confirmed.value = false;
      messageKind.value = 'warn';
      message.value = '内容已改动，请重新预览';
    }
  },
);

// 页签变化同步到地址栏，便于刷新保持与分享
watch(tab, (value) => {
  const url = new URL(location.href);
  url.searchParams.set('tab', value);
  history.replaceState(null, '', url);
});

onMounted(load);
</script>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  min-height: 100vh;
}

/* 顶部：品牌 / 页签 / 项目元信息三层分离，不再挤成一行 */
.topbar {
  display: flex;
  align-items: center;
  gap: var(--sp-4);
  padding: 10px 18px;
  background: var(--surface);
  border-bottom: 0.5px solid var(--border-strong);
  position: sticky;
  top: 0;
  z-index: 10;
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
}
.mark {
  width: 26px;
  height: 26px;
  border-radius: 8px;
  background: linear-gradient(135deg, #185fa5, #2f7fc4);
  color: #fff;
  font-size: 11px;
  font-weight: 600;
  display: grid;
  place-items: center;
  letter-spacing: 0.02em;
}
.brand-text {
  display: flex;
  flex-direction: column;
  line-height: 1.15;
}
.brand-text strong {
  font-size: 13px;
  font-weight: 600;
}
.brand-text .sub {
  font-size: 11px;
  color: var(--text-faint);
}
.tabs {
  display: flex;
  gap: 2px;
  padding: 2px;
  background: var(--bg);
  border-radius: 8px;
}
.tabs button {
  height: 26px;
  border: none;
  background: transparent;
  color: var(--text-muted);
  border-radius: 6px;
  font-size: 12px;
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.tabs button:hover:not(:disabled) {
  background: #fff;
}
.tabs button.on {
  background: var(--surface);
  color: var(--text);
  font-weight: 500;
  box-shadow: var(--shadow-1);
}
.tabs .count {
  font-size: 10px;
  color: var(--text-faint);
  background: var(--bg);
  border-radius: 999px;
  padding: 0 5px;
  line-height: 14px;
}
.tabs button.on .count {
  background: var(--accent-soft);
  color: var(--accent);
}
.meta {
  margin-left: auto;
  display: flex;
  align-items: center;
  gap: 8px;
}
.path {
  max-width: 260px;
}
.dots {
  display: flex;
  gap: 5px;
  padding: 0 2px;
}
.dots i {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  display: block;
}
.dots i.ok {
  background: var(--ok);
}
.dots i.warn {
  background: var(--warn);
}
.dots i.error {
  background: var(--danger);
}

/* 三列工作区 */
.grid {
  flex: 1;
  display: grid;
  grid-template-columns: 236px minmax(0, 1.2fr) minmax(0, 1fr);
  gap: var(--sp-3);
  padding: var(--sp-4) 18px var(--sp-5);
  align-items: start;
}
.col {
  background: var(--surface);
  border: 0.5px solid var(--border-strong);
  border-radius: var(--r-md);
  padding: var(--sp-3) var(--sp-3) var(--sp-4);
  min-height: 260px;
  box-shadow: var(--shadow-1);
}
.col-head {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  margin-bottom: var(--sp-2);
}
.col-head h2 {
  font-size: 12px;
  font-weight: 500;
  color: var(--text-faint);
  letter-spacing: 0.02em;
  margin: 0;
  flex: 1;
}
.col-head h2 .num {
  color: var(--text-muted);
}
.head-actions {
  display: flex;
  gap: 4px;
}
.meta-line {
  margin: 0 0 var(--sp-2);
  font-size: 11px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}
.meta-line .faint {
  margin-left: auto;
  font-size: 11px;
}

/* 模型列表 */
.search {
  width: 100%;
  height: 26px;
  margin-bottom: var(--sp-2);
  font-size: 12px;
}
.tools {
  display: flex;
  gap: 6px;
  margin-bottom: var(--sp-2);
}
.tool {
  flex: 1;
  height: 26px;
  border: 0.5px dashed var(--border-strong);
  background: transparent;
  color: var(--text-muted);
  font-size: 11.5px;
  padding: 0 6px;
}
.tool:hover:not(:disabled) {
  border-color: var(--accent);
  color: var(--accent);
  background: var(--accent-soft);
}
.meta-label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11px;
  color: var(--text-faint);
}
.meta-label .label-input {
  width: 180px;
  height: 24px;
  font-size: 11.5px;
}
.list {
  display: flex;
  flex-direction: column;
  gap: 1px;
  /* 模型多时在卡片内滚动，不把整页拉长 */
  max-height: calc(100vh - 210px);
  overflow: auto;
}
.item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--sp-2);
  text-align: left;
  border: none;
  background: transparent;
  border-radius: var(--r-sm);
  padding: 6px 8px;
  height: auto;
}
.item:hover {
  background: var(--bg);
}
.item.active {
  background: var(--accent-soft);
}
.item.active .item-name,
.item.active .item-meta {
  color: var(--accent);
}
.item-name {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12.5px;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.label {
  color: var(--text-muted);
  font-size: 11.5px;
  max-width: 108px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  display: inline-block;
  vertical-align: bottom;
}
.label.suggested {
  border-bottom: 1px dashed var(--border-strong);
  color: var(--text-faint);
}
.label-chip {
  padding: 0 6px;
  border-radius: 999px;
  background: var(--bg);
  border: 0.5px solid var(--border);
  font-size: 11px;
  color: var(--text-muted);
}
.label-chip.suggested {
  border-style: dashed;
  color: var(--text-faint);
}
.label-input {
  font-size: 11.5px;
}
.dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--warn);
  display: inline-block;
  flex: none;
}
.item-meta {
  font-size: 11px;
  color: var(--text-faint);
  white-space: nowrap;
}

/* 字段表 */
.name-input {
  flex: 1;
  font-weight: 500;
  height: 30px;
}
.table-wrap {
  max-height: calc(100vh - 320px);
  overflow: auto;
  margin: 0 -4px;
}
table {
  width: 100%;
  /* 固定列宽：否则长 placeholder 会把「移除」列挤到只能竖排 */
  table-layout: fixed;
  border-collapse: separate;
  border-spacing: 0;
}
thead th {
  position: sticky;
  top: 0;
  z-index: 1;
  background: var(--surface);
}
th {
  text-align: left;
  font-weight: 400;
  font-size: 11px;
  color: var(--text-faint);
  padding: 4px 6px 6px;
  border-bottom: 0.5px solid var(--border);
  white-space: nowrap;
}
td {
  padding: 2px 4px;
  border-bottom: 0.5px solid var(--line-soft);
}
tbody tr:hover td {
  background: #fcfcfa;
}
td input:not([type='checkbox']) {
  width: 100%;
  height: 26px;
  border-color: transparent;
  background: transparent;
}
td input:not([type='checkbox']):hover {
  border-color: var(--border);
}
td input:not([type='checkbox']):focus {
  background: var(--surface);
  border-color: var(--accent);
}
td.center {
  text-align: center;
}
.mono {
  font-family: var(--mono);
  font-size: 12px;
}
.empty-row {
  padding: 18px 6px;
  text-align: center;
  color: var(--text-faint);
  font-size: 12px;
}
.empty-row button {
  margin-left: 6px;
}
.link {
  border: none;
  background: transparent;
  color: var(--text-faint);
  height: 24px;
  padding: 0 6px;
  font-size: 11px;
  white-space: nowrap;
}
.link:hover:not(:disabled) {
  color: var(--danger);
  background: transparent;
}
.relation {
  display: flex;
  align-items: center;
  gap: var(--sp-2);
  padding: 8px 10px;
  margin-bottom: var(--sp-2);
  background: var(--accent-soft);
  border: 0.5px solid #cfe3f7;
  border-radius: var(--r-sm);
  font-size: 12px;
  flex-wrap: wrap;
}
.relation .inline {
  display: flex;
  align-items: center;
  gap: 4px;
}
.hint {
  margin-top: var(--sp-2);
  font-size: 11px;
  color: var(--text-faint);
  line-height: 1.6;
}

/* 预览与写入 */
.actions {
  display: flex;
  gap: var(--sp-2);
  margin-bottom: var(--sp-3);
  flex-wrap: wrap;
}
.message {
  margin: 0 0 var(--sp-3);
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
.risk {
  padding: 10px 12px;
  border-radius: var(--r-sm);
  font-size: 12px;
  background: var(--bg);
  border: 0.5px solid var(--border);
  line-height: 1.7;
}
.risk strong {
  display: block;
  margin-bottom: 2px;
}
.risk ul {
  margin: 4px 0 0;
  padding-left: 18px;
  color: var(--text-muted);
}
.risk p {
  margin: 2px 0 0;
  color: var(--text-faint);
}
.risk.confirm {
  background: #fdf6e9;
  border-color: #f0d8a8;
}
.risk.blocked {
  background: #fdf0f0;
  border-color: #f0c4c4;
}
.confirm {
  display: flex;
  gap: 8px;
  align-items: flex-start;
  margin: var(--sp-2) 0;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.6;
}
.issues {
  font-size: 12px;
  color: var(--text-muted);
  margin: var(--sp-2) 0;
}
.issues b {
  color: var(--danger);
  font-weight: 500;
}
.diff-block {
  margin-top: var(--sp-2);
}
.diff-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 4px;
}
.diff-head .kicker {
  margin: 0;
}
.diff {
  margin: 0;
  padding: 10px 12px;
  background: #fbfbf8;
  border: 0.5px solid var(--border);
  border-radius: var(--r-sm);
  max-height: 360px;
  overflow: auto;
  white-space: pre-wrap;
  line-height: 1.6;
  font-size: 11.5px;
}
.empty {
  color: var(--text-faint);
  font-size: 12px;
  padding: var(--sp-3) 0;
  margin: 0;
}
.faint {
  color: var(--text-faint);
  font-size: 11px;
}
</style>
