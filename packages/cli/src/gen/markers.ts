/*
 * @file 生成接线标记块（PRD-016 FR-16-02）
 * @description 框架文件里由生成器托管的区域用成对标记圈定，生成器按清单**整块重写**：
 *   - 标记成对出现，缺失 / 重复 / 顺序颠倒一律抛 GenMarkerError，绝不猜测位置（避免把用户代码改坏）；
 *   - 重写是幂等的：相同 body 重跑产出完全相同的文本，不产生重复片段（对比 PRD-006 的文本增量插入方案）；
 *   - 只认整行标记（允许前后缩进），不做跨行正则匹配，降低误伤概率。
 *   标记本身是项目脚手架的一部分：由 fw new 模板与仓库内既有应用预先写入，生成器只负责重写块内内容。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/gen
 * @since v0.8.0
 */

/** 标记块所在文件的用途标识 */
export interface GenBlock {
  /** 块 id（决定标记文本） */
  id: string;
  /** 人类可读用途（报错时用） */
  purpose: string;
}

/** 生成器托管的全部标记块（框架约定，改名即破坏兼容） */
export const GEN_BLOCKS = {
  /** app.module.ts 顶部 import 语句 */
  IMPORTS: { id: 'imports', purpose: '模块 import 语句' },
  /** app.module.ts 的 @Module({ imports: [...] }) 数组项 */
  MODULES: { id: 'modules', purpose: '模块注册项' },
  /** prisma/seed.ts 顶部 import 语句 */
  SEED_IMPORTS: { id: 'seed-imports', purpose: '种子 import 语句' },
  /** prisma/seed.ts 的种子调用 */
  SEED_CALLS: { id: 'seed-calls', purpose: '种子函数调用' },
  /** prisma/seed.ts 的生成器权限码清单 */
  PERM_CODES: { id: 'perm-codes', purpose: '生成器权限码' },
} as const;

/** 标记块结构异常（缺失 / 重复 / 顺序错乱） */
export class GenMarkerError extends Error {
  /**
   * @param message 面向用户的说明（含文件路径与修复提示）
   */
  constructor(message: string) {
    super(message);
    this.name = 'GenMarkerError';
  }
}

/** 起始标记文本 */
export function beginMarker(id: string): string {
  return `// <fw:gen:${id}>`;
}

/** 结束标记文本 */
export function endMarker(id: string): string {
  return `// </fw:gen:${id}>`;
}

/** 判断文本是否含有指定标记块 */
export function hasBlock(source: string, id: string): boolean {
  const begin = beginMarker(id);
  const end = endMarker(id);
  const lines = source.split('\n');
  return lines.some((line) => line.trim() === begin) && lines.some((line) => line.trim() === end);
}

/** 标记对定位结果 */
interface BlockRange {
  /** 起始标记行下标 */
  begin: number;
  /** 结束标记行下标 */
  end: number;
}

/**
 * 定位标记对（严格校验唯一性与顺序）
 * @param lines 文件行
 * @param id 块 id
 * @param file 文件路径（仅用于报错）
 */
function locateBlock(lines: string[], id: string, file: string): BlockRange {
  const begin = beginMarker(id);
  const end = endMarker(id);
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed === begin) begins.push(index);
    if (trimmed === end) ends.push(index);
  });

  if (begins.length === 0 || ends.length === 0) {
    throw new GenMarkerError(
      `${file} 缺少生成器标记块 ${begin} … ${end}：该文件未被生成器接管。` +
        `请在需要托管的位置补上这对标记后重试（标记块内不要手写业务代码，生成器会整块重写）。`,
    );
  }
  if (begins.length > 1 || ends.length > 1) {
    throw new GenMarkerError(
      `${file} 中标记块 ${id} 重复出现（起始 ${begins.length} 处 / 结束 ${ends.length} 处）：请只保留一对。`,
    );
  }
  if (begins[0] > ends[0]) {
    throw new GenMarkerError(`${file} 中标记块 ${id} 的结束标记出现在起始标记之前，请修正顺序。`);
  }
  return { begin: begins[0], end: ends[0] };
}

/**
 * 读取标记块内的当前内容（用于门禁比对与幂等判定）
 * @param source 文件全文
 * @param id 块 id
 * @param file 文件路径（仅用于报错）
 * @returns 块内正文（不含标记行，未做缩进归一）
 */
export function readBlock(source: string, id: string, file = '<unknown>'): string {
  const lines = source.split('\n');
  const range = locateBlock(lines, id, file);
  return lines.slice(range.begin + 1, range.end).join('\n');
}

/** 重写选项 */
export interface ReplaceBlockOptions {
  /** 正文缩进（如数组项需要 4 空格）；空行不加缩进 */
  indent?: string;
  /** 文件路径（仅用于报错） */
  file?: string;
}

/**
 * 用 body 整块重写指定标记块（幂等）
 * @param source 文件全文
 * @param id 块 id
 * @param body 块内新正文（多行用 \n；空串表示清空块内内容）
 * @param options 缩进与报错路径
 * @returns 重写后的全文
 */
export function replaceBlock(source: string, id: string, body: string, options: ReplaceBlockOptions = {}): string {
  const file = options.file ?? '<unknown>';
  // 只有显式传 indent 时才归一化缩进；否则正文按调用方给的样子原样写入（避免静默吃掉缩进）
  const applyIndent = options.indent !== undefined;
  const indent = options.indent ?? '';
  // 统一换行并去掉尾随空行，避免重跑时因为尾随换行漂移产生 diff
  const bodyLines = body
    .replace(/\r\n/g, '\n')
    .split('\n')
    .filter((line, index, all) => !(index >= all.length - 1 && line.trim() === ''))
    .map((line) => {
      if (line.trim() === '') return '';
      return applyIndent ? `${indent}${line.trimStart()}` : line;
    });

  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const range = locateBlock(lines, id, file);
  const next = [...lines.slice(0, range.begin + 1), ...bodyLines, ...lines.slice(range.end)];
  // 空块时避免留下「起始标记 + 空行 + 结束标记」的多余空行
  const compact = next.filter((line, index) => {
    if (line.trim() !== '') return true;
    const prev = next[index - 1];
    const isBegin = prev !== undefined && prev.trim() === beginMarker(id);
    const nextLine = next[index + 1];
    const isEnd = nextLine !== undefined && nextLine.trim() === endMarker(id);
    return !(isBegin && isEnd);
  });
  return compact.join('\n');
}

/**
 * 生成带标记的空块（供模板与既有应用一次性接入）
 * @param id 块 id
 * @param indent 缩进
 */
export function emptyBlock(id: string, indent = ''): string {
  return `${indent}${beginMarker(id)}\n${indent}${endMarker(id)}`;
}
