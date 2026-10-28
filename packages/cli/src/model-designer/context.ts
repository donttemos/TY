/*
 * @file 建模上下文采集（PRD-017 FR-17-24）
 * @description 把「项目实际长什么样」压成一份 JSON 交给模型，而不是让它靠猜：
 *   - 数据库类型从 datasource 读；schema 片段截断到预算内；
 *   - 已有模型（含字段名）用于查重与关系引用；
 *   - 框架约定按实际字段出现率推断（id / tenantId / 审计四件套 / deletedAt），不写死；
 *   - 生成器与前端控件能力给常量（与 gen 的「单字段主键」限制、CrudTable/form 模板一致）。
 *   采不到就如实缺省，由模型在 assumptions 里声明，绝不假装读过文件。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/model-designer
 * @since v0.8.0
 */

import fs from 'node:fs';
import { resolveLayout } from '../gen/render.js';
import { listModels } from '../studio/schema-api.js';

/** schema 片段预算（字符）：约 5k token，够看清命名与关系写法 */
const SCHEMA_EXCERPT_LIMIT = 18_000;

/** 生成器当前支持的建模能力（与 gen/schema-parser 的单主键限制一致） */
export const GENERATOR_CAPABILITIES = {
  supports: ['single_primary_key', 'relation_many_to_one', 'relation_one_to_one', 'enum', 'index', 'unique', 'soft_delete'],
  unsupported: ['composite_primary_key', 'many_to_many', 'composite_unique', 'polymorphic_relation'],
} as const;

/**
 * 前端可用控件
 * @description 取生成模板（form.vue.tpl）与 CrudTable 的并集：
 *   保证模型建议的控件在生成的页面里「至少有一个组件能渲染」。
 */
export const UI_CONTROLS = ['input', 'textarea', 'number', 'switch', 'datetime', 'date', 'daterange', 'select', 'dict-select', 'upload'] as const;

/** 建模上下文（与 docs/51 的 context 字段一一对应） */
export interface DesignerContext {
  database: string;
  schema_file: string;
  schema_excerpt: string;
  existing_models: { name: string; fields: string[] }[];
  conventions: {
    primary_key?: string;
    tenant_field?: string;
    audit_fields: string[];
    soft_delete?: string;
    /** 说明这些约定是推断来的还是 schema 里实际存在 */
    note: string;
  };
  generator: { supports: readonly string[]; unsupported: readonly string[] };
  ui: { controls: readonly string[]; list_features: readonly string[] };
}

/** 采集选项 */
export interface BuildContextOptions {
  /** 项目根 */
  projectRoot: string;
  /** 后端应用目录名（--app） */
  app?: string;
  /** 显式 schema 路径 */
  schema?: string;
}

/** 在多少比例的模型里出现，才认为它是「框架约定字段」 */
const CONVENTION_RATIO = 0.5;

/**
 * 从 datasource 读数据库类型
 * @param schemaText schema 全文
 * @returns provider 名（小写）；读不到返回空串
 */
export function detectDatabase(schemaText: string): string {
  const matched = schemaText.match(/datasource\s+\w+\s*\{[\s\S]*?provider\s*=\s*"([a-zA-Z0-9]+)"/);
  return matched ? matched[1].toLowerCase() : '';
}

/**
 * 按出现率推断框架约定字段
 * @param models 已有模型
 * @returns conventions（缺什么就不写什么）
 */
export function detectConventions(models: { fields: string[] }[]): DesignerContext['conventions'] {
  const conventions: DesignerContext['conventions'] = { audit_fields: [], note: '' };
  if (models.length === 0) {
    conventions.note = '项目暂无模型，无法推断约定；按通用约定设计';
    return conventions;
  }

  const has = (field: string): boolean =>
    models.filter((model) => model.fields.includes(field)).length / models.length >= CONVENTION_RATIO;

  if (has('id')) conventions.primary_key = 'id String @id @default(uuid())';
  if (has('tenantId')) conventions.tenant_field = 'tenantId String';
  const audit = ['createdAt', 'updatedAt', 'createdBy', 'updatedBy'].filter((field) => has(field));
  if (audit.length > 0) conventions.audit_fields = audit;
  if (has('deletedAt')) conventions.soft_delete = 'deletedAt DateTime?';

  const parts: string[] = [];
  if (conventions.primary_key) parts.push('主键');
  if (conventions.tenant_field) parts.push('租户字段');
  if (conventions.audit_fields.length > 0) parts.push('审计字段');
  if (conventions.soft_delete) parts.push('软删除');
  conventions.note =
    parts.length > 0
      ? `按 ${models.length} 个已有模型的出现率（≥${Math.round(CONVENTION_RATIO * 100)}%）推断：${parts.join('、')}；未见字段不要擅自添加`
      : `已有 ${models.length} 个模型但未形成统一约定，按通用约定设计`;
  return conventions;
}

/**
 * 采集成模上下文
 * @param options 采集选项
 * @returns 上下文；schema 不存在时降级为「无上下文」并保留说明
 */
export function buildDesignerContext(options: BuildContextOptions): DesignerContext {
  const layout = resolveLayout({
    models: [],
    projectRoot: options.projectRoot,
    app: options.app,
    schema: options.schema,
    author: '',
    created: '',
    since: '',
  });

  const base: DesignerContext = {
    database: '',
    schema_file: options.schema ?? layout.schemaFile,
    schema_excerpt: '',
    existing_models: [],
    conventions: { audit_fields: [], note: '未读取到 schema，无法推断约定' },
    generator: GENERATOR_CAPABILITIES,
    ui: {
      controls: UI_CONTROLS,
      list_features: ['search', 'filter', 'sort', 'paginate', 'export'],
    },
  };

  if (!fs.existsSync(layout.schemaFile)) return base;

  const text = fs.readFileSync(layout.schemaFile, 'utf8');
  const models = listModels(text).map((model) => ({
    name: model.name,
    fields: model.fields.map((field) => field.name),
  }));

  const truncated = text.length > SCHEMA_EXCERPT_LIMIT;
  return {
    ...base,
    database: detectDatabase(text),
    schema_excerpt: truncated ? `${text.slice(0, SCHEMA_EXCERPT_LIMIT)}\n// …（已截断，共 ${text.length} 字符）` : text,
    existing_models: models,
    conventions: detectConventions(models),
  };
}

/**
 * 上下文的精简摘要（用于界面展示「读到了什么」，不含 schema 全文）
 * @param context 上下文
 */
export function summarizeContext(context: DesignerContext): {
  database: string;
  models: number;
  modelNames: string[];
  conventions: string;
  truncated: boolean;
} {
  return {
    database: context.database || '未知（按 postgresql 处理）',
    models: context.existing_models.length,
    modelNames: context.existing_models.map((model) => model.name),
    conventions: context.conventions.note,
    truncated: context.schema_excerpt.includes('已截断'),
  };
}
