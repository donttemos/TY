/*
 * @file Studio 前端 API 客户端
 * @description 只与本地 `fw studio` 服务通信：
 *   - token 从 URL 参数取（服务启动时打印的地址自带），之后的请求都带 `x-studio-token`；
 *   - 不缓存业务数据、不做业务判断——风险分级与 diff 全部由服务端给出，前端只呈现。
 * @author donttemo
 * @created 2026-10-22
 * @modified 2026-10-22 错误改为 StudioApiError（带服务端错误码）：前端不再裸抛 Error，
 *   也满足 check:no-raw-throw 门禁。
 * @module studio-web
 */

/** 字段（与服务端 FieldDoc 同构） */
export interface FieldDoc {
  name: string;
  type: string;
  optional: boolean;
  isList: boolean;
  attrs: string;
  /** `///` 文档注释（可编辑，会写回 schema） */
  comment?: string;
  /** 中文标注（注释优先，其次命名推断） */
  label?: string;
  labelSource?: LabelSource;
}

/** 模型视图 */
export type LabelSource = 'comment' | 'suggested' | 'none';

export interface ModelView {
  name: string;
  /** 中文标注（schema 注释优先，其次命名推断） */
  label?: string;
  labelSource?: LabelSource;
  /** schema 里的模型级 `///` 注释（可编辑，会写回） */
  comment?: string;
  fields: FieldDoc[];
  blockAttrs: string[];
}

/** 编辑指令（与服务端 ModelEdit 同构） */
export interface ModelEdit {
  model: string;
  renameTo?: string;
  fields?: FieldDoc[];
  blockAttrs?: string[];
  create?: boolean;
}

/** 结构问题 */
export interface SchemaIssue {
  level: 'error' | 'warn';
  message: string;
}

/** 风险发现 */
export interface EditFinding {
  level: 'confirm' | 'blocked';
  model: string;
  field?: string;
  reason: string;
}

/** 预览结果 */
export interface PreviewResult {
  /** 服务端实际用于计算的编辑指令：apply 必须原样回传，否则确认令牌指纹不匹配 */
  edits: ModelEdit[];
  touched: string[];
  diff: string;
  content: string;
  issues: SchemaIssue[];
  assessment: { risk: 'safe' | 'confirm' | 'blocked'; findings: EditFinding[] };
  confirmToken?: string;
}

/** 项目体检（只取界面用到的字段） */
export interface ProjectInfo {
  root: string;
  shape: string;
  layout: { backendRoot: string; webRoot: string; schemaFile: string; schemaExists: boolean };
  environment: { name: string; status: 'ok' | 'warn' | 'error'; detail: string }[];
}

/** 后台任务记录（与服务端 JobRecord 同构） */
export interface JobRecord {
  id: string;
  action: string;
  status: 'running' | 'succeeded' | 'failed' | 'killed';
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  lines: string[];
  error?: string;
}

/** 生成物漂移项 */
export interface DriftItem {
  path: string;
  status: 'unchanged' | 'modified' | 'missing' | 'untracked';
}

/** 单模型漂移 */
export interface ModelDrift {
  model: string;
  files: DriftItem[];
  affected: number;
}

/** 生成选项 */
export interface GenOptions {
  /** 只预演（--dry，不落盘） */
  dry?: boolean;
  /** 跳过迁移 */
  noMigrate?: boolean;
  /** 跳过定向种子 */
  noSeed?: boolean;
  /** 放行破坏性迁移 */
  allowDestructive?: boolean;
  /** 覆盖用户改过的产物（--force） */
  force?: boolean;
}

/** 服务地址与令牌 */
const params = new URLSearchParams(location.search);
const token = params.get('token') ?? '';

/**
 * Studio 接口错误
 * @description 带服务端错误码：界面能区分「token 失效 / 参数不合法 / 内部错误」，
 *   而不是拿到一个只有文案的 Error 再靠字符串猜。
 */
export class StudioApiError extends Error {
  /** 服务端错误码（如 unauthorized / invalid-edits） */
  readonly code: string;
  /** 原始响应体（含 issues 等结构化细节） */
  readonly details?: unknown;

  /**
   * @param code 服务端错误码
   * @param message 可展示的文案
   * @param details 原始响应体
   */
  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = 'StudioApiError';
    this.code = code;
    this.details = details;
  }
}

/**
 * 发请求并解析 JSON
 * @param path 接口路径
 * @param init fetch 选项
 */
async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      'x-studio-token': token,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  const data = text ? (JSON.parse(text) as unknown) : {};
  if (!response.ok) {
    const detail = data as { message?: string; error?: string };
    // 401 单独给可操作文案：令牌变了（重启/轮换），旧页面必须换地址重开
    const message =
      response.status === 401
        ? 'Studio 已重启或令牌已轮换：请用终端打印的最新地址重新打开页面'
        : (detail.message ?? `HTTP ${response.status}`);
    throw new StudioApiError(detail.error ?? `http-${response.status}`, message, data);
  }
  return data as T;
}

/** 读取项目体检 */
export const getProject = (): Promise<ProjectInfo> => call<ProjectInfo>('/api/project');

/** 读取模型列表 */
export const getSchema = (): Promise<{ exists: boolean; file: string; models: ModelView[] }> =>
  call<{ exists: boolean; file: string; models: ModelView[] }>('/api/schema');

/** 预览编辑（不落盘） */
export const previewEdits = (edits: ModelEdit[]): Promise<PreviewResult & { ok: boolean }> =>
  call<PreviewResult & { ok: boolean }>('/api/schema/preview', { method: 'POST', body: JSON.stringify({ edits }) });

/** 规划一条多对一关系（两端字段由服务端生成），返回可应用的 edits 与预览 */
export const planRelation = (
  from: string,
  to: string,
  required = false,
): Promise<PreviewResult & { ok: boolean }> =>
  call<PreviewResult & { ok: boolean }>('/api/schema/relation', {
    method: 'POST',
    body: JSON.stringify({ from, to, required }),
  });

/** 应用编辑（风险非 safe 时必须带 confirmToken） */
export const applyEdits = (
  edits: ModelEdit[],
  confirmToken?: string,
): Promise<{ ok: boolean; touched: string[]; backupFile: string | null; diff: string; risk: string }> =>
  call('/api/schema/apply', { method: 'POST', body: JSON.stringify({ edits, confirmToken }) });

/** 启动生成任务（服务端拼装命令，前端只提交模型与开关） */
export const startGen = (models: string[], options: GenOptions = {}): Promise<{ ok: boolean; jobId: string }> =>
  call('/api/gen', { method: 'POST', body: JSON.stringify({ models, ...options }) });

/** 读取任务状态（本地工具用轮询：2 次/秒足够，且不依赖代理行为） */
export const getJob = (id: string): Promise<JobRecord> => call<JobRecord>(`/api/jobs/${id}`);

/** 查询生成物漂移（哪些文件被用户改过） */
export const getDrift = (): Promise<{ ok: boolean; tracked: boolean; models: ModelDrift[] }> =>
  call('/api/gen/drift');

/** AI 审查配置状态（永不返回密钥） */
export interface ReviewInfo {
  ok: boolean;
  /** 是否已配置密钥与模型 */
  configured: boolean;
  /** 目标地址（为空表示用默认） */
  baseUrl: string;
  /** 模型名 */
  model: string;
}

/** 读取 AI 审查配置状态 */
export const getReviewInfo = (): Promise<ReviewInfo> => call<ReviewInfo>('/api/review');

/** 启动 AI 审查任务（models 为空 = 审查全部生成物） */
export const startReview = (
  models: string[],
  split: 'auto' | 'model' | 'file' = 'auto',
): Promise<{ ok: boolean; jobId: string }> =>
  call('/api/review', { method: 'POST', body: JSON.stringify({ models, split }) });

/** 建模上下文摘要（界面展示「读到了什么」） */
export interface DraftContextSummary {
  database: string;
  models: number;
  modelNames: string[];
  conventions: string;
  truncated: boolean;
}

/** 建模接口结果 */
export interface ModelDraftResult {
  ok: boolean;
  draft: Record<string, unknown>;
  attempts: number;
  warnings: string[];
  context: DraftContextSummary;
}

/** 读取建模上下文与可用状态 */
export const getDraftContext = (): Promise<{ ok: boolean; configured: boolean; context: DraftContextSummary }> =>
  call('/api/model-draft');

/** AI 路由状态（不含密钥） */
export interface AiRouteStatus {
  ok?: boolean;
  configured: boolean;
  baseUrl: string;
  model: string;
  apiKeySet: boolean;
  /** 生效超时（毫秒） */
  timeoutMs: number;
  source: 'file' | 'env' | 'none';
  file: string;
  error?: string;
}

/** 读取 AI 路由配置状态 */
export const getAiConfig = (): Promise<AiRouteStatus> => call<AiRouteStatus>('/api/ai-config');

/** 保存 AI 路由（apiKey 留空 = 不修改；clearApiKey = 删除） */
export const saveAiConfig = (patch: {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  clearApiKey?: boolean;
  timeoutMs?: number;
}): Promise<AiRouteStatus> =>
  call<AiRouteStatus>('/api/ai-config', { method: 'POST', body: JSON.stringify(patch) });

/** 测试连接（调用 /models，不产生推理费用） */
export const testAiConfig = (input: { baseUrl?: string; apiKey?: string }): Promise<{ ok: boolean; message: string; models?: number }> =>
  call('/api/ai-config/test', { method: 'POST', body: JSON.stringify(input) });

/** 拉取可用模型名（GET {baseUrl}/models；失败也 200，用 ok 区分） */
export const fetchAiModels = (input: { baseUrl?: string; apiKey?: string }): Promise<{ ok: boolean; models: string[]; message: string }> =>
  call('/api/ai-config/models', { method: 'POST', body: JSON.stringify(input) });

/** 生成模型草案（只读，不写 schema） */
export const createModelDraft = (
  requirement: string,
  options: { mode?: 'create' | 'revise'; baseRevision?: number; draft?: Record<string, unknown> } = {},
): Promise<ModelDraftResult> =>
  call('/api/model-draft', { method: 'POST', body: JSON.stringify({ requirement, ...options }) });

/** 诊断结果（模型列表 + 最小对话两步） */
export interface AiDiagnoseStep {
  name: 'models' | 'chat';
  ok: boolean;
  message: string;
  status?: number;
  elapsedMs: number;
}

/** 诊断 AI 链路（会发一条 max_tokens=1 的对话请求） */
export const diagnoseAiConfig = (input: {
  baseUrl?: string;
  apiKey?: string;
  model?: string;
}): Promise<{ ok: boolean; chatUrl: string; steps: AiDiagnoseStep[]; message: string }> =>
  call('/api/ai-config/diagnose', { method: 'POST', body: JSON.stringify(input) });

/** 设计器字段/模型（与服务端 to-editor 输出同构） */
export interface EditorField {
  name: string;
  type: string;
  optional: boolean;
  isList: boolean;
  attrs: string;
  label?: string;
}

export interface EditorModel {
  name: string;
  label?: string;
  fields: EditorField[];
  blockAttrs: string[];
}

/** 草案 → 设计器草稿（不写 schema） */
export const draftToEditor = (
  draft: Record<string, unknown>,
): Promise<{
  ok: boolean;
  models: EditorModel[];
  notes: string[];
  skipped: { model: string; reason: string }[];
}> => call('/api/model-draft/to-editor', { method: 'POST', body: JSON.stringify({ draft }) });

/** 缓存的草案 */
export interface SavedDraft {
  savedAt: string;
  draft: Record<string, unknown>;
}

/** 读取最近一份草案缓存 */
export const getSavedDraft = (): Promise<{ ok: boolean; saved: SavedDraft | null; error?: string }> =>
  call('/api/model-draft/saved');

/** 写入草案缓存 */
export const saveDraftCache = (draft: Record<string, unknown>): Promise<{ ok: boolean; savedAt: string }> =>
  call('/api/model-draft/saved', { method: 'POST', body: JSON.stringify({ draft }) });

/** 清空草案缓存 */
export const clearDraftCache = (): Promise<{ ok: boolean; cleared: boolean }> =>
  call('/api/model-draft/saved/clear', { method: 'POST', body: '{}' });

/** 增量变更（字段级 diff） */
export interface DraftChange {
  op: string;
  path: string;
  before: unknown;
  after: unknown;
  destructive: boolean;
}

/** 用自然语言对当前草案做增量修改（只返回 operations 应用后的结果） */
export const reviseDraft = (
  draft: Record<string, unknown>,
  instruction: string,
): Promise<{
  ok: boolean;
  draft: Record<string, unknown>;
  operations: unknown[];
  changes: DraftChange[];
  skipped: { op: string; reason: string }[];
  destructive: boolean;
  attempts: number;
  warnings: string[];
}> => call('/api/model-draft/revise', { method: 'POST', body: JSON.stringify({ draft, instruction }) });

/** 从 JSON 识别模型的结果（不写 schema） */
export interface ImportedModels {
  ok: boolean;
  models: EditorModel[];
  notes: string[];
  skipped: { model: string; reason: string }[];
}

/** 把粘贴的 JSON 识别成设计器草稿 */
export const importModelsJson = (json: string): Promise<ImportedModels> =>
  call('/api/schema/import-json', { method: 'POST', body: JSON.stringify({ json }) });

/** AI 补标注结果 */
export interface AnnotationSuggestions {
  ok: boolean;
  suggestions: {
    models: { name: string; label: string }[];
    fields: { model: string; name: string; label: string }[];
  };
  candidates: { models: number; fields: number };
  message?: string;
}

/** 扫描缺注释的模型/字段，让模型给出中文标注（不写盘） */
export const annotateSchema = (): Promise<AnnotationSuggestions> =>
  call('/api/schema/annotate', { method: 'POST', body: '{}' });
