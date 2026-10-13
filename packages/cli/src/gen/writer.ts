/*
 * @file 安全写入（dry-run / diff / 覆盖策略 / 回滚）
 * @description PRD-006 FR-07/08 + TC-GEN-003/004/006：
 *   - 默认不覆盖已存在文件，仅提示 --force；--dry 只打印文件清单与 diff，不落盘；
 *   - 写入采用「先写后验」：writePlan 落盘并返回 rollback，生成后校验（tsc）失败即整体回滚，
 *     不留半成品文件；
 *   - 写入前检查 git status，脏工作区给出告警（不阻断，生成物本就应随提交进版本库）。
 * @author donttemo
 * @created 2026-10-13
 * @module cli/gen
 */

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PlanFile } from './render.js';

const execFileAsync = promisify(execFile);

/** 生成器 IO（与 args.ts 的 CliIo 结构一致，便于单测注入） */
export interface GenIo {
  log: (message: string) => void;
  error: (message: string) => void;
}

/** 写入选项 */
export interface WritePlanOptions {
  /** 项目根目录 */
  projectRoot: string;
  /** dry-run：只预览不落盘 */
  dry?: boolean;
  /** 覆盖已存在文件 */
  force?: boolean;
  /** 输出 */
  io?: GenIo;
}

/** 写入结果 */
export interface WriteResult {
  /** 本次写入（含覆盖）的文件 */
  written: string[];
  /** 已存在被跳过的文件（未传 --force） */
  skipped: string[];
  /** 回滚本次写入（校验失败时调用） */
  rollback: () => void;
}

/** 默认 IO（进程控制台） */
const consoleIo: GenIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/**
 * dry-run 预览：打印将创建 / 修改的文件清单与 diff（TC-GEN-004）
 * @param plan 生成计划
 * @param options 写入选项
 * @returns 预览文本（同时经 io.log 输出）
 */
export function previewPlan(plan: PlanFile[], options: WritePlanOptions): string {
  const io = options.io ?? consoleIo;
  const lines: string[] = ['[gen] dry-run 预览（未落盘）：'];
  for (const file of plan) {
    const abs = path.resolve(options.projectRoot, file.path);
    if (fs.existsSync(abs)) {
      const before = fs.readFileSync(abs, 'utf8');
      lines.push(`  ~ ${file.path}（已存在，${options.force ? '将覆盖' : '默认跳过，--force 才覆盖'}）`);
      lines.push(indentBlock(diffText(before, file.content)));
    } else {
      lines.push(`  + ${file.path}（新建，${file.kind}）`);
      lines.push(indentBlock(file.content));
    }
  }
  const text = lines.join('\n');
  io.log(text);
  return text;
}

/**
 * 执行写入（带回滚能力）
 * @param plan 生成计划
 * @param options 写入选项
 */
export function writePlan(plan: PlanFile[], options: WritePlanOptions): WriteResult {
  const io = options.io ?? consoleIo;
  const written: string[] = [];
  const skipped: string[] = [];
  /** 回滚栈：新文件删文件，覆盖文件还原原文 */
  const undoStack: (() => void)[] = [];
  /** 本次新建的目录（回滚时逆序清理空目录，避免留下空 modules/<model> 壳） */
  const createdDirs: string[] = [];

  /** 确保目录存在，并记录本次新建的目录 */
  const ensureDir = (dir: string): void => {
    if (fs.existsSync(dir)) return;
    fs.mkdirSync(dir, { recursive: true });
    createdDirs.push(dir);
  };

  const rollback = (): void => {
    for (const undo of undoStack.reverse()) {
      try {
        undo();
      } catch {
        // 回滚失败不掩盖原始错误（文件系统状态由调用方后续检查）
      }
    }
    // 逆序清理本次新建的空目录（非空说明有他人文件，保留）
    for (const dir of createdDirs.reverse()) {
      try {
        if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) fs.rmdirSync(dir);
      } catch {
        // 目录清理失败不影响回滚结果判定
      }
    }
  };

  try {
    for (const file of plan) {
      const abs = path.resolve(options.projectRoot, file.path);
      if (fs.existsSync(abs)) {
        if (!options.force) {
          skipped.push(file.path);
          io.log(`[gen] 跳过已存在文件：${file.path}（--force 才覆盖）`);
          continue;
        }
        const before = fs.readFileSync(abs, 'utf8');
        ensureDir(path.dirname(abs));
        fs.writeFileSync(abs, file.content, 'utf8');
        written.push(file.path);
        undoStack.push(() => fs.writeFileSync(abs, before, 'utf8'));
        io.log(`[gen] 已覆盖：${file.path}`);
        continue;
      }
      ensureDir(path.dirname(abs));
      fs.writeFileSync(abs, file.content, 'utf8');
      written.push(file.path);
      undoStack.push(() => {
        if (fs.existsSync(abs)) fs.rmSync(abs, { force: true });
      });
      io.log(`[gen] 已生成：${file.path}`);
    }
  } catch (error) {
    rollback();
    throw error;
  }

  return { written, skipped, rollback };
}

/**
 * git 脏工作区检查（FR-07）
 * @param projectRoot 项目根目录
 * @returns 是否有未提交变更；非 git 目录返回 false（不阻断）
 */
export async function isGitDirty(projectRoot: string): Promise<boolean> {
  try {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: projectRoot,
      encoding: 'utf8',
    });
    return stdout.trim().length > 0;
  } catch {
    return false; // 非 git 仓库或 git 不可用：不阻断生成
  }
}

/**
 * 行级 diff（预览用）：基于 LCS 的简化 unified diff
 * @param before 原内容
 * @param after 新内容
 * @returns diff 文本（- 删除 / + 新增 / 上下文行）
 */
export function diffText(before: string, after: string): string {
  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');
  const lcs = buildLcsTable(beforeLines, afterLines);

  const ops: { type: ' ' | '-' | '+'; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < beforeLines.length && j < afterLines.length) {
    if (beforeLines[i] === afterLines[j]) {
      ops.push({ type: ' ', line: beforeLines[i] });
      i += 1;
      j += 1;
    } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
      ops.push({ type: '-', line: beforeLines[i] });
      i += 1;
    } else {
      ops.push({ type: '+', line: afterLines[j] });
      j += 1;
    }
  }
  while (i < beforeLines.length) {
    ops.push({ type: '-', line: beforeLines[i] });
    i += 1;
  }
  while (j < afterLines.length) {
    ops.push({ type: '+', line: afterLines[j] });
    j += 1;
  }

  // 仅输出变更块（带 1 行上下文），空 diff 返回空串
  const changed = ops.some((op) => op.type !== ' ');
  if (!changed) return '';
  const keep = ops.map((op, index) => {
    if (op.type !== ' ') return true;
    const prev = ops[index - 1];
    const next = ops[index + 1];
    return (prev?.type !== ' ') || (next?.type !== ' ');
  });
  return ops
    .filter((_, index) => keep[index])
    .map((op) => `${op.type} ${op.line}`)
    .join('\n');
}

/** LCS 长度表（diffText 用） */
function buildLcsTable(a: string[], b: string[]): number[][] {
  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
  }
  return table;
}

/** 文本块整体缩进（预览输出用） */
function indentBlock(text: string): string {
  return text
    .split('\n')
    .map((line) => `      ${line}`)
    .join('\n');
}
