/*
 * @file JSON 识别单测（FR-17-04 补充）
 * @description 粘贴框要宽容但可预期：五种常见形态都能认，类型简写能转，超出上限与非法结构要明确拒绝。
 * @author donttemo
 * @created 2026-10-28
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { parseModelsJson, parseTypeShorthand } from '../json-import.js';

describe('parseTypeShorthand', () => {
  it('解析可空与数组简写', () => {
    expect(parseTypeShorthand('String?')).toEqual({ type: 'String', nullable: true, isList: false });
    expect(parseTypeShorthand('String[]')).toEqual({ type: 'String', nullable: false, isList: true });
    expect(parseTypeShorthand('Int')).toEqual({ type: 'Int', nullable: false, isList: false });
  });
});

describe('parseModelsJson', () => {
  it('识别 AI 草案信封 { models: [...] }', () => {
    const parsed = parseModelsJson(
      JSON.stringify({
        models: [
          {
            name: 'Tag',
            fields: [
              { name: 'name', type: 'String', nullable: false, unique: true },
              { name: 'color', type: 'String?' },
            ],
          },
        ],
      }),
    );
    expect(parsed.draft.models).toHaveLength(1);
    const fields = parsed.draft.models[0].fields as Record<string, unknown>[];
    expect(fields.map((field) => field.name)).toEqual(['name', 'color']);
    expect(fields[1].nullable).toBe(true);
    expect(fields[0].unique).toBe(true);
  });

  it('识别模型映射 { Tag: { fields: { name: "String" } } }', () => {
    const parsed = parseModelsJson(JSON.stringify({ Tag: { fields: { name: 'String', color: 'String?' } } }));
    const model = parsed.draft.models[0];
    expect(model.name).toBe('Tag');
    expect((model.fields as Record<string, unknown>[]).map((field) => field.name)).toEqual(['name', 'color']);
    expect(parsed.notes.join('')).toContain('顶层对象');
  });

  it('识别数组 [{ name, columns }] 与 tables 形态', () => {
    const array = parseModelsJson(JSON.stringify([{ name: 'Tag', columns: [{ name: 'id', type: 'String' }] }]));
    expect(array.draft.models[0].name).toBe('Tag');

    const tables = parseModelsJson(
      JSON.stringify({ tables: [{ name: 'Product', fields: [{ name: 'title', type: 'String' }] }] }),
    );
    expect(tables.draft.models[0].name).toBe('Product');
    expect(tables.notes.join('')).toContain('tables');
  });

  it('重复模型去重并说明', () => {
    const parsed = parseModelsJson(
      JSON.stringify({
        models: [
          { name: 'Tag', fields: [{ name: 'a', type: 'String' }] },
          { name: 'Tag', fields: [{ name: 'b', type: 'String' }] },
        ],
      }),
    );
    expect(parsed.draft.models).toHaveLength(1);
    expect(parsed.notes.join('')).toContain('跳过重复模型');
  });

  it('自定义类型给出提示而不是拒绝', () => {
    const parsed = parseModelsJson(
      JSON.stringify({ models: [{ name: 'Tag', fields: [{ name: 'status', type: 'TagStatus', enum_values: ['ON', 'OFF'] }] }] }),
    );
    expect(parsed.notes.join('')).toContain('TagStatus');
  });

  it('语法错误、空输入、认不出的结构都明确报错', () => {
    expect(() => parseModelsJson('')).toThrow(/为空/);
    expect(() => parseModelsJson('{oops')).toThrow(/语法错误/);
    expect(() => parseModelsJson('"just a string"')).toThrow(/认不出结构/);
    expect(() => parseModelsJson('{"models":[{"fields":[]}]}')).toThrow(/都有 name|都得有 name/);
    expect(() => parseModelsJson('{"models":[{"name":"1Bad","fields":[]}]}')).toThrow(/模型名不合法/);
  });

  it('超过上限时拒绝', () => {
    const many = {
      models: Array.from({ length: 51 }, (_, index) => ({ name: `M${index}`, fields: [{ name: 'a', type: 'String' }] })),
    };
    expect(() => parseModelsJson(JSON.stringify(many))).toThrow(/最多识别 50 个模型/);
  });
});
