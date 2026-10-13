/*
 * @file 轻量模板引擎
 * @description PRD-006 FR-06：模板存放于 templates/codegen/，项目可覆盖同名模板。
 *   自研 mustache 子集（零依赖，避免 CLI 引入 ejs/handlebars 运行时）：
 *   支持 {{var}}（原样输出，代码生成不做 HTML 转义）、{{#if x}}...{{else}}...{{/if}}、
 *   {{#each list}}...{{/each}}（作用域内 {{this}} / {{this.prop}} / {{@index}}）。
 *   渲染后压缩 3 个及以上连续空行为 2 个，避免模板标签留下空行。
 *   模板语法错误（未闭合、未知块）立即抛出，绝不产出半成品内容（TC-GEN-006 第一道闸）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli/gen
 */

/** 模板数据（变量 → 值；each 作用域内可用 this / @index） */
export type TemplateData = Record<string, unknown>;

/** 语法错误（携带模板名便于定位） */
export class TemplateSyntaxError extends Error {
  constructor(
    message: string,
    readonly templateName: string,
  ) {
    super(`模板 ${templateName} 语法错误：${message}`);
    this.name = 'TemplateSyntaxError';
  }
}

/** 字面量 {{ 的转义哨兵（Vue 模板自身语法需要输出 {{ }} 时，模板里写 \{{） */
const ESCAPE_SENTINEL = '\u0000';

/**
 * 渲染模板
 * @param templateName 模板名（仅用于错误定位）
 * @param template 模板文本（\{{ 表示字面量 {{，供 Vue 模板语法使用）
 * @param data 变量数据
 * @returns 渲染结果（已压缩连续空行）
 */
export function renderTemplate(templateName: string, template: string, data: TemplateData): string {
  const escaped = template.replace(/\\\{\{/g, ESCAPE_SENTINEL);
  const tokens = tokenize(templateName, escaped);
  const output = renderTokens(templateName, tokens, data);
  // 压缩 3+ 连续空行为 2（模板控制标签常独占一行，留下空行）
  return output
    .split(ESCAPE_SENTINEL)
    .join('{{')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\n+$/, '\n');
}

/** 词法单元 */
type Token =
  | { kind: 'text'; value: string }
  | { kind: 'var'; path: string }
  | { kind: 'if'; path: string; body: Token[]; elseBody: Token[] }
  | { kind: 'each'; path: string; body: Token[] };

/** 切分模板为单元序列（递归处理块） */
function tokenize(templateName: string, template: string): Token[] {
  const tokens: Token[] = [];
  const regex = /\{\{(\#?\/?(?:if|each|else)|[^}]+)\}\}/g;
  let cursor = 0;
  let matched: RegExpExecArray | null;

  while ((matched = regex.exec(template)) !== null) {
    if (matched.index > cursor) {
      tokens.push({ kind: 'text', value: template.slice(cursor, matched.index) });
    }
    const inner = matched[1].trim();
    if (inner.startsWith('#if ')) {
      const { body, elseBody, end } = readBlock(templateName, template, regex.lastIndex, 'if', inner.slice(4).trim());
      tokens.push({ kind: 'if', path: inner.slice(4).trim(), body, elseBody });
      regex.lastIndex = end;
    } else if (inner.startsWith('#each ')) {
      const { body, end } = readBlock(templateName, template, regex.lastIndex, 'each', inner.slice(6).trim());
      tokens.push({ kind: 'each', path: inner.slice(6).trim(), body });
      regex.lastIndex = end;
    } else if (inner === 'else') {
      throw new TemplateSyntaxError('{{else}} 必须位于 {{#if}} 块内', templateName);
    } else if (inner.startsWith('/if') || inner.startsWith('/each')) {
      throw new TemplateSyntaxError(`多余的闭合标签 {{${inner}}}`, templateName);
    } else {
      tokens.push({ kind: 'var', path: inner });
    }
    cursor = regex.lastIndex;
  }
  if (cursor < template.length) {
    tokens.push({ kind: 'text', value: template.slice(cursor) });
  }
  return tokens;
}

/**
 * 读取块内容直到配对闭合标签
 * @returns body / elseBody（仅 if）/ 闭合标签后的偏移
 */
function readBlock(
  templateName: string,
  template: string,
  from: number,
  block: 'if' | 'each',
  path: string,
): { body: Token[]; elseBody: Token[]; end: number } {
  const closeTag = block === 'if' ? '/if' : '/each';
  const openTag = block === 'if' ? '#if ' : '#each ';
  let depth = 1;
  let cursor = from;
  let elseAt = -1;

  while (cursor < template.length) {
    const open = template.indexOf(`{{${openTag}`, cursor);
    const close = template.indexOf(`{{${closeTag}}}`, cursor);
    const elseTag = block === 'if' ? template.indexOf('{{else}}', cursor) : -1;
    if (close === -1) {
      throw new TemplateSyntaxError(`{{#${block} ${path}}} 缺少闭合标签 {{${closeTag}}}`, templateName);
    }
    if (open !== -1 && open < close) {
      depth += 1;
      cursor = open + openTag.length + 2;
      continue;
    }
    if (block === 'if' && elseTag !== -1 && elseTag < close) {
      if (depth === 1 && elseAt === -1) elseAt = elseTag;
      cursor = elseTag + '{{else}}'.length;
      continue;
    }
    depth -= 1;
    if (depth === 0) {
      const bodyText = template.slice(from, elseAt === -1 ? close : elseAt);
      const elseText = elseAt === -1 ? '' : template.slice(elseAt + '{{else}}'.length, close);
      return {
        body: tokenize(templateName, bodyText),
        elseBody: tokenize(templateName, elseText),
        // 闭合标签全长 = '{{' + closeTag + '}}'
        end: close + closeTag.length + 4,
      };
    }
    cursor = close + closeTag.length + 4;
  }
  throw new TemplateSyntaxError(`{{#${block} ${path}}} 缺少闭合标签 {{${closeTag}}}`, templateName);
}

/** 渲染单元序列 */
function renderTokens(templateName: string, tokens: Token[], data: TemplateData): string {
  let output = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        output += token.value;
        break;
      case 'var':
        output += stringify(lookup(templateName, data, token.path));
        break;
      case 'if':
        output += renderTokens(templateName, truthy(lookup(templateName, data, token.path)) ? token.body : token.elseBody, data);
        break;
      case 'each': {
        const list = lookup(templateName, data, token.path);
        if (!Array.isArray(list)) {
          throw new TemplateSyntaxError(`{{#each ${token.path}}} 的数据不是数组（实际：${typeof list}）`, templateName);
        }
        list.forEach((item, index) => {
          const scope: TemplateData = { ...data, this: item, '@index': index };
          output += renderTokens(templateName, token.body, scope);
        });
        break;
      }
    }
  }
  return output;
}

/** 按点路径取值（this 指代 each 当前项） */
function lookup(templateName: string, data: TemplateData, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = data;
  for (const part of parts) {
    if (current === null || current === undefined) return undefined;
    if (typeof current !== 'object') {
      throw new TemplateSyntaxError(`变量 ${path} 的中间段 ${part} 不是对象`, templateName);
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** 真值判断：undefined / null / false / 空数组 / 空字符串为假 */
function truthy(value: unknown): boolean {
  if (value === undefined || value === null || value === false) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (typeof value === 'string') return value.length > 0;
  return true;
}

/** 值转字符串：对象/数组走 JSON，标量直出，undefined/null 为空串 */
function stringify(value: unknown): string {
  if (value === undefined || value === null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}
