/*
 * @file 草案 → 设计器草稿（PRD-017 FR-17-24 第三步）
 * @description 把 AI 草案转成设计器可承载的字段结构，**不写盘**：
 *   - 只处理 action=create（更新/删除涉及存量数据，交给设计器手动改）；
 *   - 按项目约定补齐框架字段（id / tenantId / 审计四件套 / deletedAt），否则写回时 prisma validate 必失败；
 *   - 字段约束翻译成 Prisma 属性：默认值、@unique、@@index / @@unique；
 *   - 关系只保留外键标量，并提示用「＋关系」补两端（Prisma 关系必须两端同时声明）。
 * @author donttemo
 * @created 2026-10-23
 * @module cli/model-designer
 * @since v0.8.0
 */

import type { DesignerContext } from './context.js';
import { suggestLabel } from './labels.js';

/** 设计器字段（与 studio-web 的 FieldDoc 同构） */
export interface EditorField {
  name: string;
  type: string;
  optional: boolean;
  isList: boolean;
  /** 原样写入的属性文本 */
  attrs: string;
  /** 中文标注（来自草案 display_name，缺失时按命名推断） */
  label?: string;
}

/** 设计器模型（与 ModelView 同构，前端补 key） */
export interface EditorModel {
  name: string;
  /** 中文标注（来自草案 display_name，缺失时按命名推断） */
  label?: string;
  fields: EditorField[];
  blockAttrs: string[];
}

/** 转换结果 */
export interface ToEditorResult {
  models: EditorModel[];
  notes: string[];
  skipped: { model: string; reason: string }[];
}

/** 框架字段定义（按约定补齐时使用） */
const FRAMEWORK_FIELDS: Record<string, Omit<EditorField, 'name'>> = {
  id: { type: 'String', optional: false, isList: false, attrs: '@id @default(uuid())' },
  tenantId: { type: 'String', optional: false, isList: false, attrs: '' },
  createdAt: { type: 'DateTime', optional: false, isList: false, attrs: '@default(now())' },
  updatedAt: { type: 'DateTime', optional: false, isList: false, attrs: '@updatedAt' },
  createdBy: { type: 'String', optional: false, isList: false, attrs: '@default("system")' },
  updatedBy: { type: 'String', optional: false, isList: false, attrs: '@default("system")' },
  deletedAt: { type: 'DateTime', optional: true, isList: false, attrs: '' },
};

/** 是否普通对象 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * 默认值翻译成 Prisma 属性
 * @param field 草案字段
 * @returns 属性文本（无默认值返回空串）
 */
export function defaultAttr(field: Record<string, unknown>): string {
  if (!('default' in field) || field.default === null || field.default === undefined) return '';
  const value = field.default;
  if (Array.isArray(field.enum_values) && typeof value === 'string') return `@default(${value})`;
  if (typeof value === 'boolean') return `@default(${value})`;
  if (typeof value === 'number') return `@default(${value})`;
  if (typeof value === 'string') {
    if (field.type === 'DateTime') return '@default(now())';
    return `@default("${value.replace(/"/g, '\\"')}")`;
  }
  return '';
}

/**
 * 单个草案字段 → 设计器字段
 * @param field 草案字段
 * @param database 数据库类型（决定是否写 @db.Decimal）
 */
function toEditorField(field: Record<string, unknown>, database: string): EditorField {
  const parts: string[] = [];
  const def = defaultAttr(field);
  if (def !== '') parts.push(def);
  if (field.unique === true) parts.push('@unique');
  if ((database === 'postgresql' || database === 'mysql') && field.type === 'Decimal') {
    const precision = typeof field.precision === 'number' ? field.precision : 18;
    const scale = typeof field.scale === 'number' ? field.scale : 2;
    parts.push(`@db.Decimal(${precision}, ${scale})`);
  }
  const label =
    typeof field.display_name === 'string' && field.display_name.trim() !== ''
      ? field.display_name.trim()
      : suggestLabel(String(field.name));
  return {
    name: String(field.name),
    type: String(field.type),
    optional: field.nullable === true,
    isList: false,
    attrs: parts.join(' '),
    ...(label === '' ? {} : { label }),
  };
}

/**
 * 草案模型 → 设计器草稿
 * @param draft 已校验草案
 * @param options 约定与数据库类型
 */
export function draftToEditorModels(
  draft: Record<string, unknown>,
  options: { conventions: DesignerContext['conventions']; database: string },
): ToEditorResult {
  const notes: string[] = [];
  const skipped: { model: string; reason: string }[] = [];
  const models: EditorModel[] = [];
  const rawModels = Array.isArray(draft.models) ? draft.models : [];

  if (rawModels.length === 0) {
    notes.push('草案没有可导入的模型（可能仍在待澄清状态）');
    return { models, notes, skipped };
  }

  for (const raw of rawModels) {
    if (!isObject(raw)) continue;
    const name = String(raw.name ?? '');
    const action = String(raw.action ?? 'create');
    if (action !== 'create') {
      skipped.push({ model: name, reason: `暂不支持从草案导入 ${action}（存量变更请在设计器里手动改）` });
      continue;
    }

    const rawFields = Array.isArray(raw.fields) ? raw.fields.filter(isObject) : [];
    const editorFields: EditorField[] = rawFields.map((field) => toEditorField(field, options.database));

    // 关系字段只保留外键标量，两端由设计器的「＋关系」生成
    const relationFields = rawFields.filter((field) => isObject(field.relation)).map((field) => String(field.name));
    if (relationFields.length > 0) {
      notes.push(
        `${name}：关系字段 ${relationFields.join('、')} 先按普通字段导入，请在设计器里用「＋关系」补齐两端（Prisma 要求两端同时声明）`,
      );
    }

    // 按项目约定补齐框架字段：缺 id 或时间戳会让写回校验直接失败
    const present = new Set(editorFields.map((field) => field.name));
    const conventions = options.conventions;
    if (!present.has('id')) {
      editorFields.unshift({ name: 'id', ...FRAMEWORK_FIELDS.id });
      notes.push(`${name}：按项目约定补了 id`);
    }
    const appends: string[] = [];
    if (conventions.tenant_field && !present.has('tenantId')) appends.push('tenantId');
    if (conventions.audit_fields.includes('createdAt') && !present.has('createdAt')) appends.push('createdAt');
    if (conventions.audit_fields.includes('updatedAt') && !present.has('updatedAt')) appends.push('updatedAt');
    if (conventions.audit_fields.includes('createdBy') && !present.has('createdBy')) appends.push('createdBy');
    if (conventions.audit_fields.includes('updatedBy') && !present.has('updatedBy')) appends.push('updatedBy');
    if (conventions.soft_delete && !present.has('deletedAt')) appends.push('deletedAt');
    for (const fieldName of appends) {
      editorFields.push({ name: fieldName, ...FRAMEWORK_FIELDS[fieldName] });
    }
    if (appends.length > 0) notes.push(`${name}：按项目约定补了 ${appends.join('、')}`);

    // 索引与唯一约束：草案里单列 indexed 也要落成块级 @@index
    const blockAttrs: string[] = [];
    const seenIndex = new Set<string>();
    const uniqueFields = new Set(rawFields.filter((field) => field.unique === true).map((field) => String(field.name)));
    const pushIndex = (columns: string[], unique: boolean): void => {
      const valid = columns.filter((column) => editorFields.some((field) => field.name === column));
      if (valid.length === 0) return;
      // 单列索引与 @unique 重复时跳过（Prisma 会认为冗余）
      if (!unique && valid.length === 1 && uniqueFields.has(valid[0])) {
        notes.push(`${name}：跳过与 @unique 重复的索引 [${valid[0]}]`);
        return;
      }
      const key = `${unique ? 'u' : 'i'}:${valid.join('+')}`;
      if (seenIndex.has(key)) return;
      seenIndex.add(key);
      blockAttrs.push(`@@${unique ? 'unique' : 'index'}([${valid.join(', ')}])`);
    };
    for (const field of rawFields) {
      if (field.indexed === true && field.unique !== true) pushIndex([String(field.name)], false);
    }
    if (Array.isArray(raw.indexes)) {
      for (const index of raw.indexes) {
        if (!isObject(index) || !Array.isArray(index.fields)) continue;
        pushIndex(index.fields.map((column) => String(column)), index.unique === true);
      }
    }

    const modelLabel =
      typeof raw.display_name === 'string' && raw.display_name.trim() !== ''
        ? raw.display_name.trim()
        : suggestLabel(name);
    models.push({ name, ...(modelLabel === '' ? {} : { label: modelLabel }), fields: editorFields, blockAttrs });
  }

  if (draft.unsupported_features !== undefined) {
    const unsupported = Array.isArray(draft.unsupported_features) ? draft.unsupported_features : [];
    if (unsupported.length > 0) {
      const readable = unsupported.map((item) => (typeof item === 'string' ? item : JSON.stringify(item)));
      notes.push(`草案标注了当前生成器不支持的能力：${readable.join('；')}`);
    }
  }
  return { models, notes, skipped };
}
