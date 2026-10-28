/*
 * @file 审查结论解析/去重单测（FR-17-23）
 * @description 锁死三件事：能从模型常见写法里认出条目、同问题只留一条且严重级取高、
 *   认不出时返回空让调用方回退原文（不能吞结果）。
 * @author donttemo
 * @created 2026-10-27
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { formatFindings, mergeFindings, normalizeTitle, parseFindings } from '../summarize.js';

describe('parseFindings', () => {
  it('解析带位置/建议的条目', () => {
    const findings = parseFindings(
      [
        '[P0] demo-item.controller.ts:22 — 5 个端点均未挂权限装饰器 → 补 @Permissions',
        '- [P1] src/modules/tag/tag.service.ts：31 泛型过滤未白名单 -> 只放行声明字段',
        '**P2** prisma/seed.ts:9 占位符未替换',
      ].join('\n'),
    );
    expect(findings).toHaveLength(3);
    expect(findings[0]).toMatchObject({
      severity: 'P0',
      file: 'demo-item.controller.ts',
      line: 22,
      title: '5 个端点均未挂权限装饰器',
      advice: '补 @Permissions',
    });
    expect(findings[1]).toMatchObject({ file: 'src/modules/tag/tag.service.ts', line: 31, severity: 'P1' });
    expect(findings[2]).toMatchObject({ severity: 'P2', line: 9, title: '占位符未替换' });
  });

  it('没有位置也能解析', () => {
    const findings = parseFindings('[P1] 缺少统一错误处理 → 抽到过滤器');
    expect(findings[0]).toMatchObject({ severity: 'P1', title: '缺少统一错误处理', advice: '抽到过滤器' });
    expect(findings[0].file).toBeUndefined();
  });

  it('普通文本不硬解析成条目', () => {
    expect(parseFindings('整体看起来不错，没有发现明显问题。')).toEqual([]);
  });
});

describe('mergeFindings', () => {
  it('同位置同问题合并，严重级取高、建议去重', () => {
    const a = parseFindings('[P1] a.ts:10 缺少校验 → 补 DTO');
    const b = parseFindings('[P0] a.ts:10 — 缺少校验 → 补 DTO；加 ValidationPipe');
    const result = mergeFindings([a, b]);
    expect(result.findings).toHaveLength(1);
    expect(result.merged).toBe(1);
    expect(result.findings[0].severity).toBe('P0');
    expect(result.findings[0].advice).toContain('补 DTO');
    expect(result.findings[0].advice).toContain('ValidationPipe');
  });

  it('标题互相包含视为同一问题（避免措辞差异导致重复）', () => {
    const a = parseFindings('[P2] a.ts:5 注释仅复述字段名');
    const b = parseFindings('[P2] a.ts:5 注释仅复述字段名，建议删除');
    expect(mergeFindings([a, b]).findings).toHaveLength(1);
  });

  it('全路径与纯文件名视为同一位置（保留更完整路径）', () => {
    const a = parseFindings('[P0] src/modules/tag/tag.controller.ts:27 缺权限装饰器 → 补 @Permissions');
    const b = parseFindings('[P0] tag.controller.ts:27 缺权限装饰器 → 补 @Permissions');
    const result = mergeFindings([a, b]);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].file).toBe('src/modules/tag/tag.controller.ts');
  });

  it('同文件不同行保留为两条', () => {
    const a = parseFindings('[P1] a.ts:3 问题一');
    const b = parseFindings('[P1] a.ts:9 问题二');
    expect(mergeFindings([a, b]).findings).toHaveLength(2);
  });

  it('按严重级、文件、行排序', () => {
    const result = mergeFindings([
      parseFindings(['[P2] b.ts:1 二', '[P0] c.ts:2 零', '[P1] a.ts:3 一'].join('\n')),
    ]);
    expect(result.findings.map((item) => item.severity)).toEqual(['P0', 'P1', 'P2']);
  });
});

describe('formatFindings', () => {
  it('给出计数、合并条数与分组', () => {
    const result = mergeFindings([
      parseFindings(['[P0] a.ts:1 缺权限 → 加装饰器', '[P1] b.ts:2 缺校验'].join('\n')),
    ]);
    const text = formatFindings(result);
    expect(text).toContain('汇总：P0 1 / P1 1 / P2 0');
    expect(text).toContain('- a.ts:1 — 缺权限 → 加装饰器');
  });
});

describe('normalizeTitle', () => {
  it('标点与空白差异归一', () => {
    expect(normalizeTitle('补 DTO。')).toBe(normalizeTitle('补DTO'));
  });
});
