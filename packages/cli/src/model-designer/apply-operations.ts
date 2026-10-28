/*
 * @file 增量操作应用与差异计算（PRD-017 FR-17-24）
 * @description `revise` 模式只返回 operations，不重发整份模型；这里把操作落到草案上，并给出字段级 diff。
 *   原则：**只改操作点名的东西**，其余字段原样保留——这正是「不覆盖用户已有修改」的实现方式。
 *   破坏性操作（删模型/删字段/去唯一/收窄可空/改类型）会被标记，交给界面二次确认。
 * @author donttemo
 * @created 2026-10-27
 * @module cli/model-designer
 * @since v0.8.0
 */

/** 单条变更（用于界面 diff） */
export interface DraftChange {
  op: string;
  /** 人类可读位置，如 `Tag.name` */
  path: string;
  before: unknown;
  after: unknown;
  destructive: boolean;
}

/** 应用结果 */
export interface ApplyResult {
  draft: Record<string, unknown>;
  changes: DraftChange[];
  /** 被跳过的操作（参数不合法或目标不存在） */
  skipped: { op: string; reason: string }[];
  /** 是否存在破坏性变更 */
  destructive: boolean;
}

/** 是否普通对象 */
function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 深拷贝（草案是纯 JSON） */
function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** 允许通过 update_field 修改的键 */
const FIELD_PATCH_KEYS = [
  'display_name',
  'type',
  'nullable',
  'default',
  'unique',
  'indexed',
  'precision',
  'scale',
  'enum_values',
  'relation',
  'source',
  'reason',
  'ui',
] as const;

/** 字段变化是否破坏性（改类型、收窄可空、去唯一） */
function isDestructivePatch(before: Record<string, unknown>, patch: Record<string, unknown>): boolean {
  if ('type' in patch && patch.type !== before.type) return true;
  if ('nullable' in patch && before.nullable === true && patch.nullable === false) return true;
  if ('unique' in patch && before.unique === true && patch.unique === false) return true;
  return false;
}

/**
 * 应用增量操作
 * @param draft 当前草案
 * @param operations 模型返回的操作列表
 * @returns 新草案 + 变更 + 跳过项
 */
export function applyOperations(draft: Record<string, unknown>, operations: unknown[]): ApplyResult {
  const next = clone(draft);
  const changes: DraftChange[] = [];
  const skipped: { op: string; reason: string }[] = [];
  if (!Array.isArray(next.models)) next.models = [];
  const models = next.models as Record<string, unknown>[];

  const findModel = (name: unknown): Record<string, unknown> | undefined =>
    models.find((model) => isObject(model) && model.name === name);

  for (const raw of operations) {
    if (!isObject(raw)) {
      skipped.push({ op: 'unknown', reason: '操作不是对象' });
      continue;
    }
    const op = String(raw.op ?? '');
    const modelName = String(raw.model ?? raw.name ?? '');

    switch (op) {
      case 'add_model': {
        const model = raw.model;
        if (!isObject(model) || typeof model.name !== 'string') {
          skipped.push({ op, reason: 'add_model 缺少完整 model 对象' });
          break;
        }
        if (findModel(model.name)) {
          skipped.push({ op, reason: `模型 ${model.name} 已存在` });
          break;
        }
        const created = clone(model);
        if (!Array.isArray(created.fields)) created.fields = [];
        if (!Array.isArray(created.indexes)) created.indexes = [];
        if (!Array.isArray(created.relations)) created.relations = [];
        created.action = 'create';
        models.push(created);
        changes.push({ op, path: String(model.name), before: null, after: model.name, destructive: false });
        break;
      }

      case 'update_model_meta': {
        const model = findModel(modelName);
        if (!model) {
          skipped.push({ op, reason: `模型 ${modelName} 不存在` });
          break;
        }
        const patch = isObject(raw.changes) ? raw.changes : {};
        if (typeof patch.display_name === 'string') {
          const before = model.display_name;
          model.display_name = patch.display_name;
          changes.push({ op, path: `${modelName}.display_name`, before, after: patch.display_name, destructive: false });
        }
        if (typeof patch.description === 'string') {
          const before = model.description;
          model.description = patch.description;
          changes.push({ op, path: `${modelName}.description`, before, after: patch.description, destructive: false });
        }
        break;
      }

      case 'remove_model': {
        const index = models.findIndex((model) => isObject(model) && model.name === modelName);
        if (index < 0) {
          skipped.push({ op, reason: `模型 ${modelName} 不存在` });
          break;
        }
        models.splice(index, 1);
        changes.push({ op, path: modelName, before: modelName, after: null, destructive: true });
        break;
      }

      case 'add_field': {
        const model = findModel(modelName);
        const field = raw.field;
        if (!model || !isObject(field) || typeof field.name !== 'string') {
          skipped.push({ op, reason: `add_field 目标或字段不合法（模型 ${modelName}）` });
          break;
        }
        const fields = (model.fields as Record<string, unknown>[]) ?? [];
        if (fields.some((item) => item.name === field.name)) {
          skipped.push({ op, reason: `字段 ${modelName}.${field.name} 已存在` });
          break;
        }
        const created = clone(field);
        fields.push(created);
        model.fields = fields;
        changes.push({ op, path: `${modelName}.${field.name}`, before: null, after: created, destructive: false });
        break;
      }

      case 'update_field': {
        const model = findModel(modelName);
        const fieldName = String(raw.field ?? '');
        const patch = isObject(raw.changes) ? raw.changes : {};
        const fields = (model?.fields as Record<string, unknown>[]) ?? [];
        const field = fields.find((item) => item.name === fieldName);
        if (!model || !field) {
          skipped.push({ op, reason: `字段 ${modelName}.${fieldName} 不存在` });
          break;
        }
        const applied: Record<string, unknown> = {};
        for (const key of FIELD_PATCH_KEYS) {
          if (!(key in patch)) continue;
          applied[key] = patch[key];
        }
        if (Object.keys(applied).length === 0) {
          skipped.push({ op, reason: `update_field 没有可应用的键（${modelName}.${fieldName}）` });
          break;
        }
        const before = Object.fromEntries(Object.keys(applied).map((key) => [key, field[key]]));
        // 先判断破坏性再写回：写回后 field 上的旧值已被覆盖
        const destructive = isDestructivePatch(before, applied);
        Object.assign(field, applied);
        changes.push({ op, path: `${modelName}.${fieldName}`, before, after: applied, destructive });
        break;
      }

      case 'remove_field': {
        const model = findModel(modelName);
        const fieldName = String(raw.field ?? '');
        const fields = (model?.fields as Record<string, unknown>[]) ?? [];
        const index = fields.findIndex((item) => item.name === fieldName);
        if (!model || index < 0) {
          skipped.push({ op, reason: `字段 ${modelName}.${fieldName} 不存在` });
          break;
        }
        const [removed] = fields.splice(index, 1);
        model.fields = fields;
        changes.push({ op, path: `${modelName}.${fieldName}`, before: removed, after: null, destructive: true });
        break;
      }

      case 'add_index': {
        const model = findModel(modelName);
        const index = raw.index;
        if (!model || !isObject(index)) {
          skipped.push({ op, reason: `add_index 目标或索引不合法（模型 ${modelName}）` });
          break;
        }
        const indexes = (model.indexes as unknown[]) ?? [];
        indexes.push(clone(index));
        model.indexes = indexes;
        changes.push({ op, path: `${modelName}.indexes`, before: null, after: index, destructive: false });
        break;
      }

      case 'remove_index': {
        const model = findModel(modelName);
        const columns = Array.isArray(raw.fields) ? raw.fields.map(String) : [];
        if (!model || columns.length === 0) {
          skipped.push({ op, reason: `remove_index 参数不合法（模型 ${modelName}）` });
          break;
        }
        const indexes = (model.indexes as Record<string, unknown>[]) ?? [];
        const index = indexes.findIndex(
          (item) => Array.isArray(item.fields) && JSON.stringify(item.fields) === JSON.stringify(columns),
        );
        if (index < 0) {
          skipped.push({ op, reason: `索引 [${columns.join(', ')}] 不存在` });
          break;
        }
        const [removed] = indexes.splice(index, 1);
        model.indexes = indexes;
        changes.push({ op, path: `${modelName}.indexes`, before: removed, after: null, destructive: true });
        break;
      }

      case 'set_enum': {
        const model = findModel(modelName);
        const fieldName = String(raw.field ?? '');
        const values = Array.isArray(raw.values) ? raw.values.map(String) : [];
        const fields = (model?.fields as Record<string, unknown>[]) ?? [];
        const field = fields.find((item) => item.name === fieldName);
        if (!model || !field || values.length === 0) {
          skipped.push({ op, reason: `set_enum 目标或取值不合法（${modelName}.${fieldName}）` });
          break;
        }
        const before = field.enum_values;
        field.enum_values = values;
        changes.push({
          op,
          path: `${modelName}.${fieldName}.enum_values`,
          before,
          after: values,
          destructive: Array.isArray(before) && before.some((item) => !values.includes(String(item))),
        });
        break;
      }

      default:
        skipped.push({ op: op === '' ? 'unknown' : op, reason: '不支持的操作' });
    }
  }

  // 版本号总是基于旧草案 +1，避免模型回填错误 revision
  const revision = Number(draft.revision);
  next.revision = Number.isInteger(revision) ? revision + 1 : 1;
  next.base_revision = Number.isInteger(revision) ? revision : 0;
  next.operations = [];

  return {
    draft: next,
    changes,
    skipped,
    destructive: changes.some((change) => change.destructive),
  };
}
