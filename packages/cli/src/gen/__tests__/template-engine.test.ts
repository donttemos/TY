/*
 * @file 模板引擎单测
 * @description 覆盖 {{var}} / {{#if}}-{{else}} / {{#each}}（this / @index）/ \{{ 字面量转义 /
 *   连续空行压缩 / 未闭合标签与数据类型错误（模板语法错误必须抛错，TC-GEN-006 第一道闸）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { renderTemplate } from '../template-engine.js';

describe('renderTemplate', () => {
  it('变量替换与缺失变量为空串', () => {
    expect(renderTemplate('t', 'hello {{name}}!', { name: 'fw' })).toBe('hello fw!');
    expect(renderTemplate('t', '[{{missing}}]', {})).toBe('[]');
  });

  it('点路径取值', () => {
    expect(renderTemplate('t', '{{model.name}}', { model: { name: 'Order' } })).toBe('Order');
  });

  it('#if / #else 真值判断（空串与空数组为假）', () => {
    const tpl = '{{#if flag}}yes{{else}}no{{/if}}';
    expect(renderTemplate('t', tpl, { flag: true })).toBe('yes');
    expect(renderTemplate('t', tpl, { flag: false })).toBe('no');
    expect(renderTemplate('t', tpl, { flag: '' })).toBe('no');
    expect(renderTemplate('t', tpl, { flag: [] })).toBe('no');
    expect(renderTemplate('t', tpl, { flag: ['x'] })).toBe('yes');
  });

  it('#each 遍历数组，作用域内可用 this 与 @index', () => {
    const tpl = '{{#each items}}{{@index}}:{{this.name}};{{/each}}';
    expect(renderTemplate('t', tpl, { items: [{ name: 'a' }, { name: 'b' }] })).toBe('0:a;1:b;');
  });

  it('字面量 {{ 经 \\{{ 转义输出（Vue 模板语法场景）', () => {
    expect(renderTemplate('t', '\\{{ row.name }}', {})).toBe('{{ row.name }}');
  });

  it('压缩 3 个及以上连续空行', () => {
    expect(renderTemplate('t', 'a\n\n\n\nb', {})).toBe('a\n\nb');
  });

  it('未闭合的 #if 抛语法错误', () => {
    expect(() => renderTemplate('bad.tpl', '{{#if x}}oops', { x: true })).toThrow('bad.tpl');
  });

  it('多余的闭合标签抛语法错误', () => {
    expect(() => renderTemplate('bad.tpl', '{{/if}}', {})).toThrow('多余的闭合标签');
  });

  it('#each 的数据不是数组时抛错', () => {
    expect(() => renderTemplate('bad.tpl', '{{#each items}}x{{/each}}', { items: 'nope' })).toThrow('不是数组');
  });

  it('嵌套 if 与 each', () => {
    const tpl = '{{#each rows}}{{#if this.ok}}{{this.name}}{{/if}}{{/each}}';
    expect(renderTemplate('t', tpl, { rows: [{ name: 'a', ok: true }, { name: 'b', ok: false }] })).toBe('a');
  });
});
