/*
 * @file AI 补标注单测（FR-17-28 补充）
 * @description 只挑缺注释的对象；输出必须过滤不存在/超长/未请求的项，不能把模型编造的名字写进 schema。
 * @author donttemo
 * @created 2026-10-28
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import {
  buildAnnotateMessages,
  candidateStats,
  collectAnnotateCandidates,
  parseAnnotateResult,
  type AnnotateCandidate,
} from '../annotate.js';
import type { ModelView } from '../schema-api.js';

/** 造模型视图 */
const model = (name: string, labelSource: 'comment' | 'suggested' | 'none', fields: [string, 'comment' | 'suggested'][]): ModelView => ({
  name,
  label: labelSource === 'none' ? '' : '中文',
  labelSource,
  fields: fields.map(([fieldName, source]) => ({
    name: fieldName,
    type: 'String',
    optional: false,
    isList: false,
    attrs: '',
    label: source === 'comment' ? '中文' : '推断',
    labelSource: source,
  })),
  blockAttrs: [],
});

describe('collectAnnotateCandidates', () => {
  it('只收缺注释的模型与字段', () => {
    const models = [
      model('User', 'comment', [['name', 'comment'], ['age', 'suggested']]),
      model('Order', 'suggested', [['code', 'comment']]),
      model('Done', 'comment', [['id', 'comment']]),
    ];
    const candidates = collectAnnotateCandidates(models);
    expect(candidates.map((item) => item.model)).toEqual(['User', 'Order']);
    expect(candidates[0]).toMatchObject({ needModel: false, fields: [{ name: 'age' }] });
    expect(candidates[1]).toMatchObject({ needModel: true, fields: [] });
    expect(candidateStats(candidates)).toEqual({ models: 1, fields: 1 });
  });
});

describe('parseAnnotateResult', () => {
  const candidates: AnnotateCandidate[] = [
    { model: 'User', needModel: true, fields: [{ name: 'age', type: 'Int' }] },
    { model: 'Order', needModel: false, fields: [] },
  ];

  it('过滤不存在的模型/字段、超长标注与未请求的模型标注', () => {
    const result = parseAnnotateResult(
      JSON.stringify({
        models: [
          { name: 'User', label: '用户', fields: [{ name: 'age', label: '年龄' }, { name: 'ghost', label: '幽灵' }] },
          { name: 'Order', label: '订单', fields: [] },
          { name: 'Ghost', label: '幽灵表', fields: [] },
          { name: 'User', label: '这是一个非常非常非常非常长的标注超过上限', fields: [] },
        ],
      }),
      candidates,
    );
    // Order 不缺模型标注被丢弃；重复的 User 只保留第一条
    expect(result.models).toEqual([{ name: 'User', label: '用户' }]);
    expect(result.fields).toEqual([{ model: 'User', name: 'age', label: '年龄' }]);
  });

  it('全部无效时报错，而不是返回空结果假成功', () => {
    expect(() => parseAnnotateResult('{"models":[]}', candidates)).toThrow(/没有给出可用/);
    expect(() => parseAnnotateResult('not json', candidates)).toThrow(/合法 JSON/);
  });
});

describe('buildAnnotateMessages', () => {
  it('提示词要求纯 JSON 且写出候选清单', () => {
    const messages = buildAnnotateMessages([{ model: 'User', needModel: true, fields: [{ name: 'age', type: 'Int' }] }]);
    expect(messages[0].content).toContain('只输出一个 JSON 对象');
    expect(messages[1].content).toContain('"name":"User"');
    expect(messages[1].content).toContain('age:Int');
  });
});
