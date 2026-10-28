/*
 * @file schema 编辑的接口层（TY Studio S2 / PRD-017 FR-17-09/10/11）
 * @description 设计器与服务之间的唯一写通道，三件事：
 *   ① 风险分级（assessEdits）：删模型 / 删字段 / 新增必填无默认值 → 阻断；改名 / 改类型 / 改必填 → 需确认；
 *   ② 预览（previewEdits）：算出新全文与 diff，**不落盘**；风险非 safe 时签发一次性确认令牌；
 *   ③ 应用（applyEdits）：校验令牌 → 调 writeBackSchema（结构自检 + prisma validate + 备份 + 原子写）。
 *   令牌与「当前磁盘内容 + 编辑指令」绑定：预览后文件被别人改过，令牌自动失效——
 *   避免「看着 A 预览、实际写到 B」这类最危险的情况。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

import crypto from 'node:crypto';
import type { Exec } from '../deploy/exec.js';
import { pluralize } from '../gen/type-map.js';
import { docCommentOf, suggestLabel } from '../model-designer/labels.js';
import {
  applyModelEdits,
  parseModel,
  simpleDiff,
  splitSchema,
  structuralIssues,
  writeBackSchema,
  type FieldDoc,
  type ModelEdit,
  type SchemaIssue,
} from './schema-doc.js';

/** 风险级别 */
export type EditRisk = 'safe' | 'confirm' | 'blocked';

/** 风险发现项 */
export interface EditFinding {
  level: Exclude<EditRisk, 'safe'>;
  model: string;
  field?: string;
  reason: string;
}

/** 编辑评估结果 */
export interface EditAssessment {
  risk: EditRisk;
  findings: EditFinding[];
}

/** 关系请求（多对一：from 持有外键指向 to） */
export interface RelationRequest {
  /** 持有外键的一侧（子模型） */
  from: string;
  /** 被引用的一侧（父模型） */
  to: string;
  /** 外键是否必填（默认 false，避免存量行无法满足） */
  required?: boolean;
  /** 外键列名（默认 <to>Id） */
  fkName?: string;
  /** 关系字段名（默认 <to> 小驼峰） */
  fieldName?: string;
}

/** 标注来源：真实注释 / 命名推断 / 无 */
export type LabelSource = 'comment' | 'suggested' | 'none';

/** 供界面渲染的字段视图（附带中文标注，不参与写回） */
export interface FieldView extends FieldDoc {
  /** 中文标注（注释优先，其次推断；可能为空） */
  label: string;
  labelSource: LabelSource;
}

/** 供界面渲染的模型视图 */
export interface ModelView {
  name: string;
  /** 中文标注（注释优先，其次推断；可能为空） */
  label: string;
  labelSource: LabelSource;
  /** schema 里的模型级 `///` 注释原文（用于编辑与写回） */
  comment?: string;
  fields: FieldView[];
  blockAttrs: string[];
}

/**
 * 取中文标注：真实注释优先，其次按命名推断
 * @param name 模型/字段名
 * @param comment schema 里的 `///` 注释
 */
function resolveLabel(name: string, comment?: string): { label: string; labelSource: LabelSource } {
  const text = (comment ?? '').trim();
  if (text !== '') return { label: text, labelSource: 'comment' };
  const suggested = suggestLabel(name);
  return suggested === '' ? { label: '', labelSource: 'none' } : { label: suggested, labelSource: 'suggested' };
}

/** 接口错误码（服务端据此映射 HTTP 状态） */
/**
 * 写接口错误码
 * @description `ai-not-configured` 来自 review 入口（同属「请求本身不成立」），
 *   复用同一错误类型是为了让前端拿到统一的 `{ error, message }` 结构。
 */
export type SchemaEditErrorCode = 'invalid-edits' | 'confirm-required' | 'invalid-token' | 'ai-not-configured';

/** 编辑接口错误 */
export class SchemaEditError extends Error {
  readonly code: SchemaEditErrorCode;

  /**
   * @param code 机器可读错误码
   * @param message 面向用户的中文说明
   */
  constructor(code: SchemaEditErrorCode, message: string) {
    super(message);
    this.name = 'SchemaEditError';
    this.code = code;
  }
}

/** 预览结果 */
export interface PreviewResult {
  /** 被改动的模型 */
  touched: string[];
  /** 行级差异（未改动时为「」） */
  diff: string;
  /** 新全文（供界面展示，不落盘） */
  content: string;
  /** 编辑后 schema 的结构问题 */
  issues: SchemaIssue[];
  /** 风险评估 */
  assessment: EditAssessment;
  /** 内容指纹（应用时校验令牌用） */
  fingerprint: string;
  /** 风险非 safe 时必填的一次性确认令牌 */
  confirmToken?: string;
}

/** 应用结果 */
export interface ApplyOutcome {
  touched: string[];
  backupFile: string | null;
  diff: string;
  risk: EditRisk;
}

/**
 * 列出模型（供界面渲染）
 * @param text schema 原文
 */
export function listModels(text: string): ModelView[] {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  /** 取 block 起始行上方紧邻的 `///` 注释（模型级标注） */
  const modelComment = (startLine: number): string | undefined => {
    let cursor = startLine - 1;
    let comment: string | undefined;
    while (cursor >= 0) {
      const line = lines[cursor] ?? '';
      const doc = docCommentOf(line);
      if (doc !== null) {
        comment = doc;
        cursor -= 1;
        continue;
      }
      if (line.trim() === '') {
        cursor -= 1;
        continue;
      }
      break;
    }
    return comment;
  };

  return splitSchema(text)
    .filter((block) => block.kind === 'model' && block.name)
    .map((block) => {
      const model = parseModel(block);
      const comment = modelComment(block.startLine);
      const modelLabel = resolveLabel(model.name, comment);
      const fields: FieldView[] = model.fields.map((field) => ({
        ...field,
        ...resolveLabel(field.name, field.comment),
      }));
      return {
        name: model.name,
        ...modelLabel,
        ...(comment === undefined ? {} : { comment }),
        fields,
        blockAttrs: model.blockAttrs,
      };
    });
}

/** 判断字段是否为「必填且无默认值」（新增这类字段会让存量行无法满足） */
function isRequiredWithoutDefault(field: FieldDoc): boolean {
  return !field.optional && !field.isList && !/@default\b/.test(field.attrs);
}

/** 首字母小写 */
function lowerFirst(value: string): string {
  return value.length === 0 ? value : `${value[0].toLowerCase()}${value.slice(1)}`;
}

/**
 * 生成「多对一」关系的编辑指令（两端都写）
 * @description Prisma 强制要求关系两端同时声明，只写子端会直接校验失败（P1012）。
 *   因此关系的拼写规则放在服务端统一生成，界面只提交「谁指向谁」：
 *   - 子端：外键标量字段 + `@relation(fields: [...], references: [id])` 关系字段；
 *   - 父端：反向数组字段 `<from>[]`（已存在同名反向字段则跳过，保证幂等）。
 *   默认外键可空：新增必填外键会让存量行无法满足（与 assessEdits 的阻断口径一致）。
 * @param text 当前 schema 原文
 * @param request 关系请求
 */
export function buildRelationEdits(text: string, request: RelationRequest): ModelEdit[] {
  const models = new Map(listModels(text).map((model) => [model.name, model]));
  const from = models.get(request.from);
  const to = models.get(request.to);

  if (request.from === request.to) {
    throw new SchemaEditError('invalid-edits', '暂不支持自关联（同一模型指向自身），请先手工编写');
  }
  if (!from) throw new SchemaEditError('invalid-edits', `模型不存在：${request.from}`);
  if (!to) throw new SchemaEditError('invalid-edits', `模型不存在：${request.to}`);

  const fkName = request.fkName?.trim() || `${lowerFirst(request.to)}Id`;
  const fieldName = request.fieldName?.trim() || lowerFirst(request.to);
  const backName = lowerFirst(request.from);
  const backFieldName = pluralize(backName);

  if (from.fields.some((field) => field.name === fkName)) {
    throw new SchemaEditError('invalid-edits', `${request.from} 已存在字段 ${fkName}（换一个外键名，或直接在字段表里维护）`);
  }
  if (from.fields.some((field) => field.name === fieldName)) {
    throw new SchemaEditError('invalid-edits', `${request.from} 已存在字段 ${fieldName}`);
  }
  if (to.fields.some((field) => field.name === backFieldName)) {
    throw new SchemaEditError('invalid-edits', `${request.to} 已存在反向字段 ${backFieldName}（该关系可能已建立）`);
  }

  const optional = request.required !== true;
  const childFields: FieldDoc[] = [
    ...from.fields,
    { name: fkName, type: 'String', optional, isList: false, attrs: '' },
    {
      name: fieldName,
      type: request.to,
      optional,
      isList: false,
      attrs: `@relation(fields: [${fkName}], references: [id])`,
    },
  ];
  // 反向字段是列表：Prisma 里列表不能带 `?`（`Product[]?` 是非法 schema），因此 optional 必须 false
  const parentFields: FieldDoc[] = [
    ...to.fields,
    { name: backFieldName, type: request.from, optional: false, isList: true, attrs: '' },
  ];

  return [
    { model: request.from, fields: childFields, blockAttrs: from.blockAttrs },
    { model: request.to, fields: parentFields, blockAttrs: to.blockAttrs },
  ];
}

/**
 * 评估编辑的数据风险
 * @param text 当前 schema 原文
 * @param edits 编辑指令
 */
export function assessEdits(text: string, edits: ModelEdit[]): EditAssessment {
  const current = new Map(listModels(text).map((model) => [model.name, model]));
  const findings: EditFinding[] = [];

  for (const edit of edits) {
    const before = current.get(edit.model);

    // 新建模型：没有数据风险
    if (edit.create === true) continue;

    if (!before) {
      findings.push({ level: 'blocked', model: edit.model, reason: `模型 ${edit.model} 不存在（新建请显式标记 create）` });
      continue;
    }

    if (edit.renameTo && edit.renameTo !== before.name) {
      findings.push({
        level: 'confirm',
        model: before.name,
        reason: `重命名 ${before.name} → ${edit.renameTo}：已生成的模块、菜单与权限码会失配，需要重新生成`,
      });
    }

    if (!edit.fields) continue;

    const afterByName = new Map(edit.fields.map((field) => [field.name, field]));
    const beforeByName = new Map(before.fields.map((field) => [field.name, field]));

    for (const field of before.fields) {
      const next = afterByName.get(field.name);
      if (!next) {
        findings.push({
          level: 'blocked',
          model: before.name,
          field: field.name,
          reason: `删除字段 ${before.name}.${field.name}：该列历史数据会丢失，且不可撤销`,
        });
        continue;
      }
      if (next.type !== field.type) {
        findings.push({
          level: 'confirm',
          model: before.name,
          field: field.name,
          reason: `改类型 ${before.name}.${field.name}：${field.type} → ${next.type}，可能截断或丢失精度`,
        });
      }
      if (field.optional && !next.optional) {
        findings.push({
          level: 'confirm',
          model: before.name,
          field: field.name,
          reason: `改为必填 ${before.name}.${field.name}：存量空值行会在迁移时失败`,
        });
      }
    }

    for (const field of edit.fields) {
      if (beforeByName.has(field.name)) continue;
      if (isRequiredWithoutDefault(field)) {
        findings.push({
          level: 'blocked',
          model: before.name,
          field: field.name,
          reason: `新增必填字段 ${before.name}.${field.name} 且无默认值：存量行无法满足约束`,
        });
      }
    }
  }

  const risk: EditRisk = findings.some((finding) => finding.level === 'blocked')
    ? 'blocked'
    : findings.length > 0
      ? 'confirm'
      : 'safe';
  return { risk, findings };
}

/** 计算「当前内容 + 编辑」的指纹（令牌绑定用） */
export function editFingerprint(text: string, edits: ModelEdit[]): string {
  const hash = crypto.createHash('sha256');
  hash.update(text);
  hash.update('\u0000');
  hash.update(JSON.stringify(edits));
  return hash.digest('hex');
}

/** 一次性确认令牌的存储（进程内，服务重启即失效） */
export class ConfirmTokenStore {
  private readonly tokens = new Map<string, { fingerprint: string; expiresAt: number }>();

  /**
   * @param ttlMs 有效期（默认 5 分钟）
   * @param now 时钟（测试注入）
   */
  constructor(private readonly ttlMs = 5 * 60 * 1000, private readonly now: () => number = () => Date.now()) {}

  /**
   * 签发令牌
   * @param fingerprint 内容指纹
   */
  issue(fingerprint: string): string {
    const token = crypto.randomBytes(18).toString('base64url');
    this.tokens.set(token, { fingerprint, expiresAt: this.now() + this.ttlMs });
    return token;
  }

  /**
   * 消费令牌（单次有效；指纹不匹配即拒绝）
   * @param token 令牌
   * @param fingerprint 当前内容指纹
   */
  consume(token: string, fingerprint: string): boolean {
    const record = this.tokens.get(token);
    if (!record) return false;
    // 无论成功与否都销毁：令牌不可复用，失败也不允许重试同一张
    this.tokens.delete(token);
    if (this.now() > record.expiresAt) return false;
    return record.fingerprint === fingerprint;
  }

  /** 当前未使用令牌数（测试用） */
  size(): number {
    return this.tokens.size;
  }
}

/**
 * 预览编辑（不落盘）
 * @param text 当前 schema 原文
 * @param edits 编辑指令
 * @param store 令牌存储（风险非 safe 时签发）
 */
export function previewEdits(text: string, edits: ModelEdit[], store: ConfirmTokenStore): PreviewResult {
  if (edits.length === 0) {
    throw new SchemaEditError('invalid-edits', '编辑指令为空');
  }
  let content: string;
  let touched: string[];
  try {
    const applied = applyModelEdits(text, edits);
    content = applied.content;
    touched = applied.touched;
  } catch (error) {
    throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
  }

  const assessment = assessEdits(text, edits);
  const fingerprint = editFingerprint(text, edits);
  const result: PreviewResult = {
    touched,
    diff: simpleDiff(text, content),
    content,
    issues: structuralIssues(content),
    assessment,
    fingerprint,
  };
  if (assessment.risk !== 'safe' && touched.length > 0) {
    result.confirmToken = store.issue(fingerprint);
  }
  return result;
}

/** 应用选项 */
export interface ApplyOptions {
  /** 当前 schema 原文（由服务端从磁盘读取） */
  text: string;
  /** 编辑指令 */
  edits: ModelEdit[];
  /** schema 绝对路径 */
  schemaFile: string;
  /** 备份目录 */
  backupDir: string;
  /** 风险非 safe 时必填 */
  confirmToken?: string;
  /** 令牌存储 */
  store: ConfirmTokenStore;
  /** 跳过 prisma validate（仅测试用） */
  skipValidate?: boolean;
  /** 执行器（透传给 validate） */
  exec?: Exec;
}

/**
 * 应用编辑（校验令牌 → 结构自检 → prisma validate → 备份 → 原子写）
 * @param options 选项
 */
export async function applyEdits(options: ApplyOptions): Promise<ApplyOutcome> {
  if (options.edits.length === 0) {
    throw new SchemaEditError('invalid-edits', '编辑指令为空');
  }
  const assessment = assessEdits(options.text, options.edits);
  if (assessment.risk !== 'safe') {
    if (!options.confirmToken) {
      throw new SchemaEditError(
        'confirm-required',
        `该变更包含 ${assessment.findings.length} 项风险，需要先预览并确认：${assessment.findings.map((item) => item.reason).join('；')}`,
      );
    }
    const fingerprint = editFingerprint(options.text, options.edits);
    if (!options.store.consume(options.confirmToken, fingerprint)) {
      throw new SchemaEditError('invalid-token', '确认令牌无效或已过期（预览后 schema 可能已变化），请重新预览');
    }
  }

  let result;
  try {
    result = await writeBackSchema(options.text, options.edits, {
      schemaFile: options.schemaFile,
      backupDir: options.backupDir,
      skipValidate: options.skipValidate,
      exec: options.exec,
    });
  } catch (error) {
    throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
  }

  return { touched: result.touched, backupFile: result.backupFile, diff: result.diff, risk: assessment.risk };
}
