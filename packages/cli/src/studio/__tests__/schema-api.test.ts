/*
 * @file schema 编辑接口层单测（PRD-017 FR-17-09/10/11）
 * @description 锁死三件事：风险分级口径（删字段阻断 / 改名需确认 / 新建安全）、
 *   一次性确认令牌的绑定与失效（内容变了令牌就不能用）、以及 apply 在任何一步失败时磁盘不变。
 *   用仓库真实 schema 作为夹具，避免合成 schema 掩盖真实属性。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Exec } from '../../deploy/exec.js';
import {
  applyEdits,
  assessEdits,
  buildRelationEdits,
  ConfirmTokenStore,
  editFingerprint,
  listModels,
  previewEdits,
  SchemaEditError,
} from '../schema-api.js';
import { applyModelEdits, structuralIssues, type FieldDoc, type ModelEdit } from '../schema-doc.js';

/** 从 cwd 向上找仓库根 */
function findRepoRoot(): string {
  let dir = process.cwd();
  for (let depth = 0; depth < 6; depth += 1) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    dir = path.dirname(dir);
  }
  return process.cwd();
}

const REAL_SCHEMA = path.join(findRepoRoot(), 'apps', 'example-api', 'prisma', 'schema.prisma');
const readReal = (): string => fs.readFileSync(REAL_SCHEMA, 'utf8').replace(/\r\n/g, '\n');

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-studio-api-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 取 DemoItem 的字段 */
const demoFields = (text: string): FieldDoc[] =>
  listModels(text).find((model) => model.name === 'DemoItem')?.fields ?? [];

const optionalField: FieldDoc = { name: 'remark', type: 'String', optional: true, isList: false, attrs: '' };

describe('listModels', () => {
  it('真实 schema 能列出模型与字段（属性保留原文）', () => {
    const models = listModels(readReal());
    expect(models.length).toBeGreaterThan(10);
    const demo = models.find((model) => model.name === 'DemoItem');
    expect(demo?.fields.length).toBeGreaterThan(3);
    expect(demo?.fields.some((field) => field.attrs.includes('@id'))).toBe(true);
  });
});

describe('assessEdits 风险分级', () => {
  const text = readReal();

  it('新增可空字段：安全', () => {
    const assessment = assessEdits(text, [{ model: 'DemoItem', fields: [...demoFields(text), optionalField] }]);
    expect(assessment.risk).toBe('safe');
    expect(assessment.findings).toEqual([]);
  });

  it('删除字段：阻断（数据不可逆）', () => {
    // 删掉 title（真实存在的字段；用名字过滤更直观，避免依赖字段顺序）
    const fields = demoFields(text).filter((field) => field.name !== 'title');
    expect(fields.length).toBe(demoFields(text).length - 1);
    const assessment = assessEdits(text, [{ model: 'DemoItem', fields }]);
    expect(assessment.risk).toBe('blocked');
    expect(assessment.findings.some((finding) => finding.reason.includes('删除字段'))).toBe(true);
  });

  it('新增必填无默认值字段：阻断（存量行无法满足）', () => {
    const assessment = assessEdits(text, [
      { model: 'DemoItem', fields: [...demoFields(text), { name: 'code', type: 'String', optional: false, isList: false, attrs: '' }] },
    ]);
    expect(assessment.risk).toBe('blocked');
    expect(assessment.findings.some((finding) => finding.reason.includes('无默认值'))).toBe(true);
  });

  it('新增必填但有默认值：安全', () => {
    const assessment = assessEdits(text, [
      {
        model: 'DemoItem',
        fields: [...demoFields(text), { name: 'qty', type: 'Int', optional: false, isList: false, attrs: '@default(0)' }],
      },
    ]);
    expect(assessment.risk).toBe('safe');
  });

  it('重命名模型：需确认（生成物会失配）', () => {
    const assessment = assessEdits(text, [{ model: 'DemoItem', renameTo: 'DemoEntry' }]);
    expect(assessment.risk).toBe('confirm');
    expect(assessment.findings[0].reason).toContain('重命名');
  });

  it('改字段类型 / 改必填：需确认', () => {
    const fields = demoFields(text).map((field) =>
      field.name === 'title' ? { ...field, type: 'Int' } : field,
    );
    expect(assessEdits(text, [{ model: 'DemoItem', fields }]).risk).toBe('confirm');

    const optionalOne = { name: 'memo', type: 'String', optional: true, isList: false, attrs: '' };
    const withOptional = [...demoFields(text), optionalOne];
    const withRequired = withOptional.map((field) => (field.name === 'memo' ? { ...field, optional: false } : field));
    const textWithOptional = applyPreviewText(text, [{ model: 'DemoItem', fields: withOptional }]);
    expect(assessEdits(textWithOptional, [{ model: 'DemoItem', fields: withRequired }]).risk).toBe('confirm');
  });

  it('新建模型：安全（没有存量数据）', () => {
    const assessment = assessEdits(text, [
      { model: 'Product', create: true, fields: [{ name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' }] },
    ]);
    expect(assessment.risk).toBe('safe');
  });

  it('目标模型不存在且未标记 create：阻断（防止拼错模型名被当成新建）', () => {
    const assessment = assessEdits(text, [{ model: 'DemoItemX', fields: [] }]);
    expect(assessment.risk).toBe('blocked');
    expect(assessment.findings[0].reason).toContain('不存在');
  });
});

/** 借助 preview 得到「应用后」的文本（测试构造用） */
function applyPreviewText(text: string, edits: ModelEdit[]): string {
  return previewEdits(text, edits, new ConfirmTokenStore()).content;
}

describe('ConfirmTokenStore', () => {
  it('一次性：消费成功后再用即失效', () => {
    const store = new ConfirmTokenStore();
    const token = store.issue('fp');
    expect(store.consume(token, 'fp')).toBe(true);
    expect(store.consume(token, 'fp')).toBe(false);
  });

  it('指纹不匹配时拒绝（内容变了就不能沿用旧确认）', () => {
    const store = new ConfirmTokenStore();
    const token = store.issue('fp-a');
    expect(store.consume(token, 'fp-b')).toBe(false);
  });

  it('过期后拒绝', () => {
    let now = 1000;
    const store = new ConfirmTokenStore(60_000, () => now);
    const token = store.issue('fp');
    now += 61_000;
    expect(store.consume(token, 'fp')).toBe(false);
  });
});

describe('previewEdits', () => {
  const text = readReal();
  const store = new ConfirmTokenStore();

  it('安全变更不签发令牌，并给出 diff 与新全文', () => {
    const preview = previewEdits(text, [{ model: 'DemoItem', fields: [...demoFields(text), optionalField] }], store);
    expect(preview.assessment.risk).toBe('safe');
    expect(preview.confirmToken).toBeUndefined();
    expect(preview.diff).toContain('+   remark');
    expect(preview.touched).toEqual(['DemoItem']);
    expect(store.size()).toBe(0);
  });

  it('风险变更签发令牌', () => {
    const preview = previewEdits(text, [{ model: 'DemoItem', fields: demoFields(text).slice(0, 2) }], store);
    expect(preview.assessment.risk).toBe('blocked');
    expect(typeof preview.confirmToken).toBe('string');
    expect(store.size()).toBe(1);
  });

  it('空编辑与非法模型抛 invalid-edits', () => {
    expect(() => previewEdits(text, [], store)).toThrow(SchemaEditError);
    expect(() => previewEdits(text, [{ model: 'Nope', fields: [] }], store)).toThrow(SchemaEditError);
  });
});

describe('applyEdits', () => {
  const setup = (): { file: string; text: string } => {
    const file = path.join(tmpDir, 'schema.prisma');
    const text = readReal();
    fs.writeFileSync(file, text, 'utf8');
    return { file, text };
  };
  const skipExec: Exec = async () => ({ stdout: '', stderr: '' });

  it('安全变更无需令牌，写盘并留备份', async () => {
    const { file, text } = setup();
    const store = new ConfirmTokenStore();
    const outcome = await applyEdits({
      text,
      edits: [{ model: 'DemoItem', fields: [...demoFields(text), optionalField] }],
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      store,
      skipValidate: true,
      exec: skipExec,
    });
    expect(outcome.risk).toBe('safe');
    expect(outcome.touched).toEqual(['DemoItem']);
    expect(fs.readFileSync(file, 'utf8')).toContain('remark');
    expect(outcome.backupFile && fs.existsSync(outcome.backupFile)).toBe(true);
  });

  it('风险变更无令牌：拒绝且磁盘不变（409 语义）', async () => {
    const { file, text } = setup();
    const store = new ConfirmTokenStore();
    const error = await applyEdits({
      text,
      edits: [{ model: 'DemoItem', fields: demoFields(text).slice(0, 2) }],
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      store,
      skipValidate: true,
      exec: skipExec,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaEditError);
    expect((error as SchemaEditError).code).toBe('confirm-required');
    expect(fs.readFileSync(file, 'utf8')).toBe(text);
  });

  it('带预览签发的令牌：允许执行', async () => {
    const { file, text } = setup();
    const store = new ConfirmTokenStore();
    const edits: ModelEdit[] = [{ model: 'DemoItem', fields: demoFields(text).slice(0, 2) }];
    const preview = previewEdits(text, edits, store);
    const outcome = await applyEdits({
      text,
      edits,
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      confirmToken: preview.confirmToken,
      store,
      skipValidate: true,
      exec: skipExec,
    });
    expect(outcome.risk).toBe('blocked');
    // 断言真实结果：DemoItem 只剩前两个字段（用解析而非字符串匹配，避免格式差异误判）
    const after = listModels(fs.readFileSync(file, 'utf8')).find((model) => model.name === 'DemoItem');
    expect(after?.fields.map((field) => field.name)).toEqual(['id', 'title']);
  });

  it('预览之后 schema 被改过：令牌失效（防止照着 A 预览写到 B）', async () => {
    const { file, text } = setup();
    const store = new ConfirmTokenStore();
    const edits: ModelEdit[] = [{ model: 'DemoItem', fields: demoFields(text).slice(0, 2) }];
    const preview = previewEdits(text, edits, store);

    const changed = `${text}\n// 别人刚改过\n`;
    fs.writeFileSync(file, changed, 'utf8');
    const error = await applyEdits({
      text: changed,
      edits,
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      confirmToken: preview.confirmToken,
      store,
      skipValidate: true,
      exec: skipExec,
    }).catch((caught: unknown) => caught);
    expect((error as SchemaEditError).code).toBe('invalid-token');
    expect(fs.readFileSync(file, 'utf8')).toBe(changed);
  });

  it('令牌不可重放（第二次应用同一令牌被拒）', async () => {
    const { file, text } = setup();
    const store = new ConfirmTokenStore();
    const edits: ModelEdit[] = [{ model: 'DemoItem', fields: demoFields(text).slice(0, 2) }];
    const preview = previewEdits(text, edits, store);
    await applyEdits({
      text,
      edits,
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      confirmToken: preview.confirmToken,
      store,
      skipValidate: true,
      exec: skipExec,
    });
    // 用同一份原文再发一次（模拟重放）：令牌已被消费，必须拒绝
    const error = await applyEdits({
      text,
      edits,
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      confirmToken: preview.confirmToken,
      store,
      skipValidate: true,
      exec: skipExec,
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(SchemaEditError);
  });

  it('新建模型可写入（create: true）', async () => {
    const { file, text } = setup();
    const store = new ConfirmTokenStore();
    const outcome = await applyEdits({
      text,
      edits: [
        {
          model: 'Product',
          create: true,
          fields: [
            { name: 'id', type: 'String', optional: false, isList: false, attrs: '@id' },
            { name: 'name', type: 'String', optional: false, isList: false, attrs: '' },
          ],
        },
      ],
      schemaFile: file,
      backupDir: path.join(tmpDir, 'backups'),
      store,
      skipValidate: true,
      exec: skipExec,
    });
    expect(outcome.touched).toEqual(['Product']);
    expect(fs.readFileSync(file, 'utf8')).toContain('model Product {');
  });
});

describe('editFingerprint', () => {
  it('内容或编辑变化都会改变指纹', () => {
    const a = editFingerprint('x', [{ model: 'A' }]);
    expect(editFingerprint('x', [{ model: 'A' }])).toBe(a);
    expect(editFingerprint('y', [{ model: 'A' }])).not.toBe(a);
    expect(editFingerprint('x', [{ model: 'B' }])).not.toBe(a);
  });
});

describe('buildRelationEdits 关系生成', () => {
  const schema = [
    'model Category {',
    '  id   String @id',
    '  name String',
    '}',
    '',
    'model Product {',
    '  id    String @id',
    '  title String',
    '}',
    '',
  ].join('\n');

  it('两端同时生成：子端外键 + 关系字段，父端反向数组', () => {
    const edits = buildRelationEdits(schema, { from: 'Product', to: 'Category' });
    expect(edits).toHaveLength(2);

    const product = edits.find((edit) => edit.model === 'Product');
    const names = (product?.fields ?? []).map((field) => field.name);
    expect(names).toContain('categoryId');
    expect(names).toContain('category');
    const relation = product?.fields.find((field) => field.name === 'category');
    expect(relation?.type).toBe('Category');
    expect(relation?.attrs).toBe('@relation(fields: [categoryId], references: [id])');

    const category = edits.find((edit) => edit.model === 'Category');
    const back = category?.fields.find((field) => field.name === 'products');
    expect(back?.type).toBe('Product');
    expect(back?.isList).toBe(true);
    expect(back?.optional).toBe(false);
  });

  it('默认可空；required=true 时两端都非空', () => {
    const optionalEdits = buildRelationEdits(schema, { from: 'Product', to: 'Category' });
    const optionalFk = optionalEdits[0].fields?.find((field) => field.name === 'categoryId');
    expect(optionalFk?.optional).toBe(true);

    const requiredEdits = buildRelationEdits(schema, { from: 'Product', to: 'Category', required: true });
    const requiredFk = requiredEdits[0].fields?.find((field) => field.name === 'categoryId');
    expect(requiredFk?.optional).toBe(false);
  });

  it('支持自定义外键名与关系字段名', () => {
    const edits = buildRelationEdits(schema, { from: 'Product', to: 'Category', fkName: 'catId', fieldName: 'cat' });
    const product = edits.find((edit) => edit.model === 'Product');
    expect(product?.fields.some((field) => field.name === 'catId')).toBe(true);
    expect(product?.fields.find((field) => field.name === 'cat')?.attrs).toContain('fields: [catId]');
  });

  it('生成结果可写入且结构自检无错误', () => {
    const edits = buildRelationEdits(schema, { from: 'Product', to: 'Category' });
    const content = applyModelEdits(schema, edits).content;
    expect(content).toContain('@relation(fields: [categoryId], references: [id])');
    expect(content).toContain('products Product[]');
    // 列表字段不能带 ?（Prisma 会判非法）：确保没有生成 `Product[]?`
    expect(content).not.toContain('[]?');
    expect(structuralIssues(content).filter((issue) => issue.level === 'error')).toEqual([]);
  });

  it('自关联 / 模型不存在 / 重复字段都明确拒绝', () => {
    expect(() => buildRelationEdits(schema, { from: 'Product', to: 'Product' })).toThrow(/自关联/);
    expect(() => buildRelationEdits(schema, { from: 'Product', to: 'Nope' })).toThrow(/模型不存在/);

    const applied = applyModelEdits(schema, buildRelationEdits(schema, { from: 'Product', to: 'Category' })).content;
    expect(() => buildRelationEdits(applied, { from: 'Product', to: 'Category' })).toThrow(/已存在反向字段|已存在字段/);
  });
});


describe('listModels 中文标注', () => {
  it('注释优先，缺失时按命名推断', () => {
    const text = `/// 用户
model User {
  /// 昵称
  name String
  createdAt DateTime
}
`;
    const models = listModels(text);
    expect(models[0].label).toBe('用户');
    expect(models[0].labelSource).toBe('comment');
    expect(models[0].fields[0].label).toBe('昵称');
    expect(models[0].fields[1].label).toBe('创建时间');
    expect(models[0].fields[1].labelSource).toBe('suggested');
  });

  it('认不出的模型给空标注而不是乱译', () => {
    const models = listModels('model Xyzzy {\n  id String @id\n}\n');
    expect(models[0].label).toBe('');
    expect(models[0].labelSource).toBe('none');
  });
});
