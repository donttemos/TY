/*
 * @file AI 补标注（PRD-017 FR-17-28 补充）
 * @description 只给**缺注释**的模型/字段生成中文标注建议，返回结构由服务端校验：
 *   模型名/字段名必须存在、标注长度受限、多余项直接丢弃。
 *   生成结果**不写盘**：前端填入草稿后仍要走「预览变更 → 写入 schema」。
 * @author donttemo
 * @created 2026-10-28
 * @module cli/studio
 * @since v0.8.0
 */

import type { ModelView } from './schema-api.js';

/** 待补标注的候选 */
export interface AnnotateCandidate {
  model: string;
  /** 模型级注释缺失（false 表示只补字段） */
  needModel: boolean;
  /** 缺注释的字段 */
  fields: { name: string; type: string }[];
}

/** 建议 */
export interface AnnotationSuggestions {
  models: { name: string; label: string }[];
  fields: { model: string; name: string; label: string }[];
}

/** 单次送模型的候选上限 */
export const MAX_ANNOTATE_MODELS = 30;
export const MAX_ANNOTATE_FIELDS = 400;
/** 标注长度上限（中文一般 2~8 字） */
export const MAX_LABEL_LENGTH = 20;

/**
 * 只挑缺注释的模型与字段
 * @param models schema 模型视图
 */
export function collectAnnotateCandidates(models: ModelView[]): AnnotateCandidate[] {
  const candidates: AnnotateCandidate[] = [];
  for (const model of models) {
    const needModel = model.labelSource !== 'comment';
    const fields = model.fields
      .filter((field) => field.labelSource !== 'comment')
      .map((field) => ({ name: field.name, type: field.type }));
    if (!needModel && fields.length === 0) continue;
    candidates.push({ model: model.name, needModel, fields });
  }
  return candidates.slice(0, MAX_ANNOTATE_MODELS);
}

/**
 * 构造提示词
 * @param candidates 候选
 */
export function buildAnnotateMessages(candidates: AnnotateCandidate[]): { role: 'system' | 'user'; content: string }[] {
  const payload = {
    models: candidates.map((candidate) => ({
      name: candidate.model,
      fields: candidate.fields.map((field) => `${field.name}:${field.type}`),
    })),
  };
  return [
    {
      role: 'system',
      content: [
        '你是数据建模助手。为给定的模型与字段起简洁的中文业务名称（标注）。',
        '要求：',
        '1. 只输出一个 JSON 对象，不要 Markdown、不要解释；',
        '2. 结构：{"models":[{"name":"模型名","label":"中文名","fields":[{"name":"字段名","label":"中文名"}]}]}；',
        '3. 模型名/字段名必须与输入完全一致，不要新增或改名；',
        '4. label 为 2~8 个汉字，忠实于名称与类型，不要编造业务细节；',
        '5. 字段名是 id/createdAt 这类通用字段时用通用译名（ID、创建时间）。',
      ].join('\n'),
    },
    { role: 'user', content: JSON.stringify(payload) },
  ];
}

/**
 * 解析并校验模型输出
 * @param text 模型返回的 JSON 文本
 * @param candidates 候选（用于过滤不存在的模型/字段）
 * @throws JSON 非法时抛错
 */
export function parseAnnotateResult(text: string, candidates: AnnotateCandidate[]): AnnotationSuggestions {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text.trim());
  } catch (error) {
    throw new Error(`模型没有返回合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  const root = (parsed ?? {}) as { models?: unknown };
  const rows = Array.isArray(root.models) ? root.models : [];
  const known = new Map(
    candidates.map((candidate) => [
      candidate.model,
      { needModel: candidate.needModel, fields: new Set(candidate.fields.map((field) => field.name)) },
    ]),
  );

  const models: AnnotationSuggestions['models'] = [];
  const fields: AnnotationSuggestions['fields'] = [];
  const seenModels = new Set<string>();
  const seenFields = new Set<string>();
  const clean = (value: unknown): string =>
    typeof value === 'string' ? value.trim().replace(/\s+/g, ' ').slice(0, MAX_LABEL_LENGTH) : '';

  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue;
    const name = typeof (row as { name?: unknown }).name === 'string' ? (row as { name: string }).name : '';
    const candidate = known.get(name);
    if (candidate === undefined) continue; // 不存在的模型直接丢
    const fieldSet = candidate.fields;
    const label = clean((row as { label?: unknown }).label);
    if (label !== '' && candidate.needModel && !seenModels.has(name)) {
      seenModels.add(name);
      models.push({ name, label });
    }
    const fieldRows = Array.isArray((row as { fields?: unknown }).fields)
      ? ((row as { fields: unknown[] }).fields)
      : [];
    for (const fieldRow of fieldRows) {
      if (typeof fieldRow !== 'object' || fieldRow === null) continue;
      const fieldName = typeof (fieldRow as { name?: unknown }).name === 'string' ? (fieldRow as { name: string }).name : '';
      if (!fieldSet.has(fieldName)) continue;
      const fieldLabel = clean((fieldRow as { label?: unknown }).label);
      const fieldKey = `${name}.${fieldName}`;
      if (fieldLabel !== '' && !seenFields.has(fieldKey)) {
        seenFields.add(fieldKey);
        fields.push({ model: name, name: fieldName, label: fieldLabel });
      }
    }
  }

  if (models.length === 0 && fields.length === 0) throw new Error('模型没有给出可用的标注建议');
  return { models, fields };
}

/** 统计候选规模（用于日志与上限提示） */
export function candidateStats(candidates: AnnotateCandidate[]): { models: number; fields: number } {
  return {
    models: candidates.filter((candidate) => candidate.needModel).length,
    fields: candidates.reduce((sum, candidate) => sum + candidate.fields.length, 0),
  };
}
