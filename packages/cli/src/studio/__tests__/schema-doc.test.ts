/*
 * @file schema 结构化编辑内核单测（PRD-017 §5）
 * @description 用仓库真实 schema（含注释 / @@index / @@map / @relation）做验证，锁死三件事：
 *   ① 切分可逆：blocks.join('') 与原文字节相等；
 *   ② 空编辑零变更：不碰任何块时输出与原文件完全一致；
 *   ③ 单点编辑不影响他人：改一个字段后，其余块的文本逐字节不变。
 *   另外覆盖结构自检与 prisma validate 的注入式校验。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyModelEdits,
  parseModel,
  serializeModel,
  simpleDiff,
  splitSchema,
  structuralIssues,
  validateSchema,
  writeBackSchema,
  type FieldDoc,
} from '../schema-doc.js';
import type { Exec } from '../../deploy/exec.js';

/** 从 cwd 向上找仓库根（vitest 的 cwd 是包目录，不是仓库根） */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

/** 仓库真实 schema（含大量注释、索引与关系，是最有说服力的夹具） */
const REAL_SCHEMA = path.join(findRepoRoot(), 'apps', 'example-api', 'prisma', 'schema.prisma');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-studio-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const readReal = (): string => fs.readFileSync(REAL_SCHEMA, 'utf8').replace(/\r\n/g, '\n');

describe('splitSchema 可逆性', () => {
  it('真实 schema 切分后拼接与原文字节相等', () => {
    const text = readReal();
    const blocks = splitSchema(text);
    expect(blocks.map((block) => block.raw).join('\n')).toBe(text);
  });

  it('识别出 model / enum / datasource / generator 四类块（合成分片）', () => {
    const text = [
      'generator client {',
      '  provider = "prisma-client-js"',
      '}',
      'datasource db {',
      '  provider = "sqlite"',
      '  url = "file:./x.db"',
      '}',
      'enum Status {',
      '  ON',
      '}',
      'model M {',
      '  id String @id',
      '}',
    ].join('\n');
    const kinds = new Set(splitSchema(text).map((block) => block.kind));
    expect(kinds.has('model')).toBe(true);
    expect(kinds.has('enum')).toBe(true);
    expect(kinds.has('datasource')).toBe(true);
    expect(kinds.has('generator')).toBe(true);
  });

  it('真实 schema 至少识别出 model / datasource / generator', () => {
    const kinds = new Set(splitSchema(readReal()).map((block) => block.kind));
    expect(kinds.has('model')).toBe(true);
    expect(kinds.has('datasource')).toBe(true);
    expect(kinds.has('generator')).toBe(true);
  });

  it('块边界正确：model 块以 { 开头、以 } 结束', () => {
    const product = splitSchema(readReal()).find((block) => block.kind === 'model');
    expect(product).toBeDefined();
    expect(product?.raw.split('\n')[0]).toMatch(/\{\s*$/);
    expect(product?.raw.trimEnd().endsWith('}')).toBe(true);
  });
});

describe('applyModelEdits 安全性', () => {
  it('空编辑列表：输出与原文件完全一致', () => {
    const text = readReal();
    expect(applyModelEdits(text, []).content).toBe(text);
  });

  it('把字段原样传回（无实际变化）：不产生任何重写', () => {
    const text = readReal();
    const target = splitSchema(text).find((block) => block.kind === 'model' && block.name === 'DemoItem');
    expect(target).toBeDefined();
    const model = parseModel(target!);
    const result = applyModelEdits(text, [{ model: model.name, fields: model.fields }]);
    expect(result.touched).toEqual([]);
  });

  it('改一个模型的字段后，其余块的文本逐字节不变', () => {
    const text = readReal();
    const target = splitSchema(text).find((block) => block.kind === 'model' && block.name === 'DemoItem');
    expect(target).toBeDefined();
    const model = parseModel(target!);
    const fields: FieldDoc[] = [...model.fields, { name: 'extraRemark', type: 'String', optional: true, isList: false, attrs: '' }];

    const result = applyModelEdits(text, [{ model: model.name, fields }]);
    expect(result.touched).toEqual(['DemoItem']);

    // 把目标块剔除后比对：剩余块（含 other 块的空行与注释、顺序）必须逐字节一致
    const stripTarget = (source: string): string =>
      splitSchema(source)
        .filter((block) => !(block.kind === 'model' && block.name === 'DemoItem'))
        .map((block) => block.raw)
        .join('\n');
    expect(stripTarget(result.content)).toBe(stripTarget(text));
    expect(result.content).toContain('extraRemark');
  });

  it('未找到模型时报错并指出名字', () => {
    expect(() => applyModelEdits(readReal(), [{ model: 'NotExist', fields: [] }])).toThrow(/不存在模型：NotExist/);
  });

  it('重命名模型只改块头', () => {
    const text = readReal();
    const result = applyModelEdits(text, [{ model: 'DemoItem', renameTo: 'DemoEntry' }]);
    expect(result.content).toContain('model DemoEntry {');
    expect(result.content).not.toContain('model DemoItem {');
  });
});

describe('parseModel / serializeModel', () => {
  const block = {
    kind: 'model' as const,
    name: 'Product',
    startLine: 0,
    endLine: 3,
    raw: ['model Product {', '  id    String @id', '  price Decimal @default(0)', '', '  @@index([price])', '}'].join('\n'),
  };

  it('属性保留原始文本（不归一化）', () => {
    const model = parseModel(block);
    expect(model.fields[0].attrs).toBe('@id');
    expect(model.fields[1].attrs).toBe('@default(0)');
    expect(model.blockAttrs).toEqual(['@@index([price])']);
  });

  it('序列化后能被重新解析回同样语义', () => {
    const model = parseModel(block);
    const text = serializeModel(model);
    const reparsed = parseModel({ ...block, raw: text });
    expect(reparsed.fields.map((field) => `${field.name}:${field.type}:${field.attrs}`)).toEqual(
      model.fields.map((field) => `${field.name}:${field.type}:${field.attrs}`),
    );
    expect(reparsed.blockAttrs).toEqual(model.blockAttrs);
  });

  it('未改字段复用原始行（diff 最小化，不重排对齐）', () => {
    const text = serializeModel(parseModel(block));
    // 原始行原样保留：不会因为「新增字段」把整个模型块重新对齐
    expect(text).toContain('  id    String @id');
    expect(text).toContain('  price Decimal @default(0)');
  });

  it('新增字段（无原始行）按对齐风格生成', () => {
    const model = parseModel(block);
    const text = serializeModel({
      ...model,
      fields: [...model.fields, { name: 'remark', type: 'String', optional: true, isList: false, attrs: '' }],
    });
    // 新字段缩进正确、类型与其自身对齐；旧行不动
    expect(text).toContain('  remark String?');
    expect(text).toContain('  id    String @id');
  });
});

describe('structuralIssues', () => {
  const schemaOf = (body: string): string => `datasource db {\n  provider = "sqlite"\n  url = "file:./x.db"\n}\n\n${body}`;

  it('字段名重复 / 类型不存在 / 缺主键均被报出', () => {
    const issues = structuralIssues(schemaOf('model A {\n  id String\n  id String\n  weird Foo\n}\n'));
    expect(issues.some((issue) => issue.message.includes('字段名重复'))).toBe(true);
    expect(issues.some((issue) => issue.message.includes('类型 Foo 不存在'))).toBe(true);
    expect(issues.some((issue) => issue.level === 'warn' && issue.message.includes('没有主键'))).toBe(true);
  });

  it('枚举值重复被报出', () => {
    const issues = structuralIssues(schemaOf('enum E {\n  A\n  A\n}\n\nmodel M {\n  id String @id\n}\n'));
    expect(issues.some((issue) => issue.message.includes('枚举 E 的值重复'))).toBe(true);
  });

  it('引用已定义模型与枚举不算错误', () => {
    const issues = structuralIssues(
      schemaOf('enum E {\n  A\n}\n\nmodel B {\n  id String @id\n}\n\nmodel A {\n  id String @id\n  b  B\n  e  E\n}\n'),
    );
    expect(issues.filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('真实 schema 无结构性错误（只有可能的告警）', () => {
    const issues = structuralIssues(readReal()).filter((issue) => issue.level === 'error');
    expect(issues).toEqual([]);
  });
});

describe('validateSchema', () => {
  const okExec: Exec = async () => ({ stdout: '', stderr: '' });
  const failExec: Exec = async () => {
    throw new Error('Error: P1012 some attribute arguments are missing');
  };

  it('通过时返回 ok，并清理临时文件', async () => {
    const schemaFile = path.join(tmpDir, 'schema.prisma');
    let seenArgs: string[] = [];
    const exec: Exec = async (_cmd, args) => {
      seenArgs = args;
      return { stdout: '', stderr: '' };
    };
    const result = await validateSchema('model A { id String @id }', { schemaFile, exec });
    expect(result.ok).toBe(true);
    expect(seenArgs).toContain('validate');
    // 临时文件必须清理
    expect(fs.readdirSync(tmpDir).filter((name) => name.startsWith('.fw-validate-'))).toEqual([]);
  });

  it('失败时返回原因（不抛裸错）', async () => {
    const result = await validateSchema('bad', { schemaFile: path.join(tmpDir, 'schema.prisma'), exec: failExec });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('prisma validate 失败');
    expect(result.message).toContain('P1012');
  });

  it('成功路径同样清理临时文件（无残留）', async () => {
    const result = await validateSchema('model A { id String @id }', {
      schemaFile: path.join(tmpDir, 'schema.prisma'),
      exec: okExec,
    });
    expect(result.ok).toBe(true);
    expect(fs.readdirSync(tmpDir)).toEqual([]);
  });
});

describe('writeBackSchema 安全写回', () => {
  const setup = (): string => {
    const file = path.join(tmpDir, 'schema.prisma');
    fs.writeFileSync(file, readReal(), 'utf8');
    return file;
  };
  const failingExec: Exec = async () => {
    throw new Error('Error: P1012 bad schema');
  };

  it('校验通过才落盘，并留下备份', async () => {
    const file = setup();
    const before = fs.readFileSync(file, 'utf8');
    const model = parseModel(splitSchema(before).find((block) => block.kind === 'model' && block.name === 'DemoItem')!);
    const result = await writeBackSchema(
      before,
      [{ model: model.name, fields: [...model.fields, { name: 'note', type: 'String', optional: true, isList: false, attrs: '' }] }],
      { schemaFile: file, backupDir: path.join(tmpDir, 'backups'), exec: async () => ({ stdout: '', stderr: '' }) },
    );
    expect(result.touched).toEqual(['DemoItem']);
    expect(fs.readFileSync(file, 'utf8')).toContain('note');
    expect(result.backupFile && fs.existsSync(result.backupFile)).toBe(true);
    expect(fs.readFileSync(result.backupFile as string, 'utf8')).toBe(before);
  });

  it('prisma validate 失败时磁盘文件保持原样', async () => {
    const file = setup();
    const before = fs.readFileSync(file, 'utf8');
    const model = parseModel(splitSchema(before).find((block) => block.kind === 'model' && block.name === 'DemoItem')!);
    await expect(
      writeBackSchema(before, [{ model: model.name, fields: model.fields.slice(0, 1) }], {
        schemaFile: file,
        backupDir: path.join(tmpDir, 'backups'),
        exec: failingExec,
      }),
    ).rejects.toThrow(/prisma validate 失败/);
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
  });

  it('结构自检失败时连备份都不做（不产生多余文件）', async () => {
    const file = setup();
    const before = fs.readFileSync(file, 'utf8');
    await expect(
      writeBackSchema(before, [{ model: 'DemoItem', fields: [{ name: 'x', type: 'NotAType', optional: false, isList: false, attrs: '@id' }] }], {
        schemaFile: file,
        backupDir: path.join(tmpDir, 'backups'),
        skipValidate: true,
      }),
    ).rejects.toThrow(/结构自检未通过/);
    expect(fs.existsSync(path.join(tmpDir, 'backups'))).toBe(false);
  });

  it('无实际变更时不写文件、不产生备份', async () => {
    const file = setup();
    const before = fs.readFileSync(file, 'utf8');
    const model = parseModel(splitSchema(before).find((block) => block.kind === 'model' && block.name === 'DemoItem')!);
    const result = await writeBackSchema(before, [{ model: model.name, fields: model.fields }], {
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      skipValidate: true,
    });
    expect(result.touched).toEqual([]);
    expect(result.backupFile).toBeNull();
    expect(fs.existsSync(path.join(tmpDir, 'backups'))).toBe(false);
  });
});

describe('simpleDiff', () => {
  it('相同返回空串', () => {
    expect(simpleDiff('a\nb', 'a\nb')).toBe('');
  });

  it('输出 - / + 行并带一行上下文', () => {
    const diff = simpleDiff('head\na\nb\ntail', 'head\na\nB\ntail');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ B');
    expect(diff).toContain('  a');
  });
});


describe('字段注释（///）', () => {
  const text = `model User {
  /// 用户 ID
  id String @id
  /// 昵称
  name String
}
`;

  it('解析到字段上，并在写回时保留', () => {
    const block = splitSchema(text).find((item) => item.kind === 'model')!;
    const model = parseModel(block);
    expect(model.fields[0].comment).toBe('用户 ID');
    expect(model.fields[1].comment).toBe('昵称');

    const result = applyModelEdits(text, [{ model: 'User', fields: model.fields, blockAttrs: [] }]);
    expect(result.content).toContain('/// 用户 ID');
    expect(result.content).toContain('/// 昵称');
  });

  it('改注释只改注释行，字段行原样保留', () => {
    const block = splitSchema(text).find((item) => item.kind === 'model')!;
    const model = parseModel(block);
    model.fields[1].comment = '名称';
    const result = applyModelEdits(text, [{ model: 'User', fields: model.fields, blockAttrs: [] }]);
    expect(result.content).toContain('/// 名称');
    expect(result.content).not.toContain('/// 昵称');
    expect(result.content).toContain('  id String @id');
  });
});


describe('模型级注释写回', () => {
  it('无注释时插入 ///，有注释时替换，空串删除', () => {
    const base = 'model User {\n  id String @id\n}\n';
    const added = applyModelEdits(base, [{ model: 'User', comment: '用户' }]);
    expect(added.content).toContain('/// 用户\nmodel User {');

    const replaced = applyModelEdits(added.content, [{ model: 'User', comment: '会员' }]);
    expect(replaced.content).toContain('/// 会员');
    expect(replaced.content).not.toContain('/// 用户');

    const removed = applyModelEdits(replaced.content, [{ model: 'User', comment: '' }]);
    expect(removed.content).not.toContain('/// 会员');
    expect(removed.content.startsWith('model User {')).toBe(true);
  });

  it('只改注释时不重排字段', () => {
    const base = '/// 旧\nmodel User {\n  id    String @id\n  name  String\n}\n';
    const result = applyModelEdits(base, [{ model: 'User', comment: '新' }]);
    expect(result.content).toContain('  id    String @id');
    expect(result.content).toContain('  name  String');
  });
});
