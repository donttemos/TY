/*
 * @file 建模上下文采集单测（PRD-017 FR-17-24）
 * @description 上下文是「不让模型瞎猜」的前提：数据库类型必须从 datasource 读，
 *   框架约定按实际字段出现率推断，schema 缺失时要降级并说明，而不是编一份。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { buildDesignerContext, detectConventions, detectDatabase, summarizeContext } from '../context.js';

let tmpDir: string;

const SCHEMA = `
datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

model Category {
  id        String   @id
  tenantId  String
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?
}

model Product {
  id        String   @id
  tenantId  String
  name      String
  createdAt DateTime @default(now())
  updatedAt DateTime @updatedAt
  deletedAt DateTime?
}
`;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-model-ctx-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('detectDatabase', () => {
  it('从 datasource 读 provider', () => {
    expect(detectDatabase(SCHEMA)).toBe('postgresql');
  });

  it('读不到时返回空串（不猜）', () => {
    expect(detectDatabase('model A { id String @id }')).toBe('');
  });
});

describe('detectConventions', () => {
  it('按出现率推断主键/租户/审计/软删除', () => {
    const conventions = detectConventions([
      { fields: ['id', 'tenantId', 'createdAt', 'updatedAt', 'deletedAt'] },
      { fields: ['id', 'tenantId', 'createdAt', 'updatedAt', 'deletedAt'] },
    ]);
    expect(conventions.primary_key).toContain('@id');
    expect(conventions.tenant_field).toBe('tenantId String');
    expect(conventions.audit_fields).toEqual(['createdAt', 'updatedAt']);
    expect(conventions.soft_delete).toContain('deletedAt');
    expect(conventions.note).toContain('出现率');
  });

  it('只有少数模型有某字段时不当作约定', () => {
    const conventions = detectConventions([
      { fields: ['id', 'tenantId'] },
      { fields: ['id'] },
      { fields: ['id'] },
    ]);
    expect(conventions.tenant_field).toBeUndefined();
  });

  it('没有模型时说明无法推断', () => {
    expect(detectConventions([]).note).toContain('无法推断');
  });
});

describe('buildDesignerContext', () => {
  it('读取 schema 后给出模型、数据库与约定', () => {
    fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), SCHEMA, 'utf8');

    const context = buildDesignerContext({ projectRoot: tmpDir });
    expect(context.database).toBe('postgresql');
    expect(context.existing_models.map((model) => model.name)).toEqual(['Category', 'Product']);
    expect(context.existing_models[0].fields).toContain('tenantId');
    expect(context.conventions.note).toContain('推断');
    expect(context.generator.unsupported).toContain('composite_primary_key');
    expect(summarizeContext(context).models).toBe(2);
  });

  it('schema 缺失时降级并明确说明，不编造模型', () => {
    const context = buildDesignerContext({ projectRoot: tmpDir });
    expect(context.existing_models).toEqual([]);
    expect(context.schema_excerpt).toBe('');
    expect(context.conventions.note).toContain('未读取到 schema');
  });

  it('超大 schema 截断并标注', () => {
    fs.mkdirSync(path.join(tmpDir, 'prisma'), { recursive: true });
    const large = `${SCHEMA}\n${'// filler\n'.repeat(3000)}`;
    fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), large, 'utf8');
    const context = buildDesignerContext({ projectRoot: tmpDir });
    expect(context.schema_excerpt).toContain('已截断');
    expect(summarizeContext(context).truncated).toBe(true);
  });
});
