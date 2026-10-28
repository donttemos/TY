/*
 * @file 安全写入单测（TC-GEN-003/004/006）
 * @description 覆盖 dry-run 不落盘、默认跳过已存在文件、--force 覆盖并留 diff、
 *   写入中途失败整体回滚（不留半成品）、git 脏工作区检测（非 git 目录不阻断）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { diffText, isGitDirty, previewPlan, writePlan, type GenIo } from '../writer.js';
import type { PlanFile } from '../render.js';

/** 收集输出的测试 IO */
function makeIo(): { io: GenIo; logs: string[]; errors: string[] } {
  const logs: string[] = [];
  const errors: string[] = [];
  return { io: { log: (m) => logs.push(m), error: (m) => errors.push(m) }, logs, errors };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-gen-writer-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const plan = (files: { path: string; content: string }[]): PlanFile[] =>
  files.map((f) => ({ ...f, kind: 'backend' as const }));

describe('writePlan 覆盖策略', () => {
  it('默认写入新文件', () => {
    const { io, logs } = makeIo();
    const result = writePlan(plan([{ path: 'a/b.ts', content: 'new' }]), { projectRoot: tmpDir, io });
    expect(fs.readFileSync(path.join(tmpDir, 'a/b.ts'), 'utf8')).toBe('new');
    expect(result.written).toEqual(['a/b.ts']);
    expect(logs.join('\n')).toContain('已生成');
  });

  it('已存在文件默认跳过并提示 --force（TC-GEN-003）', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'old', 'utf8');
    const { io, logs } = makeIo();
    const result = writePlan(plan([{ path: 'a.ts', content: 'new' }]), { projectRoot: tmpDir, io });
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('old');
    expect(result.skipped).toEqual(['a.ts']);
    expect(logs.join('\n')).toContain('--force');
  });

  it('--force 覆盖已存在文件', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'old', 'utf8');
    const { io } = makeIo();
    writePlan(plan([{ path: 'a.ts', content: 'new' }]), { projectRoot: tmpDir, force: true, io });
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('new');
  });

  it('写入中途失败时回滚已写文件（TC-GEN-006：不留半成品）', () => {
    // 第一个文件可写；第二个文件的父路径是一个已存在文件 → mkdirSync 必失败
    fs.writeFileSync(path.join(tmpDir, 'blocker'), 'x', 'utf8');
    const { io } = makeIo();
    expect(() =>
      writePlan(plan([{ path: 'ok.ts', content: 'ok' }, { path: 'blocker/child.ts', content: 'boom' }]), {
        projectRoot: tmpDir,
        io,
      }),
    ).toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'ok.ts'))).toBe(false);
  });

  it('rollback 可手动调用并还原覆盖前的原文', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'old', 'utf8');
    const { io } = makeIo();
    const result = writePlan(plan([{ path: 'a.ts', content: 'new' }, { path: 'b.ts', content: 'b' }]), {
      projectRoot: tmpDir,
      force: true,
      io,
    });
    result.rollback();
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('old');
    expect(fs.existsSync(path.join(tmpDir, 'b.ts'))).toBe(false);
  });
});

describe('writePlan 标记块重写（PRD-016 FR-16-02）', () => {
  const patchPlan = (files: { path: string; content: string }[]): PlanFile[] =>
    files.map((f) => ({ ...f, kind: 'backend' as const, mode: 'patch' as const }));

  it('标记块重写不需要 --force，直接落盘', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.module.ts'), 'old-wired', 'utf8');
    const { io, logs } = makeIo();
    const result = writePlan(patchPlan([{ path: 'app.module.ts', content: 'new-wired' }]), {
      projectRoot: tmpDir,
      io,
    });
    expect(fs.readFileSync(path.join(tmpDir, 'app.module.ts'), 'utf8')).toBe('new-wired');
    expect(result.written).toEqual(['app.module.ts']);
    expect(result.skipped).toEqual([]);
    expect(logs.join('\n')).toContain('已接线');
  });

  it('内容相同记为 unchanged，不重复写入（幂等重跑）', () => {
    fs.writeFileSync(path.join(tmpDir, 'seed.ts'), 'same', 'utf8');
    const { io, logs } = makeIo();
    const result = writePlan(patchPlan([{ path: 'seed.ts', content: 'same' }]), { projectRoot: tmpDir, io });
    expect(result.written).toEqual([]);
    expect(result.unchanged).toEqual(['seed.ts']);
    expect(logs.join('\n')).toContain('无变更');
  });

  it('目标文件不存在时直接报错，不静默新建', () => {
    const { io } = makeIo();
    expect(() => writePlan(patchPlan([{ path: 'missing.ts', content: 'x' }]), { projectRoot: tmpDir, io })).toThrow(
      /接线目标不存在.*missing\.ts/,
    );
    expect(fs.existsSync(path.join(tmpDir, 'missing.ts'))).toBe(false);
  });

  it('rollback 还原被改写文件的原文', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.module.ts'), 'original', 'utf8');
    const { io } = makeIo();
    const result = writePlan(patchPlan([{ path: 'app.module.ts', content: 'rewritten' }]), {
      projectRoot: tmpDir,
      io,
    });
    result.rollback();
    expect(fs.readFileSync(path.join(tmpDir, 'app.module.ts'), 'utf8')).toBe('original');
  });

  it('校验失败回滚时，新建与接线一并还原（混合计划）', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.module.ts'), 'original', 'utf8');
    const { io } = makeIo();
    const mixed: PlanFile[] = [
      { path: 'modules/product/product.module.ts', content: 'generated', kind: 'backend' },
      { path: 'app.module.ts', content: 'rewritten', kind: 'backend', mode: 'patch' },
    ];
    const result = writePlan(mixed, { projectRoot: tmpDir, io });
    result.rollback();
    expect(fs.existsSync(path.join(tmpDir, 'modules/product/product.module.ts'))).toBe(false);
    expect(fs.readFileSync(path.join(tmpDir, 'app.module.ts'), 'utf8')).toBe('original');
  });
});

describe('previewPlan dry-run（TC-GEN-004）', () => {
  it('只打印不落盘，新建显示 +，已存在显示 diff', () => {
    fs.writeFileSync(path.join(tmpDir, 'a.ts'), 'old line', 'utf8');
    const { io, logs } = makeIo();
    const text = previewPlan(
      plan([{ path: 'a.ts', content: 'new line' }, { path: 'b.ts', content: 'fresh' }]),
      { projectRoot: tmpDir, dry: true, io },
    );
    expect(text).toContain('dry-run');
    expect(text).toContain('+ b.ts');
    expect(text).toContain('~ a.ts');
    expect(text).toContain('- old line');
    expect(text).toContain('+ new line');
    // 未落盘
    expect(fs.readFileSync(path.join(tmpDir, 'a.ts'), 'utf8')).toBe('old line');
    expect(fs.existsSync(path.join(tmpDir, 'b.ts'))).toBe(false);
    expect(logs.length).toBeGreaterThan(0);
  });

  it('patch 文件标注「标记块重写，无需 --force」且不落盘', () => {
    fs.writeFileSync(path.join(tmpDir, 'app.module.ts'), 'old', 'utf8');
    const { io } = makeIo();
    const text = previewPlan(
      [{ path: 'app.module.ts', content: 'new', kind: 'backend', mode: 'patch' }],
      { projectRoot: tmpDir, dry: true, io },
    );
    expect(text).toContain('标记块重写，无需 --force');
    expect(fs.readFileSync(path.join(tmpDir, 'app.module.ts'), 'utf8')).toBe('old');
  });

  it('patch 目标缺失时在预览中给出明确告警', () => {
    const { io } = makeIo();
    const text = previewPlan([{ path: 'gone.ts', content: 'x', kind: 'backend', mode: 'patch' }], {
      projectRoot: tmpDir,
      dry: true,
      io,
    });
    expect(text).toContain('但文件不存在——生成会失败');
  });

  it('用户改过的产物在预览里被点名（而不是只写「已存在」）', () => {
    fs.writeFileSync(path.join(tmpDir, 'edited.ts'), 'mine', 'utf8');
    const { io } = makeIo();
    const text = previewPlan(plan([{ path: 'edited.ts', content: 'generated' }]), {
      projectRoot: tmpDir,
      dry: true,
      modifiedPaths: new Set(['edited.ts']),
      io,
    });
    expect(text).toContain('你改过这份产物');
    expect(text).toContain('默认跳过');
  });
});

describe('diffText', () => {
  it('相同内容返回空串', () => {
    expect(diffText('a\nb', 'a\nb')).toBe('');
  });

  it('标记新增与删除行', () => {
    const diff = diffText('a\nb\nc', 'a\nx\nc');
    expect(diff).toContain('- b');
    expect(diff).toContain('+ x');
    expect(diff).toContain('  a');
    expect(diff).toContain('  c');
  });
});

describe('isGitDirty', () => {
  it('非 git 目录返回 false（不阻断生成）', async () => {
    await expect(isGitDirty(tmpDir)).resolves.toBe(false);
  });
});
