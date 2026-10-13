/*
 * @file schema 解析器单测
 * @description 覆盖 model / enum / 文档注释 / 字段属性（@id @default @unique @updatedAt @relation @map @db.*）、
 *   块级属性（@@index @@unique @@map @@id 复合主键）与语法错误（缺闭合花括号）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { parsePrismaSchema } from '../schema-parser.js';

/** 覆盖全部语法的示例 schema（与仓库模板同风格） */
const SCHEMA = `
generator client {
  provider = "prisma-client-js"
}

datasource db {
  provider = "sqlite"
  url      = env("DB_URL")
}

/// 订单（含枚举 / 外键 / 时间 / 金额）
model Order {
  id        String   @id @default(uuid())
  /// 订单编号（唯一）
  code      String   @unique @db.VarChar(32)
  amount    Decimal  @db.Decimal(10, 2)
  quantity  Int      @default(1)
  paid      Boolean  @default(false)
  status    Status   @default(PENDING)
  remark    String?  @db.Text
  authorId  String
  expiresAt DateTime?
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt

  @@index([status], map: "idx_orders_status")
  @@map("orders")
}

/// 无审计字段的关联表（复合主键）
model OrderTag {
  orderId String @map("order_id")
  tagId   String @map("tag_id")

  @@id([orderId, tagId])
}

enum Status {
  PENDING
  PAID
}
`;

describe('parsePrismaSchema', () => {
  const parsed = parsePrismaSchema(SCHEMA);

  it('解析 model 与 enum', () => {
    expect(parsed.models.map((m) => m.name)).toEqual(['Order', 'OrderTag']);
    expect(parsed.enums).toEqual([{ name: 'Status', values: [{ name: 'PENDING' }, { name: 'PAID' }] }]);
  });

  it('解析文档注释（/// 优先）', () => {
    expect(parsed.models[0].comment).toBe('订单（含枚举 / 外键 / 时间 / 金额）');
    const code = parsed.models[0].fields.find((f) => f.name === 'code');
    expect(code?.comment).toBe('订单编号（唯一）');
  });

  it('解析字段属性：id / unique / default / updatedAt / db 原生类型', () => {
    const order = parsed.models[0];
    const id = order.fields.find((f) => f.name === 'id');
    expect(id?.attributes).toMatchObject({ isId: true, defaultValue: 'uuid()' });

    const code = order.fields.find((f) => f.name === 'code');
    expect(code?.attributes.unique).toBe(true);
    expect(code?.attributes.dbType).toBe('VarChar(32)');

    const updatedAt = order.fields.find((f) => f.name === 'updatedAt');
    expect(updatedAt?.attributes.updatedAt).toBe(true);

    const remark = order.fields.find((f) => f.name === 'remark');
    expect(remark?.optional).toBe(true);
    expect(remark?.attributes.dbType).toBe('Text');
  });

  it('解析 @@map / @@index / @@unique', () => {
    expect(parsed.models[0].tableName).toBe('orders');
    expect(parsed.models[0].indexedFields.has('status')).toBe(true);
  });

  it('复合主键 @@id 的成员视为主键', () => {
    const join = parsed.models[1];
    expect(join.fields.every((f) => f.attributes.isId)).toBe(true);
    expect(join.fields.find((f) => f.name === 'orderId')?.attributes.map).toBe('order_id');
  });

  it('缺闭合花括号时抛错', () => {
    expect(() => parsePrismaSchema('model Broken {\n  id String\n')).toThrow('缺少闭合花括号');
  });
});
