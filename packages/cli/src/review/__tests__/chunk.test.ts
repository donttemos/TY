/*
 * @file 分片规划单测（FR-17-23 补强）
 * @description 目标：任何一片都不超过预算，超大单文件不反复切，片数超限时给出可执行提示。
 * @author donttemo
 * @created 2026-10-27
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { planReviewChunks, splitFileContent } from '../chunk.js';

/** 造文件 */
const file = (name: string, kb: number) => ({ path: name, bytes: kb * 1024 });

describe('planReviewChunks', () => {
  it('按预算贪心装填，顺序不变', () => {
    const plan = planReviewChunks([file('a', 10), file('b', 10), file('c', 10)], { budgetBytes: 24 * 1024 });
    expect(plan.chunks.map((chunk) => chunk.files.map((item) => item.path))).toEqual([['a', 'b'], ['c']]);
    expect(plan.chunks.map((chunk) => chunk.bytes)).toEqual([20 * 1024, 10 * 1024]);
    expect(plan.warnings).toEqual([]);
  });

  it('单个文件超预算时独占一片并标记', () => {
    const plan = planReviewChunks([file('big', 30), file('small', 1)], { budgetBytes: 24 * 1024 });
    expect(plan.chunks[0].oversized).toBe(true);
    expect(plan.chunks[0].files[0].path).toBe('big');
    expect(plan.chunks[1].files[0].path).toBe('small');
  });

  it('片数超过上限时合并尾部并提示', () => {
    const files = Array.from({ length: 10 }, (_, index) => file(`f${index}`, 10));
    const plan = planReviewChunks(files, { budgetBytes: 10 * 1024, maxChunks: 3 });
    expect(plan.chunks).toHaveLength(3);
    expect(plan.chunks[2].files).toHaveLength(8);
    expect(plan.warnings.join('')).toContain('合并');
  });

  it('per-file 模式：一个文件一片，顺序不变', () => {
    const plan = planReviewChunks([file('a', 1), file('big', 40), file('c', 1)], { perFile: true });
    expect(plan.chunks.map((chunk) => chunk.files.map((item) => item.path))).toEqual([['a'], ['big'], ['c']]);
    expect(plan.chunks[1].oversized).toBe(true);
  });

  it('按模型分组：shared 随组发送（预算内合并），不跨模型混合', () => {
    const files = [
      { ...file('a1', 10), model: 'Tag' },
      { ...file('a2', 10), model: 'Tag' },
      { ...file('b1', 8), model: 'Product' },
      { ...file('shared', 4), model: 'shared' },
    ];
    const plan = planReviewChunks(files, { budgetBytes: 24 * 1024, groupBy: 'model' });
    // shared 装进第一个有空间的模型组（Tag 20KB 剩 4KB → 正好）
    expect(plan.chunks.map((chunk) => chunk.label)).toEqual(['Tag', 'Product']);
    expect(plan.chunks[0].files.map((item) => item.path)).toEqual(['a1', 'a2', 'shared']);
  });

  it('shared 塞不进模型组时单独成组并提示', () => {
    const files = [
      { ...file('a1', 20), model: 'Tag' },
      { ...file('huge', 30), model: 'shared' },
    ];
    const plan = planReviewChunks(files, { budgetBytes: 24 * 1024, groupBy: 'model' });
    expect(plan.chunks.map((chunk) => chunk.label)).toEqual(['Tag', 'shared']);
    expect(plan.warnings.join('')).toContain('未能并入模型组');
  });

  it('模型超过 3 个时不复制 shared，单独成组并提示', () => {
    const files = [
      ...['Tag', 'Product', 'Order', 'User'].map((model) => ({ ...file(`${model}.ts`, 2), model })),
      { ...file('shared', 2), model: 'shared' },
    ];
    const plan = planReviewChunks(files, { budgetBytes: 24 * 1024, groupBy: 'model' });
    expect(plan.chunks.filter((chunk) => chunk.label === 'shared')).toHaveLength(1);
    expect(plan.warnings.join('')).toContain('单独成组');
  });

  it('按模型分组时片数超上限只提示、不跨模型合并', () => {
    const files = ['Tag', 'Product', 'Order', 'User'].map((model) => ({ ...file(`${model.toLowerCase()}.ts`, 10), model }));
    const plan = planReviewChunks(files, { budgetBytes: 1024, maxChunks: 2, groupBy: 'model' });
    expect(plan.chunks).toHaveLength(4);
    expect(plan.warnings.join('')).toContain('不会跨模型合并');
  });

  it('空输入不产生分片', () => {
    expect(planReviewChunks([], {}).chunks).toEqual([]);
  });
});

describe('splitFileContent', () => {
  it('按行切成连续段，段头标注偏移', () => {
    const content = Array.from({ length: 100 }, (_, index) => `line-${index + 1}-${'x'.repeat(40)}`).join('\n');
    const slices = splitFileContent(content, 500);
    expect(slices.length).toBeGreaterThan(1);
    expect(slices[0].fromLine).toBe(1);
    expect(slices[slices.length - 1].toLine).toBe(100);
    // 相邻段首尾相接，不丢行
    for (let index = 1; index < slices.length; index += 1) {
      expect(slices[index].fromLine).toBe(slices[index - 1].toLine + 1);
    }
    expect(slices[1].content.startsWith('// [分片]')).toBe(true);
    expect(slices[1].content).toContain('偏移');
  });

  it('内容小于预算时原样一段', () => {
    const slices = splitFileContent('const a = 1;', 10 * 1024);
    expect(slices).toHaveLength(1);
    expect(slices[0].fromLine).toBe(1);
  });

  it('单行超预算时仍返回一段（不能切半个语句）', () => {
    const slices = splitFileContent('x'.repeat(5000), 1024);
    expect(slices).toHaveLength(1);
    expect(slices[0].totalLines).toBe(1);
  });
});
