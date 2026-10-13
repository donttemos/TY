/*
 * @file 类型映射表与字段元信息推导
 * @description PRD-006 FR-05：数据库类型 → TS 类型 → 前端控件 → 校验规则的唯一映射来源
 *   （以数据字典 1.3 为基准）。约定：bigint（含 id / *_id）与 decimal 一律映射为 string，
 *   禁 number 防精度丢失；未命中类型直接报错，不猜测。项目级覆盖经 codegen.config.json 的
 *   typeOverrides 合并（按 prisma 类型名覆盖整行）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli/gen
 */

import type { ParsedEnum, ParsedField, ParsedModel } from './schema-parser.js';

/** 前端表单控件类型（与 admin-web CrudTable 的 FormField.type 对齐） */
export type ControlType = 'input' | 'textarea' | 'number' | 'password' | 'select' | 'radio' | 'switch' | 'date' | 'datetime' | 'dict-select';

/** 单条类型映射规则 */
export interface TypeMapping {
  /** Prisma 标量类型名 */
  prismaType: string;
  /** 生成的 TS 类型 */
  tsType: string;
  /** 表单控件 */
  control: ControlType;
  /** 是否可作列表列 */
  listable: boolean;
  /** 是否可作查询条件 */
  searchable: boolean;
  /** 长度上限（@db.VarChar(n) 时可覆盖） */
  maxLength?: number;
}

/**
 * 内置类型映射表（PRD-006 §6）
 * 覆盖不到的类型由 resolveFieldMeta 报错，绝不猜测
 */
export const TYPE_MAP: Record<string, TypeMapping> = {
  String: { prismaType: 'String', tsType: 'string', control: 'input', listable: true, searchable: true },
  // text 由 @db.Text 识别后改用 textarea（见 resolveFieldMeta）
  Int: { prismaType: 'Int', tsType: 'number', control: 'number', listable: true, searchable: true },
  BigInt: { prismaType: 'BigInt', tsType: 'string', control: 'input', listable: true, searchable: false },
  Float: { prismaType: 'Float', tsType: 'number', control: 'number', listable: true, searchable: false },
  Decimal: { prismaType: 'Decimal', tsType: 'string', control: 'input', listable: true, searchable: false },
  Boolean: { prismaType: 'Boolean', tsType: 'boolean', control: 'switch', listable: true, searchable: true },
  DateTime: { prismaType: 'DateTime', tsType: 'string', control: 'datetime', listable: true, searchable: true },
  Json: { prismaType: 'Json', tsType: 'Record<string, unknown>', control: 'textarea', listable: false, searchable: false },
};

/** 项目级类型覆盖配置（codegen.config.json → typeOverrides） */
export type TypeOverrides = Partial<Record<string, Partial<TypeMapping>>>;

/** 审计与主键通用字段（@fw/db BaseEntity 约定，自动管理，不进 DTO） */
export const BASE_FIELDS = new Set(['id', 'deletedAt', 'createdAt', 'updatedAt', 'createdBy', 'updatedBy']);

/** 推导后的字段元信息（模板与渲染的唯一数据源） */
export interface FieldMeta {
  /** 字段名（camelCase） */
  name: string;
  /** 中文标签（文档注释优先，回落字段名） */
  label: string;
  /** Prisma 类型名 */
  prismaType: string;
  /** TS 类型 */
  tsType: string;
  /** 表单控件 */
  control: ControlType;
  /** 是否必填（非可选且无默认值） */
  required: boolean;
  /** 是否可选（schema 中的 ?，DTO / 实体用） */
  optional: boolean;
  /** 主键 */
  isId: boolean;
  /** BaseEntity 通用字段（不进 create/update 输入） */
  isBase: boolean;
  /** 外键（*Id 且带 @relation） */
  isForeignKey: boolean;
  /** 外键关联的目标模型名 */
  fkTarget?: string;
  /** 枚举字段 */
  isEnum: boolean;
  /** 枚举可选值 */
  enumValues?: string[];
  /** 字典编码（枚举字段用，snake_case 枚举名） */
  dictCode?: string;
  /** 长度上限 */
  maxLength?: number;
  /** 唯一约束 */
  unique: boolean;
  /** 有索引 */
  indexed: boolean;
  /** 默认值原文 */
  defaultValue?: string;
  /** 注释 */
  comment?: string;
  /** 列表展示 */
  listable: boolean;
  /** 查询条件 */
  searchable: boolean;
  /** 表单录入 */
  inForm: boolean;
}

/** 解析上下文 */
export interface ResolveContext {
  /** schema 中的全部枚举 */
  enums: ParsedEnum[];
  /** 项目级类型覆盖 */
  overrides?: TypeOverrides;
}

/**
 * 合并内置映射与项目级覆盖
 * @param overrides 项目覆盖（按 prisma 类型名）
 * @returns 合并后的映射表（不改动内置表）
 */
export function mergeTypeMap(overrides?: TypeOverrides): Record<string, TypeMapping> {
  const merged: Record<string, TypeMapping> = { ...TYPE_MAP };
  for (const [key, patch] of Object.entries(overrides ?? {})) {
    const base = merged[key];
    if (!base) {
      throw new Error(`codegen.config.json typeOverrides 覆盖了未注册的类型：${key}（可选：${Object.keys(TYPE_MAP).join(' / ')}）`);
    }
    merged[key] = { ...base, ...patch };
  }
  return merged;
}

/**
 * 推导单个字段的元信息
 * @param model 所属模型
 * @param field schema 字段
 * @param context 枚举与覆盖配置
 */
export function resolveFieldMeta(model: ParsedModel, field: ParsedField, context: ResolveContext): FieldMeta {
  const typeMap = mergeTypeMap(context.overrides);
  const enumDef = context.enums.find((e) => e.name === field.type);
  const isEnum = enumDef !== undefined;
  const mapping = isEnum ? undefined : typeMap[field.type];
  if (!isEnum && !mapping) {
    throw new Error(
      `模型 ${model.name} 字段 ${field.name} 的类型 ${field.type} 未命中映射表` +
        `（已注册：${[...Object.keys(typeMap), ...context.enums.map((e) => `enum ${e.name}`)].join(' / ')}）；` +
        '请在 codegen.config.json 的 typeOverrides 中补充，禁止猜测',
    );
  }

  const isBase = BASE_FIELDS.has(field.name);
  const isId = field.attributes.isId;
  const isForeignKey = field.name.endsWith('Id') && (field.attributes.relationFields !== undefined || field.name !== 'id');
  const unique = field.attributes.unique || model.uniqueFields.has(field.name);
  const indexed = model.indexedFields.has(field.name);
  const comment = field.comment;
  const label = comment ?? field.name;

  // 上面已保证：非枚举字段一定命中映射表（否则已抛错），此处按分支取类型
  let tsType: string;
  if (isEnum && enumDef) {
    tsType = enumDef.values.map((v) => `'${v.name}'`).join(' | ');
  } else if (mapping) {
    tsType = mapping.tsType;
  } else {
    throw new Error(`模型 ${model.name} 字段 ${field.name} 的类型推导失败（内部错误）`);
  }

  // text 识别：@db.Text 时字符串改用文本域
  let control: ControlType = mapping?.control ?? 'dict-select';
  if (field.type === 'String' && field.attributes.dbType?.startsWith('Text')) control = 'textarea';
  // 外键一律关联选择（PRD-006 §6：外键 xxx_id → 关联选择，可配数据源）
  if (isForeignKey && !isBase) control = 'select';

  const meta: FieldMeta = {
    name: field.name,
    label,
    prismaType: field.type,
    tsType,
    control,
    required: !field.optional && field.attributes.defaultValue === undefined,
    optional: field.optional,
    isId,
    isBase,
    isForeignKey: isForeignKey && !isBase,
    isEnum,
    unique,
    indexed,
    defaultValue: field.attributes.defaultValue,
    comment,
    listable: mapping?.listable ?? true,
    searchable: (mapping?.searchable ?? false) && !isBase,
    inForm: !isBase && !isId,
  };

  if (isEnum && enumDef) {
    meta.enumValues = enumDef.values.map((v) => v.name);
    meta.dictCode = snakeCase(enumDef.name);
  }
  if (isForeignKey) {
    // 外键目标模型：@relation 未显式给出时按命名约定推导（authorId → Author）
    meta.fkTarget = field.attributes.relationFields ? undefined : pascalCase(field.name.replace(/Id$/, ''));
  }
  const lengthMatched = field.attributes.dbType?.match(/VarChar\((\d+)\)/);
  if (lengthMatched) meta.maxLength = Number(lengthMatched[1]);

  return meta;
}

/**
 * 推导整个模型的字段元信息
 * @param model 目标模型
 * @param context 枚举与覆盖配置
 */
export function resolveModelFields(model: ParsedModel, context: ResolveContext): FieldMeta[] {
  return model.fields.map((field) => resolveFieldMeta(model, field, context));
}

/** PascalCase（order_item → OrderItem） */
export function pascalCase(input: string): string {
  return input
    .replace(/[_\-\s]+(.)/g, (_, char: string) => char.toUpperCase())
    .replace(/^(.)/, (_, char: string) => char.toUpperCase());
}

/** camelCase（OrderItem → orderItem） */
export function camelCase(input: string): string {
  const pascal = pascalCase(input);
  return pascal.charAt(0).toLowerCase() + pascal.slice(1);
}

/** kebab-case（OrderItem → order-item） */
export function kebabCase(input: string): string {
  return pascalCase(input)
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .toLowerCase();
}

/** snake_case（OrderItem → order_item） */
export function snakeCase(input: string): string {
  return kebabCase(input).replace(/-/g, '_');
}

/**
 * 英文复数（路由与集合路径用）
 * 覆盖常见规则：y→ies / s|x|z|ch|sh→es / 其余 +s；man→men 等不规则不猜测，回落 +s
 */
export function pluralize(input: string): string {
  if (/[^aeiou]y$/i.test(input)) return `${input.slice(0, -1)}ies`;
  if (/(s|x|z|ch|sh)$/i.test(input)) return `${input}es`;
  return `${input}s`;
}
