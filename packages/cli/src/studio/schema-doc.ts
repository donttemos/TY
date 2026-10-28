/*
 * @file Prisma schema 结构化编辑内核（TY Studio 模型设计器地基）
 * @description 设计器改 schema 的**唯一**写回通道。核心约束（PRD-017 §5）：
 *   ① 文件是唯一权威：每次操作都从磁盘原文重新解析，不做内存缓存；
 *   ② 块级重写：把 schema 切成 model / enum / datasource / generator 等块，只重建被编辑的块，
 *     其余块逐字节原样拼接——未改动模型里的注释、@@index、@relation(onDelete:) 一个字节都不动；
 *   ③ 字段属性保留原始文本（attrs 原样带出），不做归一化：
 *     现网 `gen/schema-parser.ts` 是词法级、面向生成代码的，归一会丢 onDelete / 索引排序等细节，
 *     绝不能拿它往返写回（用了就会毁 schema）；
 *   ④ 守门人是 Prisma：写回前必须过 `prisma validate`，本文件的结构自检只做「早失败」的补充。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { Exec } from '../deploy/exec.js';
import { defaultExec, firstLineOf, pnpmBin } from '../deploy/exec.js';
import { diffText } from '../gen/writer.js';
import { docCommentOf } from '../model-designer/labels.js';

/** 块类型 */
export type BlockKind = 'model' | 'enum' | 'datasource' | 'generator' | 'type' | 'other';

/** schema 中的一个块 */
export interface SchemaBlock {
  kind: BlockKind;
  /** 块名（model/enum/datasource 的名字；other 块为空） */
  name?: string;
  /** 起始行号（0 基，含） */
  startLine: number;
  /** 结束行号（0 基，含） */
  endLine: number;
  /** 原文（含末尾换行的处理见 splitSchema 说明） */
  raw: string;
}

/** 字段（保留原始属性文本） */
export interface FieldDoc {
  name: string;
  /** 类型名（标量 / 枚举名 / 模型名） */
  type: string;
  optional: boolean;
  isList: boolean;
  /** 类型后的属性原始文本，如 `@id @default(uuid()) @db.VarChar(32)` */
  attrs: string;
  /** 字段上方的 `///` 文档注释（作为中文标注展示） */
  comment?: string;
  /**
   * 该字段在 schema 里的原始整行（含缩进）。
   * 序列化时若字段语义未变就原样复用——否则重排对齐会让「只加了一个字段」的 diff
   * 变成整个模型块重写，用户无法信任 diff。
   */
  raw?: string;
}

/** 模型 */
export interface ModelDoc {
  name: string;
  /** 块级属性原始文本（@@index / @@unique / @@map） */
  blockAttrs: string[];
  fields: FieldDoc[];
}

/** Prisma 标量类型（结构自检白名单） */
const SCALAR_TYPES = new Set(['String', 'Int', 'BigInt', 'Float', 'Decimal', 'Boolean', 'DateTime', 'Json', 'Bytes']);

/** 块起始行正则 */
const BLOCK_START = /^\s*(model|enum|datasource|generator|type)\s+([A-Za-z_][\w]*)\s*\{\s*$/;

/**
 * 去掉行尾注释（仅用于花括号计数，不改原文）
 * @param line 单行
 */
function stripLineComment(line: string): string {
  const index = line.indexOf('//');
  return index >= 0 ? line.slice(0, index) : line;
}

/**
 * 切分 schema 为块序列
 * @description 保证 `blocks.map(b => b.raw).join('') === text`（逐字节可逆），
 *   这是块级重写安全性的基础：未编辑的块原样拼回，中间的空行与注释也一并保留。
 * @param text schema 原文
 */
export function splitSchema(text: string): SchemaBlock[] {
  const normalized = text.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const blocks: SchemaBlock[] = [];
  let pending: string[] = [];
  let pendingStart = 0;

  const flushPending = (endLine: number): void => {
    if (pending.length === 0) return;
    blocks.push({ kind: 'other', startLine: pendingStart, endLine, raw: passThrough(pending) });
    pending = [];
  };

  let index = 0;
  while (index < lines.length) {
    const line = lines[index];
    const matched = line.match(BLOCK_START);
    if (!matched) {
      if (pending.length === 0) pendingStart = index;
      pending.push(line);
      index += 1;
      continue;
    }

    flushPending(index - 1);
    const kind = matched[1] as BlockKind;
    const name = matched[2];
    // 花括号计数：从本行开始，直到平衡归零（字符串内的括号极少见，注释部分已剥离）
    let depth = 0;
    let end = index;
    for (let cursor = index; cursor < lines.length; cursor += 1) {
      const stripped = stripLineComment(lines[cursor]);
      for (const char of stripped) {
        if (char === '{') depth += 1;
        if (char === '}') depth -= 1;
      }
      if (depth <= 0 && cursor > index) {
        end = cursor;
        break;
      }
      end = cursor;
    }

    blocks.push({
      kind,
      name,
      startLine: index,
      endLine: end,
      // 块原文不含末尾换行：由 join 时统一补回，保证可逆
      raw: lines.slice(index, end + 1).join('\n'),
    });
    index = end + 1;
  }
  flushPending(lines.length - 1);
  return blocks;
}

/** 把待定行还原为原文片段（保留行边界，供 join 使用） */
function passThrough(lines: string[]): string {
  return lines.join('\n');
}

/**
 * 解析 model 块为结构化文档（属性保留原始文本）
 * @param block model 块
 */
export function parseModel(block: SchemaBlock): ModelDoc {
  if (block.kind !== 'model' || !block.name) {
    throw new Error(`不是 model 块：${block.kind} ${block.name ?? ''}`);
  }
  const lines = block.raw.split('\n');
  const inner = lines.slice(1, -1);
  const fields: FieldDoc[] = [];
  const blockAttrs: string[] = [];

  let pendingComment: string | undefined;
  for (const rawLine of inner) {
    const line = rawLine.trim();
    // `///` 是文档注释：挂到下一个字段上；普通 `//` 仍然忽略
    if (line.startsWith('///')) {
      pendingComment = docCommentOf(rawLine) ?? undefined;
      continue;
    }
    if (line === '' || line.startsWith('//')) continue;
    if (line.startsWith('@@')) {
      blockAttrs.push(line);
      continue;
    }
    // 形如：name Type[[]][?] 后跟属性文本
    const matched = line.match(/^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(\[\])?(\?)?\s*(.*)$/);
    if (!matched) continue;
    fields.push({
      name: matched[1],
      type: matched[2],
      optional: matched[4] === '?',
      isList: matched[3] !== undefined,
      attrs: matched[5].trim(),
      ...(pendingComment === undefined ? {} : { comment: pendingComment }),
      raw: rawLine.replace(/\r$/, ''),
    });
    pendingComment = undefined;
  }
  return { name: block.name, blockAttrs, fields };
}

/**
 * 把结构化模型序列化为 Prisma 文本（二级缩进、类型列对齐，贴近 prisma format 风格）
 * @param model 模型文档
 */
export function serializeModel(model: ModelDoc): string {
  const nameWidth = model.fields.reduce((max, field) => Math.max(max, field.name.length), 0);
  const typeText = (field: FieldDoc): string => `${field.type}${field.isList ? '[]' : ''}${field.optional ? '?' : ''}`;
  const typeWidth = model.fields.reduce((max, field) => Math.max(max, typeText(field).length), 0);

  // 注意：块头行的 `{` 已在下面的模板里，这里不能再补一个（多一层花括号会让后续模型被吞进本块）
  const lines: string[] = [];
  for (const field of model.fields) {
    // 注释行独立输出：即使复用原始行，也要带上（否则改标注会丢注释）
    if (field.comment !== undefined && field.comment !== '') lines.push(`  /// ${field.comment}`);
    // 语义未变的字段直接复用原始行：保证「只加一个字段」的 diff 只有一行，用户才敢信
    if (field.raw !== undefined && sameFieldLine(field)) {
      lines.push(field.raw.trimEnd());
      continue;
    }
    const left = `  ${field.name.padEnd(nameWidth)}`;
    const mid = typeText(field).padEnd(typeWidth);
    const line = field.attrs === '' ? `${left} ${mid}` : `${left} ${mid} ${field.attrs}`;
    lines.push(line.trimEnd());
  }
  if (model.blockAttrs.length > 0) {
    lines.push('');
    for (const attr of model.blockAttrs) lines.push(`  ${attr}`);
  }
  lines.push('}');
  return `model ${model.name} {\n${lines.join('\n')}`;
}

/** 语义比较：名称 / 字段（名、类型、可空、数组、属性原文）/ 块级属性全等 */
function sameModel(a: ModelDoc, b: ModelDoc): boolean {
  if (a.name !== b.name) return false;
  if (a.blockAttrs.join('\n') !== b.blockAttrs.join('\n')) return false;
  if (a.fields.length !== b.fields.length) return false;
  return a.fields.every((field, index) => {
    const other = b.fields[index];
    return (
      field.name === other.name &&
      field.type === other.type &&
      field.optional === other.optional &&
      field.isList === other.isList &&
      field.attrs === other.attrs &&
      (field.comment ?? '') === (other.comment ?? '')
    );
  });
}

/**
 * 判断字段的语义与它的原始行是否一致（一致才能复用原始行）
 * @param field 字段
 */
function sameFieldLine(field: FieldDoc): boolean {
  if (field.raw === undefined) return false;
  const matched = field.raw.trim().match(/^([A-Za-z_][\w]*)\s+([A-Za-z_][\w]*)(\[\])?(\?)?\s*(.*)$/);
  if (!matched) return false;
  return (
    matched[1] === field.name &&
    matched[2] === field.type &&
    (matched[3] !== undefined) === field.isList &&
    (matched[4] === '?') === field.optional &&
    matched[5].trim() === field.attrs
  );
}

/** 模型编辑指令 */
export interface ModelEdit {
  /** 目标模型名（原名） */
  model: string;
  /** 新模型名（重命名时提供） */
  renameTo?: string;
  /** 新字段列表（提供即整体替换字段） */
  fields?: FieldDoc[];
  /** 新块级属性（提供即整体替换） */
  blockAttrs?: string[];
  /** 模型级 `///` 注释（提供即写入/替换；空串表示删除） */
  comment?: string;
  /**
   * 新建模型：为 true 时 `model` 视为**新模型名**，追加到文件末尾。
   * 未设置且目标不存在则报错（避免把拼错的模型名当成新建）。
   */
  create?: boolean;
}

/** 应用编辑的结果 */
export interface ApplyResult {
  /** 新全文 */
  content: string;
  /** 实际被重写的模型名 */
  touched: string[];
}

/**
 * 应用模型编辑（未命中的块逐字节保留）
 * @param text schema 原文
 * @param edits 编辑指令
 */
export function applyModelEdits(text: string, edits: ModelEdit[]): ApplyResult {
  if (edits.length === 0) return { content: text, touched: [] };
  const byModel = new Map(edits.map((edit) => [edit.model, edit]));
  const blocks = splitSchema(text);
  const touched: string[] = [];
  const pieces: string[] = [];
  const lines = text.replace(/\r\n/g, '\n').split('\n');

  /** 取模型块上方紧邻的 `///` 注释（连续，遇空行即止） */
  const precedingComment = (startLine: number): { count: number; text: string } => {
    let cursor = startLine - 1;
    let count = 0;
    let text = '';
    while (cursor >= 0) {
      const doc = docCommentOf(lines[cursor] ?? '');
      if (doc === null) break;
      count += 1;
      text = doc;
      cursor -= 1;
    }
    return { count, text };
  };

  blocks.forEach((block) => {
    if (block.kind !== 'model' || !block.name) {
      pieces.push(block.raw);
      return;
    }
    const edit = byModel.get(block.name);
    if (!edit) {
      pieces.push(block.raw);
      return;
    }
    const current = parseModel(block);
    const next: ModelDoc = {
      name: edit.renameTo ?? current.name,
      fields: edit.fields ?? current.fields,
      blockAttrs: edit.blockAttrs ?? current.blockAttrs,
    };
    const oldComment = precedingComment(block.startLine);
    const commentChanged = edit.comment !== undefined && edit.comment.trim() !== oldComment.text.trim();
    // 语义未变则不重写：序列化风格（类型列对齐）与原文可能有空格差异，
    // 用字符串比较会把「什么都没改」误判成变更、产生无意义 diff 与备份。
    if (sameModel(current, next) && !commentChanged) {
      pieces.push(block.raw);
      return;
    }

    // 注释写在 model 行上方：从上一块尾部摘掉旧注释行，再作为新块前缀写回
    if (commentChanged && oldComment.count > 0) {
      const tail = pieces.pop();
      if (tail !== undefined) {
        const tailLines = tail.split('\n');
        const kept = tailLines.slice(0, Math.max(0, tailLines.length - oldComment.count)).join('\n');
        // 旧注释独占整块时直接丢掉这一块，避免留下空行（否则文件开头会多一个换行）
        if (kept.trim() !== '') pieces.push(kept);
      }
    }
    touched.push(block.name);
    const serialized = serializeModel(next);
    const prefix = commentChanged && edit.comment !== undefined && edit.comment.trim() !== '' ? `/// ${edit.comment.trim()}\n` : '';
    pieces.push(`${prefix}${serialized}`);
  });

  const creates = edits.filter((edit) => edit.create === true);
  const unknown = edits.filter(
    (edit) => edit.create !== true && !blocks.some((block) => block.kind === 'model' && block.name === edit.model),
  );
  if (unknown.length > 0) {
    throw new Error(`schema 中不存在模型：${unknown.map((edit) => edit.model).join('、')}（新建请带 create: true）`);
  }
  const duplicated = creates.filter((edit) => blocks.some((block) => block.kind === 'model' && block.name === edit.model));
  if (duplicated.length > 0) {
    throw new Error(`模型已存在，不能新建：${duplicated.map((edit) => edit.model).join('、')}`);
  }

  // 新建模型统一追加到文件末尾（保留原有块的相对顺序，便于 review）
  for (const edit of creates) {
    if (!edit.fields || edit.fields.length === 0) throw new Error(`新建模型 ${edit.model} 必须至少有一个字段`);
    const prefix = edit.comment !== undefined && edit.comment.trim() !== '' ? `/// ${edit.comment.trim()}\n` : '';
    pieces.push(`${prefix}${serializeModel({ name: edit.model, fields: edit.fields, blockAttrs: edit.blockAttrs ?? [] })}`);
    touched.push(edit.model);
  }

  return { content: pieces.join('\n'), touched };
}

/** 结构自检项 */
export interface SchemaIssue {
  level: 'error' | 'warn';
  message: string;
}

/**
 * 结构自检（早失败，不替代 prisma validate）
 * @param text schema 原文
 */
export function structuralIssues(text: string): SchemaIssue[] {
  const issues: SchemaIssue[] = [];
  const blocks = splitSchema(text);
  const models = blocks.filter((block) => block.kind === 'model' && block.name);
  const enums = blocks.filter((block) => block.kind === 'enum' && block.name);
  const modelNames = new Set(models.map((block) => block.name as string));
  const enumNames = new Set(enums.map((block) => block.name as string));

  const seenModels = new Set<string>();
  for (const block of models) {
    const name = block.name as string;
    if (seenModels.has(name)) issues.push({ level: 'error', message: `模型重复定义：${name}` });
    seenModels.add(name);

    const model = parseModel(block);
    const seenFields = new Set<string>();
    for (const field of model.fields) {
      if (seenFields.has(field.name)) {
        issues.push({ level: 'error', message: `${name}.${field.name} 字段名重复` });
      }
      seenFields.add(field.name);
      if (!SCALAR_TYPES.has(field.type) && !enumNames.has(field.type) && !modelNames.has(field.type)) {
        issues.push({ level: 'error', message: `${name}.${field.name} 的类型 ${field.type} 不存在（既非标量也非已定义的枚举/模型）` });
      }
    }
    if (model.fields.length === 0) issues.push({ level: 'error', message: `${name} 没有任何字段` });
    if (!model.fields.some((field) => /@id\b/.test(field.attrs)) && !model.blockAttrs.some((attr) => attr.startsWith('@@id'))) {
      issues.push({ level: 'warn', message: `${name} 没有主键（@id 或 @@id）` });
    }
  }

  const seenEnums = new Set<string>();
  for (const block of enums) {
    const name = block.name as string;
    if (seenEnums.has(name)) issues.push({ level: 'error', message: `枚举重复定义：${name}` });
    seenEnums.add(name);
    const values = block.raw
      .split('\n')
      .slice(1, -1)
      .map((line) => line.trim())
      .filter((line) => line !== '' && !line.startsWith('//') && !line.startsWith('@@'));
    const seen = new Set<string>();
    for (const value of values) {
      if (seen.has(value)) issues.push({ level: 'error', message: `枚举 ${name} 的值重复：${value}` });
      seen.add(value);
    }
    if (values.length === 0) issues.push({ level: 'error', message: `枚举 ${name} 没有值` });
  }

  return issues;
}

/** prisma validate 结果 */
export interface ValidateResult {
  ok: boolean;
  message: string;
}

/** 校验选项 */
export interface ValidateOptions {
  /** 原 schema 绝对路径（临时校验文件写在同目录，保证 .env 解析一致） */
  schemaFile: string;
  /** 执行器（可注入） */
  exec?: Exec;
}

/**
 * 向上查找 prisma CLI 的 JS 入口
 * @description 直接用 `node <cli>` 执行，绕开 `pnpm exec`：在 schema 所在子目录里
 *   pnpm 解析不到 bin（Windows 表现为「'prisma' 不是内部或外部命令」），
 *   而 `node node_modules/prisma/build/index.js` 与 PATH 无关，跨平台稳定。
 * @param from 起始目录（通常是 schema 所在目录）
 */
function resolvePrismaCli(from: string): string | null {
  let dir = from;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, 'node_modules', 'prisma', 'build', 'index.js');
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * 用 Prisma 官方校验器验证内容（守门人）
 * @description 写到同目录的临时文件再校验：`prisma validate` 会从 schema 同目录读取 `.env`，
 *   写到临时目录会因缺少 DATABASE_URL 而误报。
 * @param content schema 全文
 * @param options 选项
 */
export async function validateSchema(content: string, options: ValidateOptions): Promise<ValidateResult> {
  const exec = options.exec ?? defaultExec;
  const dir = path.dirname(options.schemaFile);
  const tempFile = path.join(dir, `.fw-validate-${process.pid}.prisma`);
  try {
    fs.writeFileSync(tempFile, content, 'utf8');
    const cli = resolvePrismaCli(dir);
    try {
      if (cli) {
        await exec('node', [cli, 'validate', '--schema', tempFile], dir);
      } else {
        // 兜底：找不到本地 CLI 时退回 pnpm（例如全局安装的 prisma）
        await exec(pnpmBin(), ['exec', 'prisma', 'validate', '--schema', tempFile], dir);
      }
      return { ok: true, message: 'prisma validate 通过' };
    } catch (error) {
      return { ok: false, message: `prisma validate 失败：${firstLineOf(error)}` };
    }
  } finally {
    try {
      fs.rmSync(tempFile, { force: true });
    } catch {
      // 临时文件清理失败不影响校验结论
    }
  }
}

/** 写回结果 */
export interface WriteBackResult {
  /** 新全文 */
  content: string;
  /** 被重写的模型 */
  touched: string[];
  /** 备份文件路径（未产生变更时为 null） */
  backupFile: string | null;
  /** 差异文本 */
  diff: string;
}

/**
 * 安全写回：校验 → 备份 → 原子替换
 * @description 任何一步不通过都不落盘。原子替换用「同目录临时文件 + rename」，
 *   避免写一半崩溃留下残缺 schema。
 * @param text 当前磁盘原文
 * @param edits 编辑指令
 * @param options 校验与写回选项
 */
export async function writeBackSchema(
  text: string,
  edits: ModelEdit[],
  options: ValidateOptions & { backupDir: string; skipValidate?: boolean },
): Promise<WriteBackResult> {
  const applied = applyModelEdits(text, edits);
  if (applied.touched.length === 0) {
    return { content: text, touched: [], backupFile: null, diff: '' };
  }

  const issues = structuralIssues(applied.content).filter((issue) => issue.level === 'error');
  if (issues.length > 0) {
    throw new Error(`结构自检未通过：${issues.map((issue) => issue.message).join('；')}`);
  }
  if (!options.skipValidate) {
    const result = await validateSchema(applied.content, options);
    if (!result.ok) throw new Error(result.message);
  }

  fs.mkdirSync(options.backupDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupFile = path.join(options.backupDir, `schema-${stamp}.prisma`);
  fs.writeFileSync(backupFile, text, 'utf8');
  fs.chmodSync?.(backupFile, 0o600);

  const tempFile = `${options.schemaFile}.tmp-${process.pid}`;
  fs.writeFileSync(tempFile, applied.content, 'utf8');
  fs.renameSync(tempFile, options.schemaFile);

  return {
    content: applied.content,
    touched: applied.touched,
    backupFile,
    diff: simpleDiff(text, applied.content),
  };
}

/**
 * 行级差异（预览用，带 1 行上下文）
 * @description 复用 `gen/writer` 的 LCS 实现：早期这里用的是「只裁首尾」的简化 diff，
 *   两处分散修改时会把中间整段都标成删除+新增（看起来像改了一大片），用户无法判断真实改动。
 * @param before 原文本
 * @param after 新文本
 */
export function simpleDiff(before: string, after: string): string {
  return diffText(before, after);
}

