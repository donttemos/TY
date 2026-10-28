/*
 * @file 增量操作应用单测（PRD-017 FR-17-24）
 * @description 锁死「只改操作点名的东西」：未点名的字段必须原样保留（这是不覆盖用户修改的根），
 *   破坏性变更必须被标记，revision 必须基于旧草案 +1 而不是采信模型回填。
 * @author donttemo
 * @created 2026-10-27
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { applyOperations } from '../apply-operations.js';

/** 基础草案 */
const base = (): Record<string, unknown> => ({
  protocol_version: '1.0',
  status: 'draft',
  revision: 1,
  base_revision: 0,
  requirement_summary: '标签管理',
  models: [
    {
      name: 'Tag',
      display_name: '标签',
      action: 'create',
      fields: [
        { name: 'name', display_name: '名称', type: 'String', nullable: false, default: null, unique: true, indexed: false },
        { name: 'sort', display_name: '排序', type: 'Int', nullable: false, default: 0, unique: false, indexed: false },
      ],
      indexes: [],
      relations: [],
    },
  ],
  operations: [],
});

describe('applyOperations', () => {
  it('add_field 只加字段，不动其他字段', () => {
    const result = applyOperations(base(), [
      { op: 'add_field', model: 'Tag', field: { name: 'color', display_name: '颜色', type: 'String', nullable: true, default: null }, reason: '需求' },
    ]);
    const model = (result.draft.models as Record<string, unknown>[])[0];
    expect((model.fields as Record<string, unknown>[]).map((field) => field.name)).toEqual(['name', 'sort', 'color']);
    expect(result.changes[0]).toMatchObject({ op: 'add_field', path: 'Tag.color', destructive: false });
  });

  it('update_field 只改 patch 里的键，未点名字段保持不变', () => {
    const result = applyOperations(base(), [
      { op: 'update_field', model: 'Tag', field: 'sort', changes: { display_name: '顺序' } },
    ]);
    const field = ((result.draft.models as Record<string, unknown>[])[0].fields as Record<string, unknown>[])[1];
    expect(field.display_name).toBe('顺序');
    expect(field.type).toBe('Int');
    expect(field.default).toBe(0);
    expect(result.changes[0].destructive).toBe(false);
  });

  it('改类型/收窄可空/去唯一被标记为破坏性', () => {
    const result = applyOperations(base(), [
      { op: 'update_field', model: 'Tag', field: 'name', changes: { type: 'Int' } },
      { op: 'update_field', model: 'Tag', field: 'sort', changes: { nullable: false, unique: false } },
    ]);
    expect(result.changes[0].destructive).toBe(true);
    expect(result.destructive).toBe(true);
  });

  it('remove_field 删除字段并标记破坏性', () => {
    const result = applyOperations(base(), [{ op: 'remove_field', model: 'Tag', field: 'sort', reason: '不需要' }]);
    const model = (result.draft.models as Record<string, unknown>[])[0];
    expect((model.fields as Record<string, unknown>[]).map((field) => field.name)).toEqual(['name']);
    expect(result.changes[0].destructive).toBe(true);
  });

  it('add_model / remove_model / update_model_meta', () => {
    const added = applyOperations(base(), [
      { op: 'add_model', model: { name: 'TagGroup', display_name: '标签组', fields: [], indexes: [], relations: [] } },
    ]);
    expect((added.draft.models as unknown[]).length).toBe(2);

    const meta = applyOperations(added.draft, [
      { op: 'update_model_meta', name: 'TagGroup', changes: { display_name: '分组' } },
    ]);
    expect(((meta.draft.models as Record<string, unknown>[])[1]).display_name).toBe('分组');

    const removed = applyOperations(meta.draft, [{ op: 'remove_model', name: 'TagGroup', reason: '合并' }]);
    expect((removed.draft.models as unknown[]).length).toBe(1);
    expect(removed.changes[0].destructive).toBe(true);
  });

  it('add_index / remove_index / set_enum', () => {
    const withIndex = applyOperations(base(), [
      { op: 'add_index', model: 'Tag', index: { fields: ['name'], unique: false, reason: '搜索' } },
    ]);
    expect(((withIndex.draft.models as Record<string, unknown>[])[0].indexes as unknown[]).length).toBe(1);

    const removed = applyOperations(withIndex.draft, [{ op: 'remove_index', model: 'Tag', fields: ['name'] }]);
    expect(((removed.draft.models as Record<string, unknown>[])[0].indexes as unknown[]).length).toBe(0);

    const enums = applyOperations(base(), [{ op: 'set_enum', model: 'Tag', field: 'name', values: ['RED', 'BLUE'] }]);
    expect((((enums.draft.models as Record<string, unknown>[])[0].fields as Record<string, unknown>[])[0]).enum_values).toEqual(['RED', 'BLUE']);
  });

  it('目标不存在 / 未知操作进 skipped，不污染草案', () => {
    const result = applyOperations(base(), [
      { op: 'add_field', model: 'Ghost', field: { name: 'x' }, reason: 'x' },
      { op: 'rewrite_all', reason: 'x' },
    ]);
    expect(result.skipped).toHaveLength(2);
    expect(result.changes).toEqual([]);
  });

  it('revision 基于旧草案 +1，不采信模型回填', () => {
    const result = applyOperations({ ...base(), revision: 7 }, []);
    expect(result.draft.revision).toBe(8);
    expect(result.draft.base_revision).toBe(7);
    expect(result.draft.operations).toEqual([]);
  });
});
