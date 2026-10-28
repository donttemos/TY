/*
 * @file 从 JSON 识别模型（PRD-017 FR-17-04 补充）
 * @description 允许把外部 JSON（AI 草案信封、手写的表结构、`{模型名: {字段…}}` 映射）
 *   识别成设计器草稿。**只做解析与归一化，不写盘**；写入仍走「预览变更 → 写入 schema」。
 *   宽容但有限：接受三种常见形态，字段类型支持 `String?` / `String[]` 简写；
 *   超过 50 个模型或 1000 个字段直接拒绝——那是脚本该干的事，不是粘贴框。
 * @author donttemo
 * @created 2026-10-28
 * @module cli/model-designer
 * @since v0.8.0
 */

/** 解析结果（draft 信封可直接交给 draftToEditorModels） */
export interface ParsedJsonDraft {
  draft: { models: Record<string, unknown>[] };
  /** 解析中做的归一化说明（展示给用户） */
  notes: string[];
}

/** 上限：粘贴框不是批量导入工具 */
export const MAX_IMPORT_MODELS = 50;
export const MAX_IMPORT_FIELDS = 1000;

/** 是否普通对象 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 标量类型白名单（其余按枚举/自定义类型放行，交给后续 preview 判定） */
const SCALARS = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);

/**
 * 解析类型简写：`String?`、`String[]`、`TagStatus`
 * @param raw 原始类型文本
 */
export function parseTypeShorthand(raw: string): { type: string; nullable: boolean; isList: boolean } {
  let text = raw.trim();
  let isList = false;
  let nullable = false;
  if (text.endsWith('[]')) {
    isList = true;
    text = text.slice(0, -2).trim();
  }
  if (text.endsWith('?')) {
    nullable = true;
    text = text.slice(0, -1).trim();
  }
  return { type: text, nullable, isList };
}

/**
 * 归一化单个字段
 * @param name 字段名（映射形态时来自 key）
 * @param raw 字段定义（字符串类型或对象）
 */
function normalizeField(name: string, raw: unknown): Record<string, unknown> {
  const base: Record<string, unknown> = {
    name,
    type: 'String',
    nullable: true,
    default: null,
    unique: false,
    indexed: false,
    relation: null,
  };
  if (typeof raw === 'string') {
    const parsed = parseTypeShorthand(raw);
    return { ...base, type: parsed.type, nullable: parsed.nullable, isList: parsed.isList };
  }
  if (!isObject(raw)) return base;

  const typeText = typeof raw.type === 'string' ? raw.type : 'String';
  const parsed = parseTypeShorthand(typeText);
  const nullable =
    typeof raw.nullable === 'boolean' ? raw.nullable : typeof raw.optional === 'boolean' ? raw.optional : parsed.nullable;
  return {
    ...base,
    ...(typeof raw.display_name === 'string' ? { display_name: raw.display_name } : {}),
    type: parsed.type,
    nullable,
    ...(typeof raw.isList === 'boolean' ? { isList: raw.isList } : parsed.isList ? { isList: true } : {}),
    ...('default' in raw ? { default: raw.default } : {}),
    ...(raw.unique === true ? { unique: true } : {}),
    ...(raw.indexed === true ? { indexed: true } : {}),
    ...(Array.isArray(raw.enum_values) ? { enum_values: raw.enum_values.map(String) } : {}),
    ...(isObject(raw.relation) ? { relation: raw.relation } : {}),
    ...(typeof raw.precision === 'number' ? { precision: raw.precision } : {}),
    ...(typeof raw.scale === 'number' ? { scale: raw.scale } : {}),
  };
}

/**
 * 把字段集合（数组或映射）归一成数组
 * @param raw models[].fields / 表结构的 fields
 */
function normalizeFields(raw: unknown): Record<string, unknown>[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((item) => isObject(item) && typeof item.name === 'string')
      .map((item) => normalizeField(String((item as Record<string, unknown>).name), item));
  }
  if (isObject(raw)) {
    return Object.entries(raw).map(([name, value]) => normalizeField(name, value));
  }
  return [];
}

/**
 * 归一化单个模型
 * @param name 模型名（映射形态时来自 key）
 * @param raw 模型定义
 */
function normalizeModel(name: string, raw: unknown): Record<string, unknown> {
  const model: Record<string, unknown> = {
    name,
    action: 'create',
    fields: [],
    indexes: [],
    relations: [],
  };
  if (!isObject(raw)) return model;
  if (typeof raw.display_name === 'string') model.display_name = raw.display_name;
  if (typeof raw.description === 'string') model.description = raw.description;
  model.fields = normalizeFields(raw.fields ?? raw.columns ?? raw.properties);
  const indexes = Array.isArray(raw.indexes)
    ? raw.indexes.filter(isObject)
    : Array.isArray(raw.indices)
      ? raw.indices.filter(isObject)
      : [];
  model.indexes = indexes;
  model.relations = Array.isArray(raw.relations) ? raw.relations.filter(isObject) : [];
  return model;
}

/**
 * 识别并归一化 JSON
 * @param text 粘贴的 JSON 文本
 * @throws 语法错误、结构不认识、超上限
 */
export function parseModelsJson(text: string): ParsedJsonDraft {
  const trimmed = text.trim();
  if (trimmed === '') throw new Error('JSON 为空');
  if (trimmed.length > 512 * 1024) throw new Error('JSON 过大（超过 512KB）：请拆成多次导入');

  let root: unknown;
  try {
    root = JSON.parse(trimmed);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`JSON 语法错误：${detail}`);
  }

  const notes: string[] = [];
  const models: Record<string, unknown>[] = [];

  const pushModel = (name: string, value: unknown): void => {
    const model = normalizeModel(name.trim(), value);
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(String(model.name))) {
      throw new Error(`模型名不合法：${String(model.name)}（需字母开头，只含字母数字下划线）`);
    }
    if (models.some((item) => item.name === model.name)) {
      notes.push(`跳过重复模型 ${model.name}`);
      return;
    }
    models.push(model);
  };

  // 形态 A：{ models: [...] }（AI 草案信封 / 手写）
  if (isObject(root) && Array.isArray(root.models)) {
    for (const item of root.models) {
      if (!isObject(item) || typeof item.name !== 'string') {
        throw new Error('models[] 里每一项都得有 name');
      }
      pushModel(item.name, item);
    }
  } else if (isObject(root) && isObject(root.models)) {
    // 形态 B：{ models: { Tag: {...} } }
    for (const [name, value] of Object.entries(root.models)) pushModel(name, value);
  } else if (Array.isArray(root)) {
    // 形态 C：[{ name, fields }, ...]
    for (const item of root) {
      if (!isObject(item) || typeof item.name !== 'string') {
        throw new Error('数组里每一项都得有 name（[{ "name": "Tag", "fields": [...] }]）');
      }
      pushModel(item.name, item);
    }
  } else if (isObject(root) && (Array.isArray(root.tables) || isObject(root.tables))) {
    // 形态 D：{ tables: [...] }（部分建模工具导出）
    const tables = root.tables;
    if (Array.isArray(tables)) {
      for (const item of tables) {
        if (!isObject(item) || typeof item.name !== 'string') throw new Error('tables[] 里每一项都得有 name');
        pushModel(item.name, item);
      }
    } else if (isObject(tables)) {
      for (const [name, value] of Object.entries(tables)) pushModel(name, value);
    }
    notes.push('已把 tables 识别为模型');
  } else if (isObject(root)) {
    // 形态 E：{ Tag: { fields: {...} }, Product: {...} }（顶层就是模型映射）
    const entries = Object.entries(root).filter(([, value]) => isObject(value));
    if (entries.length === 0) throw new Error('认不出结构：支持 {models:[...]}、[{name,fields}]、{Tag:{fields}}');
    for (const [name, value] of entries) pushModel(name, value);
    notes.push('已把顶层对象按模型名识别');
  } else {
    throw new Error('认不出结构：支持 {models:[...]}、[{name,fields}]、{Tag:{fields}}');
  }

  if (models.length === 0) throw new Error('没有识别到任何模型');
  if (models.length > MAX_IMPORT_MODELS) throw new Error(`一次最多识别 ${MAX_IMPORT_MODELS} 个模型`);

  const fieldCount = models.reduce((sum, model) => sum + (model.fields as unknown[]).length, 0);
  if (fieldCount > MAX_IMPORT_FIELDS) throw new Error(`字段总数 ${fieldCount} 超过 ${MAX_IMPORT_FIELDS}，请分批导入`);
  if (fieldCount === 0) notes.push('识别到的模型都没有字段定义：请补 fields');

  const unknownTypes = new Set<string>();
  for (const model of models) {
    for (const field of model.fields as Record<string, unknown>[]) {
      const type = String(field.type);
      if (!SCALARS.has(type)) unknownTypes.add(type);
    }
  }
  if (unknownTypes.size > 0) {
    notes.push(`这些类型按枚举/自定义处理，需在 schema 里已定义：${[...unknownTypes].join('、')}`);
  }

  return { draft: { models }, notes };
}
