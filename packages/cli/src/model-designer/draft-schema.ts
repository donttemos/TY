/*
 * @file 模型草案结构与语义校验（PRD-017 FR-17-24）
 * @description 提示词只能约束模型「愿意」输出什么，真正保证可用的是这里的确定性校验：
 *   ① 顶层与嵌套结构（缺字段、类型错、枚举越界）；② 语义（命名、类型、关系引用、
 *   默认值与可空、索引列、破坏性变更是否登记、增量的 revision 是否自洽）；
 *   ③ 安全策略（输出里不得出现供应商、地址、密钥）。
 *   校验只返回**路径化问题**，由编排层把前若干条回灌给模型重试一次——不回灌就等于让模型盲改。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/model-designer
 * @since v0.8.0
 */

/** 协议版本（与 docs/51 一致） */
export const DRAFT_PROTOCOL_VERSION = '1.0';

/** 生成器支持的标量类型（枚举类型由字段自带 enum_values 声明） */
export const SCALAR_TYPES = ['String', 'Int', 'BigInt', 'Decimal', 'Boolean', 'DateTime', 'Json'] as const;

/** 不允许作为模型名/字段名的保留字 */
const RESERVED_NAMES = new Set(['model', 'enum', 'datasource', 'generator', 'type', 'view']);

/** 输出中禁止出现的键（防提示注入：让模型别决定供应商与密钥） */
const FORBIDDEN_KEYS = ['base_url', 'baseUrl', 'api_key', 'apiKey', 'provider', 'api_provider'];

/** 校准的上限（与 docs/51 第 9 节一致） */
export const PARAM_LIMITS = {
  temperatureMax: 0.3,
  minOutputTokens: 1024,
  maxOutputTokens: 16000,
} as const;

/** 单条校验问题 */
export interface DraftIssue {
  /** JSON 路径，如 `models[0].fields[2].name` */
  path: string;
  /** 机器码：MISSING / TYPE / ENUM / PATTERN / UNKNOWN_REF / DUP_MODEL / ... */
  code: string;
  /** 面向人的说明（会回灌给模型，必须具体） */
  message: string;
}

/** 校验入参 */
export interface ValidateOptions {
  /** 项目已有模型名（用于查重与关系引用） */
  existingModels: string[];
  /** 请求带的 base_revision */
  baseRevision: number;
  /** 请求模式 */
  mode: 'create' | 'revise';
}

/** 是否为普通对象 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 是否为非空字符串 */
function isText(value: unknown): value is string {
  return typeof value === 'string' && value.trim() !== '';
}

/** 是否为整数 */
function isInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value);
}

/** 追加问题 */
function push(issues: DraftIssue[], path: string, code: string, message: string): void {
  issues.push({ path, code, message });
}

/**
 * 扫描禁止键（递归）
 * @param value 待扫描值
 * @param path 当前路径
 * @returns 命中路径列表
 */
export function collectPolicyViolations(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => collectPolicyViolations(item, `${path}[${index}]`));
  }
  if (!isObject(value)) return [];
  return Object.entries(value).flatMap(([key, child]) => {
    const here = `${path}.${key}`;
    return FORBIDDEN_KEYS.includes(key) ? [here] : collectPolicyViolations(child, here);
  });
}

/** 校验字段级 ui 对象 */
function validateUi(ui: unknown, path: string, issues: DraftIssue[]): void {
  if (!isObject(ui)) {
    push(issues, path, 'MISSING', '必须提供 ui 对象（visible_in_list / searchable / control / required）');
    return;
  }
  for (const key of ['visible_in_list', 'searchable', 'required']) {
    if (typeof ui[key] !== 'boolean') push(issues, `${path}.${key}`, 'TYPE', '必须是布尔值');
  }
  if (!isText(ui.control)) push(issues, `${path}.control`, 'MISSING', '必须给控件类型（如 input / select）');
  for (const forbidden of ['type', 'unique', 'nullable', 'default', 'indexed']) {
    if (forbidden in ui) push(issues, `${path}.${forbidden}`, 'UI_MIXED', '数据库属性不得写进 ui');
  }
}

/** 校验关系对象 */
function validateRelation(
  relation: unknown,
  path: string,
  fields: Map<string, Record<string, unknown>>,
  knownModels: Set<string>,
  issues: DraftIssue[],
): void {
  if (relation === null || relation === undefined) return;
  if (!isObject(relation)) {
    push(issues, path, 'TYPE', 'relation 必须是对象或 null');
    return;
  }
  if (relation.from !== undefined && !isText(relation.from)) {
    push(issues, `${path}.from`, 'TYPE', 'from 必须是本端字段名');
  }
  if (isText(relation.from) && !fields.has(relation.from)) {
    push(issues, `${path}.from`, 'UNKNOWN_REF', `本端字段 ${relation.from} 不存在`);
  }
  if (!isText(relation.target) || !knownModels.has(relation.target)) {
    push(issues, `${path}.target`, 'UNKNOWN_REF', `关系目标 ${String(relation.target)} 不在草案或已有模型中`);
  }
  if (!['many_to_one', 'one_to_one'].includes(String(relation.cardinality))) {
    push(issues, `${path}.cardinality`, 'ENUM', 'cardinality 只能是 many_to_one / one_to_one（多对多当前不支持）');
  }
  if (!isText(relation.field)) push(issues, `${path}.field`, 'MISSING', '必须给目标端反向字段名');
  if (relation.on_delete !== undefined && !['Restrict', 'Cascade', 'SetNull'].includes(String(relation.on_delete))) {
    push(issues, `${path}.on_delete`, 'ENUM', 'on_delete 只能是 Restrict / Cascade / SetNull');
  }
}

/** 校验单个字段 */
function validateField(
  field: unknown,
  path: string,
  knownModels: Set<string>,
  fields: Map<string, Record<string, unknown>>,
  modelAction: string,
  migrationRisks: unknown,
  issues: DraftIssue[],
): void {
  if (!isObject(field)) {
    push(issues, path, 'TYPE', '字段必须是对象');
    return;
  }
  const name = field.name;
  if (!isText(name) || !/^[a-z][A-Za-z0-9]{0,63}$/.test(name)) {
    push(issues, `${path}.name`, 'PATTERN', '字段名必须是 lowerCamelCase（字母开头，字母数字，≤64）');
  } else if (RESERVED_NAMES.has(name)) {
    push(issues, `${path}.name`, 'PATTERN', `字段名 ${name} 是保留字`);
  }
  if (!isText(field.display_name)) push(issues, `${path}.display_name`, 'MISSING', '必须给中文显示名');

  const type = field.type;
  const customType = !SCALAR_TYPES.includes(type as (typeof SCALAR_TYPES)[number]);
  if (!isText(type)) {
    push(issues, `${path}.type`, 'MISSING', '必须给字段类型');
  } else if (customType) {
    const values = field.enum_values;
    if (!Array.isArray(values) || values.length === 0) {
      push(issues, `${path}.type`, 'ENUM', `类型 ${type} 不在标量类型内，必须用 enum_values 声明枚举取值`);
    } else if (new Set(values).size !== values.length) {
      push(issues, `${path}.enum_values`, 'DUP', '枚举取值不得重复');
    }
  }

  if (typeof field.nullable !== 'boolean') push(issues, `${path}.nullable`, 'TYPE', 'nullable 必须是布尔值');
  if (!('default' in field)) push(issues, `${path}.default`, 'MISSING', '必须显式给 default（无默认值写 null）');
  for (const key of ['unique', 'indexed', 'destructive']) {
    if (typeof field[key] !== 'boolean') push(issues, `${path}.${key}`, 'TYPE', `${key} 必须是布尔值`);
  }

  if (type === 'Decimal') {
    if (!isInt(field.precision) || !isInt(field.scale)) {
      push(issues, `${path}.precision`, 'MISSING', 'Decimal 必须给 precision 与 scale（金额建议 18/2）');
    }
  }

  if (!['explicit', 'convention', 'inferred'].includes(String(field.source))) {
    push(issues, `${path}.source`, 'ENUM', 'source 只能是 explicit / convention / inferred');
  }
  if (field.source === 'inferred' && !isText(field.reason)) {
    push(issues, `${path}.reason`, 'MISSING', 'source=inferred 时必须给 reason');
  }

  validateUi(field.ui, `${path}.ui`, issues);
  validateRelation(field.relation, `${path}.relation`, fields, knownModels, issues);

  // 更新已有字段：收窄可空属于破坏性变更，必须登记迁移风险
  if (modelAction === 'update' && field.nullable === false && field.default === null && field.destructive !== true) {
    push(issues, `${path}.destructive`, 'DESTRUCTIVE_UNMARKED', '把已有字段改为非空且无默认值属于破坏性变更，必须 destructive=true');
  }
  if (field.destructive === true && !Array.isArray(migrationRisks)) {
    push(issues, `${path}.destructive`, 'MISSING', '存在破坏性变更时必须提供 migration_risks');
  }
}

/** 校验模型 */
function validateModel(
  model: unknown,
  path: string,
  knownModels: Set<string>,
  existing: Set<string>,
  migrationRisks: unknown,
  issues: DraftIssue[],
): void {
  if (!isObject(model)) {
    push(issues, path, 'TYPE', '模型必须是对象');
    return;
  }
  const name = model.name;
  if (!isText(name) || !/^[A-Z][A-Za-z0-9]{1,63}$/.test(name)) {
    push(issues, `${path}.name`, 'PATTERN', '模型名必须是 PascalCase');
  }
  if (!['create', 'update', 'delete'].includes(String(model.action))) {
    push(issues, `${path}.action`, 'ENUM', 'action 只能是 create / update / delete');
  }
  if (model.action === 'create' && isText(name) && existing.has(name)) {
    push(issues, `${path}.name`, 'DUP_MODEL', `模型 ${name} 已存在，应使用 update 或复用`);
  }
  if (model.action === 'delete' && model.destructive !== true) {
    push(issues, `${path}.destructive`, 'DESTRUCTIVE_UNMARKED', 'delete 必须 destructive=true 并登记迁移风险');
  }

  const fields = model.fields;
  if (!Array.isArray(fields) || fields.length === 0) {
    push(issues, `${path}.fields`, 'MISSING', '模型至少要有 1 个字段');
    return;
  }
  const fieldMap = new Map<string, Record<string, unknown>>();
  fields.forEach((field, index) => {
    if (isObject(field) && isText(field.name)) {
      if (fieldMap.has(field.name)) {
        push(issues, `${path}.fields[${index}].name`, 'DUP', `字段 ${field.name} 重复`);
      }
      fieldMap.set(field.name, field);
    }
  });
  fields.forEach((field, index) => {
    validateField(field, `${path}.fields[${index}]`, knownModels, fieldMap, String(model.action), migrationRisks, issues);
  });

  const indexes = model.indexes;
  if (!Array.isArray(indexes)) {
    push(issues, `${path}.indexes`, 'MISSING', 'indexes 必须是数组（无索引写空数组）');
  } else {
    indexes.forEach((index, index2) => {
      const at = `${path}.indexes[${index2}]`;
      if (!isObject(index)) {
        push(issues, at, 'TYPE', '索引必须是对象');
        return;
      }
      if (!Array.isArray(index.fields) || index.fields.length === 0) {
        push(issues, `${at}.fields`, 'MISSING', '索引必须至少 1 列');
      } else {
        for (const column of index.fields) {
          if (!isText(column) || !fieldMap.has(column)) {
            push(issues, `${at}.fields`, 'UNKNOWN_REF', `索引列 ${String(column)} 不在本模型字段中`);
          }
        }
      }
      if (typeof index.unique !== 'boolean') push(issues, `${at}.unique`, 'TYPE', 'unique 必须是布尔值');
      if (!isText(index.reason)) push(issues, `${at}.reason`, 'MISSING', '索引必须给 reason');
    });
  }

  const relations = model.relations;
  if (!Array.isArray(relations)) {
    push(issues, `${path}.relations`, 'MISSING', 'relations 必须是数组（无关系写空数组）');
  } else {
    relations.forEach((relation, index) => {
      validateRelation(relation, `${path}.relations[${index}]`, fieldMap, knownModels, issues);
    });
  }
}

/** 校验增量操作（revise 模式） */
function validateOperations(operations: unknown, issues: DraftIssue[]): void {
  if (!Array.isArray(operations)) {
    push(issues, '$.operations', 'MISSING', 'revise 模式必须给 operations 数组');
    return;
  }
  const allowed: Record<string, string[]> = {
    add_model: ['model'],
    update_model_meta: ['name', 'changes'],
    remove_model: ['name', 'reason'],
    add_field: ['model', 'field'],
    update_field: ['model', 'field', 'changes'],
    remove_field: ['model', 'field', 'reason'],
    add_index: ['model', 'index'],
    remove_index: ['model', 'fields'],
    set_enum: ['model', 'field', 'values'],
  };
  operations.forEach((operation, index) => {
    const at = `$.operations[${index}]`;
    if (!isObject(operation)) {
      push(issues, at, 'TYPE', '操作必须是对象');
      return;
    }
    const op = String(operation.op);
    if (!(op in allowed)) {
      push(issues, `${at}.op`, 'ENUM', `不支持的操作 ${op}`);
      return;
    }
    for (const key of allowed[op]) {
      if (!(key in operation)) push(issues, `${at}.${key}`, 'MISSING', `操作 ${op} 缺少 ${key}`);
    }
    if (!isText(operation.reason)) push(issues, `${at}.reason`, 'MISSING', '每个操作都要给 reason');
  });
}

/** 校验参数建议与业务生成参数 */
function validateParams(params: unknown, profile: unknown, issues: DraftIssue[]): void {
  if (params === undefined || params === null) {
    // 缺失时由 normalizeDraft 填默认值（0.2 / 4000），不阻断
  } else if (!isObject(params)) {
    push(issues, '$.recommended_call_params', 'TYPE', 'recommended_call_params 必须是对象');
  } else {
    if (typeof params.temperature !== 'number' || params.temperature < 0 || params.temperature > 2) {
      push(issues, '$.recommended_call_params.temperature', 'RANGE', 'temperature 需在 0~2');
    }
    if (!isInt(params.max_output_tokens)) {
      push(issues, '$.recommended_call_params.max_output_tokens', 'TYPE', 'max_output_tokens 必须是整数');
    }
    if (params.reason !== undefined && !isText(params.reason)) {
      push(issues, '$.recommended_call_params.reason', 'TYPE', 'reason 必须是非空字符串');
    }
  }

  if (profile === undefined || profile === null) return;
  if (!isObject(profile)) {
    push(issues, '$.generation_profile', 'TYPE', 'generation_profile 必须是对象');
    return;
  }
  if (profile.list_page_size !== undefined && (!isInt(profile.list_page_size) || profile.list_page_size < 1 || profile.list_page_size > 200)) {
    push(issues, '$.generation_profile.list_page_size', 'RANGE', 'list_page_size 需为 1~200 的整数');
  }
  if (profile.default_sort !== undefined && !isText(profile.default_sort)) {
    push(issues, '$.generation_profile.default_sort', 'TYPE', 'default_sort 必须是非空字符串');
  }
  if (profile.permissions !== undefined && !Array.isArray(profile.permissions)) {
    push(issues, '$.generation_profile.permissions', 'TYPE', 'permissions 必须是数组');
  } else if (Array.isArray(profile.permissions)) {
    profile.permissions.forEach((code, index) => {
      if (typeof code !== 'string' || !/^[a-z0-9-]+:(create|read|update|delete)$/.test(code)) {
        push(issues, `$.generation_profile.permissions[${index}]`, 'PATTERN', '权限码形如 product:read');
      }
    });
  }
  if (profile.seed_count !== undefined && (!isInt(profile.seed_count) || profile.seed_count < 0 || profile.seed_count > 50)) {
    push(issues, '$.generation_profile.seed_count', 'RANGE', 'seed_count 需为 0~50 的整数');
  }
}

/**
 * 校验整份草案
 * @param value 模型输出（已 JSON.parse）
 * @param options 校验上下文
 * @returns 问题列表（空数组 = 通过）
 */
export function validateModelDraft(value: unknown, options: ValidateOptions): DraftIssue[] {
  const issues: DraftIssue[] = [];

  const policy = collectPolicyViolations(value);
  for (const path of policy) {
    push(issues, path, 'POLICY', '不得输出供应商、接口地址或密钥相关字段');
  }
  if (!isObject(value)) {
    push(issues, '$', 'TYPE', '顶层必须是 JSON 对象');
    return issues;
  }

  if (value.protocol_version !== DRAFT_PROTOCOL_VERSION) {
    push(issues, '$.protocol_version', 'PROTOCOL', `protocol_version 必须是 ${DRAFT_PROTOCOL_VERSION}`);
  }
  const status = String(value.status);
  if (!['draft', 'needs_clarification', 'rejected'].includes(status)) {
    push(issues, '$.status', 'ENUM', 'status 只能是 draft / needs_clarification / rejected');
  }
  if (status === 'rejected') {
    if (!isText(value.error_code)) push(issues, '$.error_code', 'MISSING', 'rejected 必须给 error_code');
    if (!isText(value.message)) push(issues, '$.message', 'MISSING', 'rejected 必须给 message');
  }
  if (!isText(value.requirement_summary)) push(issues, '$.requirement_summary', 'MISSING', '必须给需求摘要');

  if (!isInt(value.revision)) push(issues, '$.revision', 'TYPE', 'revision 必须是整数');
  if (!isInt(value.base_revision)) push(issues, '$.base_revision', 'TYPE', 'base_revision 必须是整数');
  if (isInt(value.revision) && isInt(value.base_revision) && value.revision !== value.base_revision + 1) {
    push(issues, '$.revision', 'REVISION', 'revision 必须等于 base_revision + 1');
  }
  if (isInt(value.base_revision) && value.base_revision !== options.baseRevision) {
    push(issues, '$.base_revision', 'REVISION_CONFLICT', `base_revision 应为 ${options.baseRevision}`);
  }

  for (const key of ['assumptions', 'questions', 'warnings', 'unsupported_features', 'migration_risks']) {
    // 缺失由 normalizeDraft 补空数组（不让「少写一个空数组」毁掉整份草案）；写了但类型错才报
    if (key in value && !Array.isArray(value[key])) push(issues, `$.${key}`, 'TYPE', `${key} 必须是数组`);
  }
  if (status === 'needs_clarification' && Array.isArray(value.questions) && value.questions.length === 0) {
    push(issues, '$.questions', 'MISSING', 'needs_clarification 至少给 1 个问题');
  }

  const models = value.models;
  const existing = new Set(options.existingModels);
  if (options.mode === 'create') {
    if (!Array.isArray(models) || models.length === 0) {
      if (status !== 'needs_clarification') {
        push(issues, '$.models', 'MISSING', 'create 模式必须给非空 models（或改为 needs_clarification）');
      }
    } else {
      const known = new Set<string>(existing);
      for (const model of models) {
        if (isObject(model) && isText(model.name)) known.add(model.name);
      }
      const seen = new Set<string>();
      models.forEach((model, index) => {
        if (isObject(model) && isText(model.name)) {
          if (seen.has(model.name)) push(issues, `$.models[${index}].name`, 'DUP_MODEL', `模型 ${model.name} 重复`);
          seen.add(model.name);
        }
        validateModel(model, `$.models[${index}]`, known, existing, value.migration_risks, issues);
      });
    }
  } else {
    validateOperations(value.operations, issues);
    const known = new Set<string>(existing);
    if (Array.isArray(value.models)) {
      for (const model of value.models) if (isObject(model) && isText(model.name)) known.add(model.name);
    }
    // revise 模式只允许改已有模型：操作里的 model 必须已存在（add_model 除外）
    if (Array.isArray(value.operations)) {
      value.operations.forEach((operation, index) => {
        if (!isObject(operation) || operation.op === 'add_model') return;
        const target = operation.model ?? operation.name;
        if (isText(target) && !known.has(target)) {
          push(issues, `$.operations[${index}]`, 'UNKNOWN_REF', `模型 ${target} 不存在（新增模型请用 add_model）`);
        }
      });
    }
  }

  validateParams(value.recommended_call_params, value.generation_profile, issues);
  return issues;
}

/**
 * 校准参数建议（越界由编排层截断，而不是整份拒绝）
 * @param draft 已通过校验的草案
 * @returns 校准后的草案与提示
 */
export function normalizeDraft<T extends Record<string, unknown>>(
  draft: T,
  options: { existingModels?: string[] } = {},
): { draft: T; warnings: string[] } {
  const warnings: string[] = [];
  const next = { ...draft } as Record<string, unknown>;

  // 顶层数组：缺失补空，避免「少写一个空数组」导致整份草案不可用
  for (const key of ['assumptions', 'questions', 'warnings', 'unsupported_features', 'migration_risks']) {
    if (!Array.isArray(next[key])) next[key] = [];
  }

  // 业务生成参数：缺失项按默认补齐（页面可改，不阻断）
  const models = Array.isArray(draft.models) ? (draft.models as Record<string, unknown>[]) : [];
  const profile = isObject(draft.generation_profile) ? { ...draft.generation_profile } : {};
  if (!isInt(profile.list_page_size)) {
    profile.list_page_size = 20;
    warnings.push('generation_profile.list_page_size 未给出，按 20 补齐');
  }
  if (!isText(profile.default_sort)) {
    profile.default_sort = 'createdAt desc';
    warnings.push('generation_profile.default_sort 未给出，按 createdAt desc 补齐');
  }
  if (!Array.isArray(profile.permissions) || profile.permissions.length === 0) {
    profile.permissions = models.flatMap((model) => {
      const kebab = typeof model.kebab === 'string' ? model.kebab : typeof model.name === 'string' ? model.name.toLowerCase() : '';
      return kebab === '' ? [] : ['create', 'read', 'update', 'delete'].map((action) => `${kebab}:${action}`);
    });
    warnings.push('generation_profile.permissions 未给出，按模型 kebab 名推导');
  }
  if (!isInt(profile.seed_count)) {
    profile.seed_count = 0;
    warnings.push('generation_profile.seed_count 未给出，按 0 补齐');
  }
  next.generation_profile = profile;

  // 模型/字段级「软瑕疵」：能修就修并记 warning，别让一个布尔值毁掉整份草案
  const warn = (message: string): void => {
    if (warnings.length < 20) warnings.push(message);
  };
  if (Array.isArray(next.models)) {
    next.models = (next.models as unknown[]).map((model) => {
      if (!isObject(model)) return model;
      const fields = Array.isArray(model.fields) ? (model.fields as unknown[]) : [];
      const fieldNames = new Set(
        fields.filter(isObject).map((field) => String((field as Record<string, unknown>).name ?? '')).filter(Boolean),
      );

      const repairedFields = fields.map((field) => {
        if (!isObject(field)) return field;
        const nullable = field.nullable === false;
        const ui = isObject(field.ui) ? { ...field.ui } : {};
        if (typeof ui.visible_in_list !== 'boolean') {
          ui.visible_in_list = true;
          warn(`字段 ${String(field.name)}.ui.visible_in_list 非布尔，按默认 true 补齐`);
        }
        if (typeof ui.searchable !== 'boolean') {
          ui.searchable = false;
          warn(`字段 ${String(field.name)}.ui.searchable 非布尔，按默认 false 补齐`);
        }
        if (typeof ui.required !== 'boolean') {
          ui.required = !nullable;
          warn(`字段 ${String(field.name)}.ui.required 非布尔，按是否非空补齐`);
        }
        if (!isText(ui.control)) {
          ui.control = 'input';
          warn(`字段 ${String(field.name)}.ui.control 缺失，按 input 补齐`);
        }
        return { ...field, ui };
      });

      const rawIndexes = Array.isArray(model.indexes) ? (model.indexes as unknown[]) : [];
      const repairedIndexes = rawIndexes.flatMap((index) => {
        if (!isObject(index)) {
          warn('丢弃一个非对象索引');
          return [];
        }
        const columns = Array.isArray(index.fields)
          ? index.fields.filter((column): column is string => typeof column === 'string' && fieldNames.has(column))
          : [];
        if (columns.length === 0) {
          // 常见：给框架自动维护字段（createdAt 等）建索引，但 fields 里没列——直接丢弃并说明
          warn(`丢弃索引 ${JSON.stringify(index.fields)}：列不在本模型字段中`);
          return [];
        }
        const unique = typeof index.unique === 'boolean' ? index.unique : false;
        if (typeof index.unique !== 'boolean') warn(`索引 ${columns.join('+')} 的 unique 非布尔，按 false 处理`);
        return [{ ...index, fields: columns, unique, reason: isText(index.reason) ? index.reason : '模型未给出原因' }];
      });

      // 关系是最容易被模型写残的地方（缺 target / 基数不支持 / 缺反向字段）。
      // 无效关系直接丢弃，字段按普通外键保留，后续可用设计器的「＋关系」补两端。
      const knownTargets = new Set<string>([
        ...(options.existingModels ?? []),
        ...(Array.isArray(next.models)
          ? (next.models as unknown[])
              .filter(isObject)
              .map((item) => String((item as Record<string, unknown>).name ?? ''))
              .filter(Boolean)
          : []),
      ]);
      const relationValid = (relation: unknown): boolean =>
        isObject(relation) &&
        isText(relation.target) &&
        knownTargets.has(relation.target) &&
        ['many_to_one', 'one_to_one'].includes(String(relation.cardinality)) &&
        isText(relation.field);

      const fieldsWithRelation = repairedFields.map((field) => {
        if (!isObject(field) || field.relation === null || field.relation === undefined) return field;
        if (relationValid(field.relation)) return field;
        warn(`字段 ${String(field.name)} 的关系定义不完整，已移除关系（字段保留为普通外键）`);
        return { ...field, relation: null };
      });

      const rawRelations = Array.isArray(model.relations) ? (model.relations as unknown[]) : [];
      const validRelations = rawRelations.filter((relation) => {
        if (relationValid(relation)) return true;
        warn(`丢弃一个无效关系（缺 target / 基数不支持 / 缺反向字段）`);
        return false;
      });

      return { ...model, fields: fieldsWithRelation, indexes: repairedIndexes, relations: validRelations };
    });
  }

  // 调用参数建议：缺失补默认
  const params = isObject(draft.recommended_call_params) ? { ...draft.recommended_call_params } : {};
  if (typeof params.temperature !== 'number') {
    params.temperature = 0.2;
    warnings.push('recommended_call_params.temperature 未给出，按 0.2 补齐');
  }
  if (!isInt(params.max_output_tokens)) {
    params.max_output_tokens = 4000;
    warnings.push('recommended_call_params.max_output_tokens 未给出，按 4000 补齐');
  }
  if (!isText(params.reason)) params.reason = '默认值（模型未给出）';
  if (typeof params.temperature === 'number' && params.temperature > PARAM_LIMITS.temperatureMax) {
    warnings.push(`temperature 建议值 ${params.temperature} 超过上限，已截断为 ${PARAM_LIMITS.temperatureMax}`);
    params.temperature = PARAM_LIMITS.temperatureMax;
  }
  if (isInt(params.max_output_tokens)) {
    if (params.max_output_tokens < PARAM_LIMITS.minOutputTokens) {
      warnings.push(`max_output_tokens ${params.max_output_tokens} 低于下限，已提升为 ${PARAM_LIMITS.minOutputTokens}`);
      params.max_output_tokens = PARAM_LIMITS.minOutputTokens;
    } else if (params.max_output_tokens > PARAM_LIMITS.maxOutputTokens) {
      warnings.push(`max_output_tokens ${params.max_output_tokens} 超过上限，已截断为 ${PARAM_LIMITS.maxOutputTokens}`);
      params.max_output_tokens = PARAM_LIMITS.maxOutputTokens;
    }
  }
  next.recommended_call_params = params;
  return { draft: next as T, warnings };
}
