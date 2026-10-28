/*
 * @file 草案 → 设计器草稿单测（FR-17-24 第三步）
 * @description 转换只做格式与约定补齐，不写盘。锁死四件事：框架字段补齐、约束翻译（unique/index）、
 *   关系只留外键并提示、非 create 的操作不硬导。
 * @author donttemo
 * @created 2026-10-23
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { defaultAttr, draftToEditorModels } from '../to-editor.js';

const conventions = {
  primary_key: 'id String @id @default(uuid())',
  tenant_field: 'tenantId String',
  audit_fields: ['createdAt', 'updatedAt'],
  soft_delete: 'deletedAt DateTime?',
  note: '测试',
};

/** 商品草案（含关系与索引） */
const draft = {
  models: [
    {
      name: 'Tag',
      action: 'create',
      fields: [
        {
          name: 'name', type: 'String', nullable: false, default: null, unique: true, indexed: true,
          relation: null, enum_values: undefined,
        },
        { name: 'color', type: 'String', nullable: true, default: null, unique: false, indexed: false, relation: null },
        { name: 'sortOrder', type: 'Int', nullable: false, default: 0, unique: false, indexed: false, relation: null },
        {
          name: 'categoryId', type: 'String', nullable: false, default: null, unique: false, indexed: true,
          relation: { target: 'Category', cardinality: 'many_to_one', field: 'tags' },
        },
      ],
      indexes: [{ fields: ['name', 'sortOrder'], unique: true }],
    },
    { name: 'Category', action: 'update', fields: [] },
  ],
};

describe('defaultAttr', () => {
  it('数字/布尔/枚举/字符串/时间各按 Prisma 语法翻译', () => {
    expect(defaultAttr({ default: 0, type: 'Int' })).toBe('@default(0)');
    expect(defaultAttr({ default: true, type: 'Boolean' })).toBe('@default(true)');
    expect(defaultAttr({ default: 'ON_SALE', type: 'TagStatus', enum_values: ['ON_SALE'] })).toBe('@default(ON_SALE)');
    expect(defaultAttr({ default: 'x', type: 'String' })).toBe('@default("x")');
    expect(defaultAttr({ default: '2026-01-01', type: 'DateTime' })).toBe('@default(now())');
    expect(defaultAttr({ default: null, type: 'String' })).toBe('');
  });
});

describe('draftToEditorModels', () => {
  it('补齐框架字段、翻译约束、关系只留外键并提示', () => {
    const result = draftToEditorModels(draft as unknown as Record<string, unknown>, {
      conventions,
      database: 'postgresql',
    });
    expect(result.models).toHaveLength(1);
    const model = result.models[0];
    expect(model.name).toBe('Tag');
    expect(model.fields.map((field) => field.name)).toEqual([
      'id',
      'name',
      'color',
      'sortOrder',
      'categoryId',
      'tenantId',
      'createdAt',
      'updatedAt',
      'deletedAt',
    ]);
    expect(model.fields.find((field) => field.name === 'name')?.attrs).toBe('@unique');
    // 中文标注：草案没给 display_name 时按命名推断
    expect(model.label).toBe('标签');
    expect(model.fields.find((field) => field.name === 'name')?.label).toBe('名称');
    expect(model.fields.find((field) => field.name === 'sortOrder')?.attrs).toBe('@default(0)');
    expect(model.fields.find((field) => field.name === 'color')?.optional).toBe(true);
    // 单列 indexed + 复合唯一索引都落到 blockAttrs
    // name 已有 @unique，不再重复单列索引；categoryId 单列索引 + 复合唯一索引各自落地
    expect(model.blockAttrs).toEqual(['@@index([categoryId])', '@@unique([name, sortOrder])']);
    expect(result.notes.join('\n')).toContain('关系字段 categoryId');
    expect(result.notes.join('\n')).toContain('补了 tenantId');
  });

  it('update/delete 不硬导，给出原因', () => {
    const result = draftToEditorModels(draft as unknown as Record<string, unknown>, {
      conventions,
      database: 'sqlite',
    });
    expect(result.skipped).toEqual([{ model: 'Category', reason: expect.stringContaining('update') }]);
  });

  it('Decimal 只在 postgres/mysql 写 @db.Decimal', () => {
    const money = {
      models: [
        {
          name: 'Product',
          action: 'create',
          fields: [{ name: 'price', type: 'Decimal', precision: 18, scale: 2, nullable: false, default: null, unique: false, indexed: false, relation: null }],
          indexes: [],
        },
      ],
    };
    const pg = draftToEditorModels(money as unknown as Record<string, unknown>, { conventions, database: 'postgresql' });
    expect(pg.models[0].fields.find((field) => field.name === 'price')?.attrs).toContain('@db.Decimal(18, 2)');
    const lite = draftToEditorModels(money as unknown as Record<string, unknown>, { conventions, database: 'sqlite' });
    expect(lite.models[0].fields.find((field) => field.name === 'price')?.attrs).not.toContain('@db.');
  });

  it('与 @unique 重复的单列索引跳过；对象型 unsupported 打印可读', () => {
    const messy = {
      models: [
        {
          name: 'Dict',
          action: 'create',
          fields: [{ name: 'code', type: 'String', nullable: false, default: null, unique: true, indexed: true, relation: null }],
          indexes: [{ fields: ['code'], unique: false }],
        },
      ],
      unsupported_features: [{ feature: 'composite_unique', reason: '生成器不支持' }],
    };
    const result = draftToEditorModels(messy as unknown as Record<string, unknown>, {
      conventions,
      database: 'postgresql',
    });
    expect(result.models[0].blockAttrs).toEqual([]);
    expect(result.notes.join('\n')).toContain('跳过与 @unique 重复的索引');
    expect(result.notes.join('\n')).toContain('composite_unique');
  });

  it('草案为空时给说明而不是抛错', () => {
    const result = draftToEditorModels({ models: [] }, { conventions, database: 'postgresql' });
    expect(result.models).toEqual([]);
    expect(result.notes.join('')).toContain('没有可导入的模型');
  });
});
