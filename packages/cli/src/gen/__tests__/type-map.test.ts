/*
 * @file 类型映射与字段元信息单测
 * @description 覆盖 PRD-006 §6 映射表核心约束：bigint / decimal / *_id → string（禁 number 防精度丢失）、
 *   enum → 联合字面量 + dict-select、@db.Text → textarea、@db.VarChar(n) → 长度上限、
 *   外键 → select、未命中类型报错不猜测、项目级覆盖合并与非法覆盖报错、命名辅助函数。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { parsePrismaSchema } from '../schema-parser.js';
import {
  BASE_FIELDS,
  TYPE_MAP,
  camelCase,
  kebabCase,
  mergeTypeMap,
  pascalCase,
  pluralize,
  resolveFieldMeta,
  resolveModelFields,
  snakeCase,
} from '../type-map.js';

/** 单模型 schema（含全部关键类型） */
const SCHEMA = `
/// 帖子（映射表覆盖用例）
model Post {
  id        String   @id @default(uuid())
  title     String   @db.VarChar(64)
  content   String?  @db.Text
  views     Int      @default(0)
  rating    Decimal  @db.Decimal(3, 2)
  authorId  String
  published Boolean  @default(false)
  status    PostStatus @default(DRAFT)
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  createdBy String   @default("system")
  updatedBy String   @default("system")
  deletedAt DateTime?
}

enum PostStatus {
  DRAFT
  PUBLISHED
}
`;

const parsed = parsePrismaSchema(SCHEMA);
const model = parsed.models[0];
const context = { enums: parsed.enums };
const byName = (name: string) => resolveFieldMeta(model, model.fields.find((f) => f.name === name)!, context);

describe('类型映射表', () => {
  it('bigint / decimal 一律映射为 string（禁 number，防精度丢失）', () => {
    expect(TYPE_MAP.BigInt.tsType).toBe('string');
    expect(TYPE_MAP.Decimal.tsType).toBe('string');
  });

  it('datetime 映射为 string(Date)，控件为日期时间选择器', () => {
    expect(TYPE_MAP.DateTime).toMatchObject({ tsType: 'string', control: 'datetime' });
  });
});

describe('resolveFieldMeta', () => {
  it('字符串带长度上限（@db.VarChar）', () => {
    const title = byName('title');
    expect(title).toMatchObject({ tsType: 'string', control: 'input', maxLength: 64, required: true });
  });

  it('@db.Text 映射为 textarea', () => {
    expect(byName('content').control).toBe('textarea');
  });

  it('decimal 字段为 string 且金额录入', () => {
    expect(byName('rating')).toMatchObject({ tsType: 'string', control: 'input' });
  });

  it('int（非 ID）为 number 数字框', () => {
    expect(byName('views')).toMatchObject({ tsType: 'number', control: 'number' });
  });

  it('外键 *_id 为 string + 关联选择，且必填', () => {
    const author = byName('authorId');
    expect(author).toMatchObject({ tsType: 'string', control: 'select', isForeignKey: true, required: true });
  });

  it('enum 为联合字面量 + 字典下拉', () => {
    const status = byName('status');
    expect(status.tsType).toBe("'DRAFT' | 'PUBLISHED'");
    expect(status.control).toBe('dict-select');
    expect(status.dictCode).toBe('post_status');
    expect(status.enumValues).toEqual(['DRAFT', 'PUBLISHED']);
  });

  it('BaseEntity 通用字段被标记且不进表单', () => {
    for (const name of BASE_FIELDS) {
      const field = byName(name);
      expect(field.isBase).toBe(true);
      expect(field.inForm).toBe(false);
    }
  });

  it('未命中映射表的类型直接报错，不猜测', () => {
    const weird = parsePrismaSchema('model X {\n  id String @id\n  payload Bytes\n}\n');
    expect(() => resolveModelFields(weird.models[0], { enums: [] })).toThrow('未命中映射表');
  });

  it('项目级覆盖改变映射结果', () => {
    const overridden = resolveFieldMeta(model, model.fields.find((f) => f.name === 'views')!, {
      enums: parsed.enums,
      overrides: { Int: { control: 'switch' } },
    });
    expect(overridden.control).toBe('switch');
  });
});

describe('mergeTypeMap', () => {
  it('覆盖已注册类型', () => {
    const merged = mergeTypeMap({ String: { control: 'textarea' } });
    expect(merged.String.control).toBe('textarea');
    // 内置表不被污染
    expect(TYPE_MAP.String.control).toBe('input');
  });

  it('覆盖未注册类型时报错并列出可选类型', () => {
    expect(() => mergeTypeMap({ Bytes: { tsType: 'string' } } as never)).toThrow('未注册的类型');
  });
});

describe('命名辅助', () => {
  it('pascal / camel / kebab / snake', () => {
    expect(pascalCase('order-item')).toBe('OrderItem');
    expect(camelCase('OrderItem')).toBe('orderItem');
    expect(kebabCase('OrderItem')).toBe('order-item');
    expect(snakeCase('OrderItem')).toBe('order_item');
  });

  it('pluralize 常见规则', () => {
    expect(pluralize('order')).toBe('orders');
    expect(pluralize('category')).toBe('categories');
    expect(pluralize('box')).toBe('boxes');
    expect(pluralize('dish')).toBe('dishes');
  });
});
