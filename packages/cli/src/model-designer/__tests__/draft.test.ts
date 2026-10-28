/*
 * @file 草案生成编排单测（PRD-017 FR-17-24）
 * @description 不联网验证：JSON 模式调用、失败回灌重试 1 次、语义错误不重试、
 *   policy 直接拒绝、revise 版本冲突在调用前就挡住。这些分支决定「坏草案会不会流到编辑器」。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it, vi } from 'vitest';
import { DraftError, runDraftDesign } from '../draft.js';
import type { DesignerContext } from '../context.js';

const config = { baseUrl: 'https://ai.local/v1', apiKey: 'sk-test', model: 'draft-model' };

const context: DesignerContext = {
  database: 'postgresql',
  schema_file: '/tmp/schema.prisma',
  schema_excerpt: 'model Category { id String @id }',
  existing_models: [{ name: 'Category', fields: ['id', 'name'] }],
  conventions: { primary_key: 'id String @id', audit_fields: [], note: '测试' },
  generator: { supports: ['single_primary_key'], unsupported: ['composite_primary_key'] },
  ui: { controls: ['input', 'select'], list_features: ['search'] },
};

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
  models: [{ name: 'Product', display_name: '商品', action: 'create', fields: [field()], indexes: [], relations: [] }],
  assumptions: [],
  questions: [],
  warnings: [],
  unsupported_features: [],
  migration_risks: [],
  recommended_call_params: { temperature: 0.2, max_output_tokens: 4000, reason: '稳定输出' },
  generation_profile: { list_page_size: 20, default_sort: 'createdAt desc', permissions: ['product:read'], seed_count: 5 },
  ...overrides,
});

/** 构造聊天补全响应 */
const completion = (content: string): Response =>
  new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });

/** 记录请求体的 fetch 替身（按顺序返回预设内容） */
function scriptedFetch(contents: string[]): { fetchImpl: typeof fetch; bodies: string[] } {
  const bodies: string[] = [];
  let index = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    bodies.push(String(init.body));
    const content = contents[Math.min(index, contents.length - 1)];
    index += 1;
    return completion(content);
  }) as unknown as typeof fetch;
  return { fetchImpl, bodies };
}

describe('runDraftDesign', () => {
  it('一次通过：返回草案与上下文摘要', async () => {
    const { fetchImpl, bodies } = scriptedFetch([JSON.stringify(draft())]);
    const result = await runDraftDesign(
      { requirement: '做商品管理', mode: 'create' },
      { config, context, fetchImpl },
    );
    expect(result.attempts).toBe(1);
    expect((result.draft.models as unknown[]).length).toBe(1);
    expect(result.context.existing_models[0].name).toBe('Category');
    const body = JSON.parse(bodies[0]) as { response_format?: { type: string }; messages: { role: string }[] };
    expect(body.response_format).toEqual({ type: 'json_object' });
    expect(body.messages[0].role).toBe('system');
  });

  it('首次缺字段：带路径回灌重试一次后通过', async () => {
    const bad = draft({ protocol_version: undefined });
    const { fetchImpl, bodies } = scriptedFetch([JSON.stringify(bad), JSON.stringify(draft())]);
    const result = await runDraftDesign({ requirement: '做商品管理', mode: 'create' }, { config, context, fetchImpl });
    expect(result.attempts).toBe(2);
    const second = JSON.parse(bodies[1]) as { messages: { role: string; content: string }[] };
    expect(second.messages).toHaveLength(4);
    expect(second.messages[2].role).toBe('assistant');
    expect(second.messages[3].content).toContain('protocol_version');
  });

  it('两次都不合法：抛 schema-invalid 并带问题列表', async () => {
    const bad = JSON.stringify(draft({ models: [] }));
    const { fetchImpl } = scriptedFetch([bad, bad]);
    await expect(runDraftDesign({ requirement: '做商品管理', mode: 'create' }, { config, context, fetchImpl })).rejects.toMatchObject({
      code: 'schema-invalid',
    });
  });

  it('首次不是 JSON：重试后通过', async () => {
    const { fetchImpl } = scriptedFetch(['这不是 JSON', JSON.stringify(draft())]);
    const result = await runDraftDesign({ requirement: '做商品管理', mode: 'create' }, { config, context, fetchImpl });
    expect(result.attempts).toBe(2);
  });

  it('输出含供应商字段：策略拒绝且不重试', async () => {
    const fetchImpl = vi.fn(async () => completion(JSON.stringify({ ...draft(), provider: 'openai' }))) as unknown as typeof fetch;
    await expect(runDraftDesign({ requirement: '做商品管理', mode: 'create' }, { config, context, fetchImpl })).rejects.toMatchObject({
      code: 'policy',
    });
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  it('revise 的 baseRevision 与草案不一致：调用前就报冲突', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      runDraftDesign(
        { requirement: '加多图', mode: 'revise', baseRevision: 1, draft: { revision: 2 } },
        { config, context, fetchImpl },
      ),
    ).rejects.toMatchObject({ code: 'revision-conflict' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('未配置密钥：ai-not-configured，不联网', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    await expect(
      runDraftDesign({ requirement: '做商品管理', mode: 'create' }, { context, fetchImpl, env: {} }),
    ).rejects.toBeInstanceOf(DraftError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('温度建议越界：返回前截断并记 warning', async () => {
    const draftWithHot = draft({
      recommended_call_params: { temperature: 1.2, max_output_tokens: 4000, reason: 'x' },
    });
    const { fetchImpl } = scriptedFetch([JSON.stringify(draftWithHot)]);
    const result = await runDraftDesign({ requirement: '做商品管理', mode: 'create' }, { config, context, fetchImpl });
    expect((result.draft.recommended_call_params as { temperature: number }).temperature).toBe(0.3);
    expect(result.warnings.join('\n')).toContain('temperature');
  });

  it('无效关系自动丢弃（缺 target/基数/反向字段），不整份失败', async () => {
    const messy = draft();
    // 复刻线上那次：relations[0] 是个空对象，target/cardinality/field 全缺
    (messy.models as Record<string, unknown>[])[0].relations = [{}];
    const { fetchImpl } = scriptedFetch([JSON.stringify(messy)]);
    const result = await runDraftDesign({ requirement: '做标签管理', mode: 'create' }, { config, context, fetchImpl });
    const model = (result.draft.models as Record<string, unknown>[])[0];
    expect(model.relations).toEqual([]);
    expect(result.attempts).toBe(1);
    expect(result.warnings.join('\n')).toContain('丢弃一个无效关系');
  });

  it('字段级关系目标不存在时降级为普通外键并记 warning', async () => {
    const messy = draft();
    const fields = (messy.models as Record<string, unknown>[])[0].fields as Record<string, unknown>[];
    fields[0].relation = { target: 'Ghost', cardinality: 'many_to_one', field: 'items' };
    const { fetchImpl } = scriptedFetch([JSON.stringify(messy)]);
    const result = await runDraftDesign({ requirement: '做标签管理', mode: 'create' }, { config, context, fetchImpl });
    const model = (result.draft.models as Record<string, unknown>[])[0];
    expect((model.fields as Record<string, unknown>[])[0].relation).toBeNull();
    expect(result.warnings.join('\n')).toContain('保留为普通外键');
  });

  it('UI 布尔与无效索引自动修复并记 warning（不再整份拒绝）', async () => {
    const messy = draft();
    const model = (messy.models as Record<string, unknown>[])[0];
    const fields = model.fields as Record<string, unknown>[];
    (fields[0].ui as Record<string, unknown>).searchable = 'yes';
    model.indexes = [{ fields: ['createdAt'], unique: 'unique', reason: '' }];
    const { fetchImpl } = scriptedFetch([JSON.stringify(messy)]);
    const result = await runDraftDesign({ requirement: '做标签管理', mode: 'create' }, { config, context, fetchImpl });
    const repaired = (result.draft.models as Record<string, unknown>[])[0];
    expect(((repaired.fields as Record<string, unknown>[])[0].ui as Record<string, unknown>).searchable).toBe(false);
    expect(repaired.indexes).toEqual([]);
    expect(result.warnings.join('\n')).toContain('丢弃索引');
  });

  it('缺少 generation_profile / 调用参数 / 空数组时按默认补齐，不整份失败', async () => {
    const minimal = draft();
    delete (minimal as Record<string, unknown>).generation_profile;
    delete (minimal as Record<string, unknown>).recommended_call_params;
    delete (minimal as Record<string, unknown>).assumptions;
    delete (minimal as Record<string, unknown>).warnings;
    const { fetchImpl } = scriptedFetch([JSON.stringify(minimal)]);
    const result = await runDraftDesign({ requirement: '做标签管理', mode: 'create' }, { config, context, fetchImpl });
    const profile = result.draft.generation_profile as { list_page_size: number; permissions: string[] };
    expect(profile.list_page_size).toBe(20);
    expect(profile.permissions).toContain('product:read');
    expect(result.warnings.join('\n')).toContain('补齐');
  });

  it('需求为空或过长：invalid-input', async () => {
    await expect(runDraftDesign({ requirement: '  ', mode: 'create' }, { config, context })).rejects.toMatchObject({
      code: 'invalid-input',
    });
    await expect(
      runDraftDesign({ requirement: 'x'.repeat(4001), mode: 'create' }, { config, context }),
    ).rejects.toMatchObject({ code: 'invalid-input' });
  });
});
