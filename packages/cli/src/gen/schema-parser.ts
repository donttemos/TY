/*
 * @file Prisma schema 解析器
 * @description 把 prisma/schema.prisma 文本解析为统一的模型元信息（PRD-006 FR-01）：
 *   支持 model / enum / 字段属性（@id @default @unique @updatedAt @relation @map @db.*）、
 *   块级属性（@@index @@unique @@map）与文档注释（/// 与 //）。
 *   只做词法层面解析，不依赖 @prisma/schema-parser 外部包，保证 CLI 零新增依赖。
 *   反向解析（已有数据库表）走 DatabasePort 内省，M8 前明确不支持，遇到时由调用方报错。
 * @author donttemo
 * @created 2026-10-13
 * @module cli/gen
 */

/** 字段级属性（已归一化：去掉 @ 与参数，仅保留语义需要的部分） */
export interface FieldAttributes {
  /** 是否主键（@id 或 @@id 成员） */
  isId: boolean;
  /** @default(...) 的原始参数文本，如 uuid() / now() / "system" / 0 */
  defaultValue?: string;
  /** @unique */
  unique: boolean;
  /** @updatedAt */
  updatedAt: boolean;
  /** @relation(fields: [x], references: [id]) 的关系字段名（外键侧字段） */
  relationFields?: string[];
  /** @map("col") 的列名 */
  map?: string;
  /** @db.VarChar(50) 等原生类型 */
  dbType?: string;
}

/** 解析后的字段 */
export interface ParsedField {
  /** 字段名（schema 中的 camelCase 名） */
  name: string;
  /** 声明的类型（标量名或 enum/model 名） */
  type: string;
  /** 是否可选（?） */
  optional: boolean;
  /** 是否数组（[]） */
  isList: boolean;
  /** 字段属性 */
  attributes: FieldAttributes;
  /** 文档注释（/// 优先，回落 // 行注释） */
  comment?: string;
}

/** 解析后的 model */
export interface ParsedModel {
  /** 模型名（PascalCase） */
  name: string;
  /** 字段列表（按声明顺序） */
  fields: ParsedField[];
  /** @@map 的表名 */
  tableName?: string;
  /** @@index 覆盖的字段名集合 */
  indexedFields: Set<string>;
  /** @@unique 覆盖的字段名集合 */
  uniqueFields: Set<string>;
  /** 模型文档注释 */
  comment?: string;
}

/** 解析后的 enum */
export interface ParsedEnum {
  name: string;
  /** 枚举值（含注释） */
  values: { name: string; comment?: string }[];
}

/** schema 解析结果 */
export interface ParsedSchema {
  models: ParsedModel[];
  enums: ParsedEnum[];
}

/**
 * 解析 prisma schema 文本
 * @param source schema 文件内容
 * @returns 模型与枚举元信息；语法错误时抛出带行号的错误（不猜测、不静默跳过）
 */
export function parsePrismaSchema(source: string): ParsedSchema {
  const models: ParsedModel[] = [];
  const enums: ParsedEnum[] = [];
  const lines = source.split(/\r?\n/);

  let index = 0;
  /** 块声明前的文档注释（/// model 上一行的注释归属该块） */
  let blockDoc: string | undefined;
  while (index < lines.length) {
    const line = lines[index];
    const docMatch = line.match(/^\s*\/\/\/\s?(.*)$/);
    if (docMatch) {
      blockDoc = docMatch[1].trim();
      index += 1;
      continue;
    }
    const blockMatch = line.match(/^\s*(model|enum)\s+(\w+)\s*\{/);
    if (!blockMatch) {
      if (line.trim() !== '' && !line.trim().startsWith('//')) blockDoc = undefined;
      index += 1;
      continue;
    }
    const [, kind, name] = blockMatch;
    // 收集块内行（含文档注释），直到配对右花括号
    const body: { text: string; doc?: string }[] = [];
    let pendingDoc: string | undefined;
    let cursor = index + 1;
    while (cursor < lines.length && !/^\s*\}/.test(lines[cursor])) {
      const raw = lines[cursor];
      const docMatch = raw.match(/^\s*\/\/\/\s?(.*)$/);
      if (docMatch) {
        pendingDoc = docMatch[1].trim();
        cursor += 1;
        continue;
      }
      const commentMatch = raw.match(/^\s*\/\/\s?(.*)$/);
      if (commentMatch && raw.trim().startsWith('//')) {
        // 普通行注释仅在没有 /// 文档时作为回落
        if (pendingDoc === undefined) pendingDoc = commentMatch[1].trim();
        cursor += 1;
        continue;
      }
      if (raw.trim() === '') {
        cursor += 1;
        continue;
      }
      body.push({ text: raw, doc: pendingDoc });
      pendingDoc = undefined;
      cursor += 1;
    }
    if (cursor >= lines.length) {
      throw new Error(`schema 解析失败：${kind} ${name} 缺少闭合花括号（第 ${index + 1} 行起）`);
    }

    if (kind === 'model') {
      models.push(parseModel(name, body, blockDoc));
    } else {
      enums.push(parseEnum(name, body));
    }
    blockDoc = undefined;
    index = cursor + 1;
  }

  return { models, enums };
}

/** 解析 model 块体 */
function parseModel(name: string, body: { text: string; doc?: string }[], blockDoc?: string): ParsedModel {
  const fields: ParsedField[] = [];
  let tableName: string | undefined;
  // 块声明前的 /// 文档优先；否则回落首个字段的文档
  let comment: string | undefined = blockDoc;
  const indexedFields = new Set<string>();
  const uniqueFields = new Set<string>();
  /** @@id([a, b]) 的成员 */
  const idBlockMembers: string[] = [];

  for (const entry of body) {
    const text = entry.text.trim();
    if (text.startsWith('@@')) {
      const attr = parseBlockAttribute(text);
      if (attr.name === 'map') tableName = attr.args[0]?.replace(/^"|"$/g, '');
      if (attr.name === 'index') attr.fields.forEach((f) => indexedFields.add(f));
      if (attr.name === 'unique') attr.fields.forEach((f) => uniqueFields.add(f));
      if (attr.name === 'id') idBlockMembers.push(...attr.fields);
      continue;
    }
    const field = parseField(text, entry.doc);
    if (field) {
      if (!comment && entry.doc && fields.length === 0) comment = entry.doc;
      fields.push(field);
    }
  }

  // @@id([a, b]) 成员同样视为主键
  for (const member of idBlockMembers) {
    const target = fields.find((f) => f.name === member);
    if (target) target.attributes.isId = true;
  }

  return { name, fields, tableName, indexedFields, uniqueFields, comment };
}

/** 解析 enum 块体 */
function parseEnum(name: string, body: { text: string; doc?: string }[]): ParsedEnum {
  const values: { name: string; comment?: string }[] = [];
  for (const entry of body) {
    const text = entry.text.trim();
    if (!text || text.startsWith('@@')) continue;
    values.push({ name: text, comment: entry.doc });
  }
  return { name, values };
}

/** 解析单行字段：name Type? @attr(...) */
function parseField(text: string, doc: string | undefined): ParsedField | null {
  const matched = text.match(/^(\w+)\s+([\w.]+)(\[\])?(\?)?\s*(.*)$/);
  if (!matched) return null;
  const [, name, type, listMark, optionalMark, attrText] = matched;
  return {
    name,
    type,
    optional: optionalMark === '?',
    isList: listMark === '[]',
    attributes: parseFieldAttributes(attrText),
    comment: doc,
  };
}

/** 单个字段级属性（@name 或 @name(...)，参数含嵌套括号时整体保留） */
interface RawAttribute {
  name: string;
  /** 括号内原文（无括号时为空串） */
  args: string;
}

/**
 * 按顶层切分字段属性串（括号配平扫描）
 * 例：`@id @default(uuid()) @relation(fields: [a], references: [b])`
 */
function splitAttributes(attrText: string): RawAttribute[] {
  const out: RawAttribute[] = [];
  const regex = /@(\w+)/g;
  let matched: RegExpExecArray | null;
  while ((matched = regex.exec(attrText)) !== null) {
    const attrName = matched[1];
    const rest = attrText.slice(regex.lastIndex);
    let args = '';
    if (rest.startsWith('(')) {
      let depth = 0;
      let end = 0;
      for (; end < rest.length; end += 1) {
        if (rest[end] === '(') depth += 1;
        else if (rest[end] === ')') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      args = rest.slice(1, end);
      regex.lastIndex += end + 1;
    }
    out.push({ name: attrName, args });
  }
  return out;
}

/** 解析字段级属性串（@id @default(x) @unique ...） */
function parseFieldAttributes(attrText: string): FieldAttributes {
  const attributes: FieldAttributes = { isId: false, unique: false, updatedAt: false };
  if (!attrText.trim()) return attributes;

  for (const attr of splitAttributes(attrText)) {
    const args = attr.args
      .split(',')
      .map((a) => a.trim())
      .filter(Boolean);
    switch (attr.name) {
      case 'id':
        attributes.isId = true;
        break;
      case 'unique':
        attributes.unique = true;
        break;
      case 'updatedAt':
        attributes.updatedAt = true;
        break;
      case 'default':
        // 括号配平后的完整原文：uuid() / now() / "system" / 0 / dbgenerated("...")
        attributes.defaultValue = attr.args.trim();
        break;
      case 'relation': {
        // fields: [authorId]（关系字段即外键侧字段）
        const fieldsMatched = attr.args.match(/fields\s*:\s*\[([^\]]*)\]/);
        if (fieldsMatched) {
          attributes.relationFields = fieldsMatched[1]
            .split(',')
            .map((f) => f.trim())
            .filter(Boolean);
        }
        break;
      }
      case 'map':
        attributes.map = args[0]?.replace(/^"|"$/g, '');
        break;
      default:
        break;
    }
  }
  // @db.VarChar(50) / @db.Text：原生类型单独匹配（类型名后可带括号参数，也可不带）
  const dbMatched = attrText.match(/@db\.(\w+)(?:\(([^)]*)\))?/);
  if (dbMatched) {
    attributes.dbType = dbMatched[2] ? `${dbMatched[1]}(${dbMatched[2]})` : dbMatched[1];
  }
  return attributes;
}

/** 解析块级属性（@@index([a, b], map: "x") / @@map("t") / @@id([a, b])） */
function parseBlockAttribute(text: string): { name: string; fields: string[]; args: string[] } {
  const matched = text.match(/^@@(\w+)\s*(?:\(([\s\S]*)\))?$/);
  if (!matched) return { name: '', fields: [], args: [] };
  const [, name, rawArgs] = matched;
  const args = (rawArgs ?? '').split(',').map((a) => a.trim()).filter(Boolean);
  const fieldsMatched = (rawArgs ?? '').match(/\[([^\]]*)\]/);
  const fields = fieldsMatched
    ? fieldsMatched[1].split(',').map((f) => f.trim().replace(/^"|"$/g, '')).filter(Boolean)
    : [];
  return { name, fields, args };
}
