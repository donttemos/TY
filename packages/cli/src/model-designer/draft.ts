/*
 * @file 模型草案生成编排（PRD-017 FR-17-24）
 * @description 读上下文 → 调模型（JSON 模式）→ 结构/语义校验 → 失败带路径回灌重试 1 次。
 *   与审查不同：这里的输出会被后续编辑器与 Schema 写回消费，**校验不过就绝不返回半成品**。
 *   只读：不写文件、不改 schema、不落库；草案是否存在由调用方决定。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/model-designer
 * @since v0.8.0
 */

import { chatCompletion } from '../review/provider.js';
import { resolveAiConfig, type AiConfig } from '../review/config.js';
import { buildDesignerContext, type DesignerContext } from './context.js';
import {
  collectPolicyViolations,
  normalizeDraft,
  validateModelDraft,
  type DraftIssue,
} from './draft-schema.js';
import { buildDraftMessages, type DraftRequest } from './prompt.js';

/** 错误码（HTTP 层直接映射） */
export type DraftErrorCode =
  | 'invalid-input'
  | 'ai-not-configured'
  | 'model-failed'
  | 'invalid-json'
  | 'schema-invalid'
  | 'revision-conflict'
  | 'policy';

/** 草案错误 */
export class DraftError extends Error {
  readonly code: DraftErrorCode;
  /** 校验问题（schema-invalid 时给前若干条） */
  readonly issues: DraftIssue[];

  /**
   * @param code 错误码
   * @param message 面向人的说明
   * @param issues 结构化问题
   */
  constructor(code: DraftErrorCode, message: string, issues: DraftIssue[] = []) {
    super(message);
    this.name = 'DraftError';
    this.code = code;
    this.issues = issues;
  }
}

/** 请求（HTTP 层已做基础类型校验） */
export interface DraftInput {
  /** 业务描述 */
  requirement: string;
  /** create / revise */
  mode: 'create' | 'revise';
  /** revise 的基准版本 */
  baseRevision?: number;
  /** revise 的当前草案 */
  draft?: Record<string, unknown>;
}

/** 可注入依赖 */
export interface DraftDeps {
  /** fetch 替身（测试） */
  fetchImpl?: typeof fetch;
  /** 已解析配置 */
  config?: AiConfig;
  /** 环境变量 */
  env?: NodeJS.ProcessEnv;
  /** 已采集上下文（测试） */
  context?: DesignerContext;
  /** 项目根（默认 cwd） */
  projectRoot?: string;
  /** 后台应用名 */
  app?: string;
  /** 显式 schema 路径 */
  schema?: string;
  /** 调用超时 */
  timeoutMs?: number;
}

/** 结果 */
export interface DraftResult {
  /** 已校验、已校准的草案 */
  draft: Record<string, unknown>;
  /** 实际调用次数（1 或 2） */
  attempts: number;
  /** 校准过程中产生的提示 */
  warnings: string[];
  /** 本次使用的上下文摘要（不回传 schema 全文） */
  context: DesignerContext;
}

/** 需求长度上限（与 docs/51 一致） */
export const MAX_REQUIREMENT_LENGTH = 4000;

/** 最多调用次数（首次 + 1 次重试） */
const MAX_ATTEMPTS = 2;

/** 每轮最多回灌的问题条数（防止反馈消息本身超长） */
const MAX_FEEDBACK_ISSUES = 10;

/**
 * 把校验问题转成可回灌的纯文本
 * @param issues 问题列表
 */
function feedbackOf(issues: DraftIssue[]): string {
  return issues
    .slice(0, MAX_FEEDBACK_ISSUES)
    .map((issue) => `- ${issue.path}：${issue.message}（${issue.code}）`)
    .join('\n');
}

/** 解析模型输出（剥掉可能的围栏，但不宽容地修复 JSON） */
function parseDraftJson(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  // 个别供应商无视 response_format 会套围栏：只剥围栏，不猜内容
  const unfenced = trimmed.startsWith('```')
    ? trimmed.replace(/^```[a-zA-Z]*\n?/, '').replace(/\n?```$/, '')
    : trimmed;
  let parsed: unknown;
  try {
    parsed = JSON.parse(unfenced);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new DraftError('invalid-json', `模型输出不是合法 JSON：${detail}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new DraftError('invalid-json', '模型输出必须是 JSON 对象');
  }
  return parsed as Record<string, unknown>;
}

/**
 * 生成模型草案
 * @param input 请求
 * @param deps 可注入依赖
 * @returns 已校验的草案
 */
export async function runDraftDesign(input: DraftInput, deps: DraftDeps = {}): Promise<DraftResult> {
  const requirement = input.requirement.trim();
  if (requirement === '') throw new DraftError('invalid-input', '需求描述不能为空');
  if (requirement.length > MAX_REQUIREMENT_LENGTH) {
    throw new DraftError('invalid-input', `需求描述过长（${requirement.length} 字，上限 ${MAX_REQUIREMENT_LENGTH}）`);
  }

  // 1. revise 的基准：必须能落到一个明确的 revision 上
  let baseRevision = 0;
  if (input.mode === 'revise') {
    const draft = input.draft;
    const draftRevision = draft && Number.isInteger(draft.revision) ? Number(draft.revision) : null;
    if (draftRevision === null) {
      throw new DraftError('invalid-input', 'revise 模式必须带当前草案（含整数 revision）');
    }
    baseRevision = input.baseRevision ?? draftRevision;
    if (baseRevision !== draftRevision) {
      throw new DraftError(
        'revision-conflict',
        `草案版本已变化（请求 ${baseRevision}，当前 ${draftRevision}）：请刷新草案后重新描述修改`,
      );
    }
  }

  const context = deps.context ?? buildDesignerContext({
    projectRoot: deps.projectRoot ?? process.cwd(),
    app: deps.app,
    schema: deps.schema,
  });

  let config: AiConfig;
  try {
    config = deps.config ?? resolveAiConfig({ env: deps.env });
  } catch (error) {
    throw new DraftError('ai-not-configured', error instanceof Error ? error.message : String(error));
  }

  const request: DraftRequest = {
    mode: input.mode,
    requirement,
    baseRevision,
    draft: input.draft,
  };
  const existingModels = context.existing_models.map((model) => model.name);

  let feedback: string | undefined;
  let previousOutput: string | undefined;
  let lastIssues: DraftIssue[] = [];
  let lastError: DraftError | null = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    let raw: string;
    try {
      raw = await chatCompletion({
        config,
        messages: buildDraftMessages(request, context, feedback, previousOutput),
        fetchImpl: deps.fetchImpl,
        timeoutMs: deps.timeoutMs ?? config.timeoutMs,
        temperature: 0.2,
        responseFormat: 'json_object',
      });
    } catch (error) {
      throw new DraftError('model-failed', error instanceof Error ? error.message : String(error));
    }

    let parsed: Record<string, unknown>;
    try {
      parsed = parseDraftJson(raw);
    } catch (error) {
      if (!(error instanceof DraftError)) throw error;
      lastError = error;
      if (attempt === MAX_ATTEMPTS) break;
      feedback = error.message;
      previousOutput = raw;
      continue;
    }

    // 2. 安全策略：出现供应商/密钥相关键 → 整份拒绝，不重试（疑似提示注入）
    const violations = collectPolicyViolations(parsed);
    if (violations.length > 0) {
      throw new DraftError('policy', `模型输出包含禁止字段（${violations.join('、')}），已拒绝`, [
        { path: violations[0], code: 'POLICY', message: '不得输出供应商、接口地址或密钥' },
      ]);
    }

    // 3. 先做「软修复」（缺省参数、UI 布尔、无效索引），再做结构 + 语义校验：
    //    模型漏一个布尔值不该让整份草案不可用，硬约束（命名/关系/破坏性）仍然拒绝
    const normalized = normalizeDraft(parsed, { existingModels });
    const issues = validateModelDraft(normalized.draft, { existingModels, baseRevision, mode: input.mode });
    if (issues.length === 0) {
      return {
        draft: normalized.draft,
        attempts: attempt,
        warnings: normalized.warnings,
        context,
      };
    }

    lastIssues = issues;
    const rejection = parsed.status === 'rejected' ? String(parsed.error_code) : '';
    if (rejection === 'E_REVISION_CONFLICT') {
      throw new DraftError('revision-conflict', '模型判定草案版本不一致：请刷新后重试', issues);
    }
    if (attempt === MAX_ATTEMPTS) break;
    feedback = feedbackOf(issues);
    previousOutput = raw;
  }

  if (lastIssues.length > 0) {
    throw new DraftError(
      'schema-invalid',
      `草案连续 ${MAX_ATTEMPTS} 次未通过校验（已把问题回灌给模型重试 1 次）：${feedbackOf(lastIssues)}；可精简需求描述或换更稳的模型`,
      lastIssues,
    );
  }
  throw lastError ?? new DraftError('model-failed', '模型未返回可用草案');
}
