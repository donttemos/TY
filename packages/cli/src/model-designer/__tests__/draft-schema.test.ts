/*
 * @file 模型草案校验单测（PRD-017 FR-17-24）
 * @description 用「合法最小草案 + 单点破坏」的方式锁死每条规则：
 *   任何一条校验被放松，对应用例都会失败。docs/51 的完整示例也必须通过这里。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { normalizeDraft, validateModelDraft, type ValidateOptions } from '../draft-schema.js';

/** 合法字段 */
const field = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  name: 'name',
  display_name: '名称',
  type: 'String',
  nullable: false,
  default: null,
  unique: false,
  indexed: false,
  relation: null,
  source: 'explicit',
  destructive: false,
  ui: { visible_in_list: true, searchable: false, control: 'input', required: true },
  ...overrides,
});

/** 合法草案 */
const draft = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
  protocol_version: '1.0',
  status: 'draft',
  revision: 1,
  base_revision: 0,
  requirement_summary: '商品管理',
  models: [
    {
      name: 'Product',
      display_name: '商品',
      action: 'create',
      fields: [field()],
      indexes: [],
      relations: [],
    },
  ],
  assumptions: [],
  questions: [],
  warnings: [],
  unsupported_features: [],
  migration_risks: [],
  recommended_call_params: { temperature: 0.2, max_output_tokens: 4000, reason: '稳定输出' },
  generation_profile: {
    list_page_size: 20,
    default_sort: 'createdAt desc',
    permissions: ['product:read'],
    seed_count: 5,
  },
  ...overrides,
});

const options: ValidateOptions = { existingModels: ['Category'], baseRevision: 0, mode: 'create' };

/** 取第一个问题的码 */
const codes = (value: unknown, opts: ValidateOptions = options): string[] =>
  validateModelDraft(value, opts).map((issue) => issue.code);

describe('validateModelDraft 结构', () => {
  it('合法草案零问题', () => {
    expect(validateModelDraft(draft(), options)).toEqual([]);
  });

  it('协议版本不符直接拒绝', () => {
    expect(codes(draft({ protocol_version: '2.0' }))).toContain('PROTOCOL');
  });

  it('revision 必须等于 base_revision + 1', () => {
    expect(codes(draft({ revision: 5 }))).toContain('REVISION');
  });

  it('请求版本与输出不一致视为冲突', () => {
    expect(codes(draft(), { ...options, baseRevision: 3 })).toContain('REVISION_CONFLICT');
  });

  it('create 模式必须有非空 models', () => {
    expect(codes(draft({ models: [] }))).toContain('MISSING');
  });

  it('needs_clarification 时 questions 至少一条', () => {
    expect(codes(draft({ status: 'needs_clarification', models: [] }))).toContain('MISSING');
  });

  it('rejected 必须给 error_code 与 message', () => {
    const result = codes(draft({ status: 'rejected', models: [] }));
    expect(result).toContain('MISSING');
  });
});

describe('validateModelDraft 语义', () => {
  it('模型名必须是 PascalCase，字段名必须是 lowerCamelCase', () => {
    const badModel = draft({ models: [{ ...(draft().models as object[])[0], name: 'product' }] });
    expect(codes(badModel)).toContain('PATTERN');
    const badField = draft({
      models: [{ ...(draft().models as object[])[0], name: 'Product', fields: [field({ name: 'ProductName' })] }],
    });
    expect(codes(badField)).toContain('PATTERN');
  });

  it('与已有模型同名且 action=create 时拒绝', () => {
    const result = draft({
      models: [{ ...(draft().models as object[])[0], name: 'Category', fields: [field()], indexes: [], relations: [] }],
    });
    expect(codes(result)).toContain('DUP_MODEL');
  });

  it('关系目标不存在时报 UNKNOWN_REF', () => {
    const result = draft({
      models: [
        {
          ...(draft().models as object[])[0],
          fields: [field({ relation: { target: 'Ghost', cardinality: 'many_to_one', field: 'products' } })],
        },
      ],
    });
    expect(codes(result)).toContain('UNKNOWN_REF');
  });

  it('Decimal 缺 precision/scale 时报错', () => {
    const result = draft({
      models: [{ ...(draft().models as object[])[0], fields: [field({ type: 'Decimal' })] }],
    });
    expect(codes(result)).toContain('MISSING');
  });

  it('自定义类型没有 enum_values 时拒绝', () => {
    const result = draft({
      models: [{ ...(draft().models as object[])[0], fields: [field({ type: 'ProductStatus' })] }],
    });
    expect(codes(result)).toContain('ENUM');
  });

  it('inferred 必须有 reason', () => {
    const result = draft({
      models: [{ ...(draft().models as object[])[0], fields: [field({ source: 'inferred' })] }],
    });
    expect(codes(result)).toContain('MISSING');
  });

  it('UI 里混入数据库属性时拒绝', () => {
    const result = draft({
      models: [
        {
          ...(draft().models as object[])[0],
          fields: [field({ ui: { visible_in_list: true, searchable: false, control: 'input', required: true, unique: true } })],
        },
      ],
    });
    expect(codes(result)).toContain('UI_MIXED');
  });

  it('索引列必须存在于模型字段', () => {
    const result = draft({
      models: [{ ...(draft().models as object[])[0], indexes: [{ fields: ['ghost'], unique: false, reason: 'x' }] }],
    });
    expect(codes(result)).toContain('UNKNOWN_REF');
  });

  it('更新已有字段且收窄为非空时要求 destructive', () => {
    const result = draft({
      models: [
        {
          ...(draft().models as object[])[0],
          action: 'update',
          fields: [field({ nullable: false, default: null, destructive: false })],
        },
      ],
    });
    expect(codes(result)).toContain('DESTRUCTIVE_UNMARKED');
  });
});

describe('validateModelDraft 增量与策略', () => {
  const reviseDraft = draft({
    revision: 2,
    base_revision: 1,
    models: [],
    operations: [{ op: 'add_field', model: 'Product', field: field(), reason: '需求追加' }],
  });
  const reviseOptions: ValidateOptions = { existingModels: ['Category', 'Product'], baseRevision: 1, mode: 'revise' };

  it('合法增量草案零问题', () => {
    expect(validateModelDraft(reviseDraft, reviseOptions)).toEqual([]);
  });

  it('未知操作类型被拒', () => {
    const result = draft({ ...reviseDraft, operations: [{ op: 'rewrite_all', reason: 'x' }] });
    expect(codes(result, reviseOptions)).toContain('ENUM');
  });

  it('操作缺 reason 被拒', () => {
    const result = draft({ ...reviseDraft, operations: [{ op: 'add_field', model: 'Product', field: field() }] });
    expect(codes(result, reviseOptions)).toContain('MISSING');
  });

  it('操作目标模型不存在时被拒（新增要用 add_model）', () => {
    const result = draft({ ...reviseDraft, operations: [{ op: 'add_field', model: 'Ghost', field: field(), reason: 'x' }] });
    expect(codes(result, reviseOptions)).toContain('UNKNOWN_REF');
  });

  it('输出含供应商/密钥键时触发策略拒绝', () => {
    expect(codes({ ...draft(), provider: 'openai' })).toContain('POLICY');
    expect(codes({ ...draft(), api_key: 'sk-x' })).toContain('POLICY');
  });
});

describe('normalizeDraft', () => {
  it('温度与输出上限越界时截断并说明', () => {
    const result = normalizeDraft(
      draft({ recommended_call_params: { temperature: 0.9, max_output_tokens: 99999, reason: 'x' } }),
    );
    const params = result.draft.recommended_call_params as { temperature: number; max_output_tokens: number };
    expect(params.temperature).toBe(0.3);
    expect(params.max_output_tokens).toBe(16000);
    expect(result.warnings).toHaveLength(2);
  });

  it('下限同样兜住', () => {
    const result = normalizeDraft(
      draft({ recommended_call_params: { temperature: 0.2, max_output_tokens: 10, reason: 'x' } }),
    );
    expect((result.draft.recommended_call_params as { max_output_tokens: number }).max_output_tokens).toBe(1024);
  });
});
