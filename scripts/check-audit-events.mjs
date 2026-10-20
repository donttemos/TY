#!/usr/bin/env node
/*
 * @file 审计事件门禁（PRD-015 FR-15-21，ADR-0032 R1）
 * @description 一条事件必须同时满足三件事才算「已接入」，本脚本把三者对撞：
 *   ① 注册表（packages/auth/src/audit-events.ts）自检通过：码唯一、命名合规、文案/模板变量完整；
 *   ② 代码里不出现未登记的事件码（`event: 'x'` 与 `recordEvent('x')` 两处语义位置）；
 *   ③ 注册表每个未废弃条目都能在生产代码中找到写入点（字符串字面量出现即可，
 *      兼容「动作→事件码」映射表这类间接引用）；
 *   ④ 覆盖矩阵（docs/45 §7）逐一列出注册表条目——文档与代码不许各说各话。
 *
 *   「写入点」为何用「字面量出现」而不是「recordEvent 调用」：生命周期事件经
 *   `LIFECYCLE_EVENTS[action]` 映射表间接传入，只认直接调用会把已接入的事件误判为缺失；
 *   而「未登记码」只认 `event:` 与直接调用两个语义位置，避免把普通说明文字当成事件码。
 *
 *   注册表以 TypeScript 源码直接导入（Node --experimental-strip-types），
 *   **不生成第二份码表副本**——否则门禁本身会成为新的漂移源。
 *
 *   运行：pnpm run check:audit-events（缺 strip-types 标记时给出可复制的修复命令）
 *   退出码：0 = 通过；1 = 存在缺口；2 = 注册表读取失败
 * @author donttemo
 * @created 2026-10-20
 * @module scripts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMockAuditEventsFile } from './gen-audit-events-mock.mjs';

const ROOT = process.cwd();
const REGISTRY_PATH = join(ROOT, 'packages', 'auth', 'src', 'audit-events.ts');
const MATRIX_DOC = join(ROOT, 'docs', '45-observability-contract.md');
/** 生产代码扫描根（模板项目是独立产物，不参与框架门禁） */
const SCAN_ROOTS = ['packages', join('apps', 'example-api', 'src'), join('apps', 'admin-web', 'src')];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.git', 'migrations']);
const TEST_FILE = /(\.spec\.ts|\.test\.ts)$|__tests__/;

/** 语义位置上必须登记的事件码：属性 `event:` 与 `recordEvent('…')` */
const DECLARED_PATTERNS = [
  /(?:^|[^a-zA-Z0-9_])event:\s*['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"]/g,
  /recordEvent(?:Sync)?\(\s*['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"]/g,
];

/** 任意字符串字面量（用于「注册表条目是否有写入点」判定） */
const ANY_LITERAL = /['"]([a-z][a-z0-9_]*(?:\.[a-z][a-z0-9_]*)+)['"]/g;

/**
 * 动态事件码调用（无法静态校验，仅提示）
 *
 * 只认「成员调用」（`.recordEvent(`），避免把方法定义 `recordEvent(code: string)` 误报成动态调用。
 */
const DYNAMIC_CALL = /\.\s*recordEvent(?:Sync)?\(\s*(?!['"])/g;

/** 递归收集待扫描文件 */
function collectFiles(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry)) continue;
    const full = join(dir, entry);
    const stat = statSync(full);
    if (stat.isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(ts|vue)$/.test(entry) && !TEST_FILE.test(full)) {
      out.push(full);
    }
  }
  return out;
}

/** 行号（1 基） */
function lineOf(content, index) {
  let line = 1;
  for (let cursor = 0; cursor < index; cursor += 1) if (content[cursor] === '\n') line += 1;
  return line;
}

/** 主流程 */
async function main() {
  let registry;
  try {
    registry = await import(pathToFileURL(REGISTRY_PATH).href);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[audit-events] 无法导入注册表：%s', message);
    if (/Unknown file extension|Unexpected token|ERR_UNKNOWN_FILE_EXTENSION/.test(message)) {
      console.error('[audit-events] 请使用 pnpm run check:audit-events（内部带 --experimental-strip-types）');
    }
    process.exit(2);
  }

  const { AUDIT_EVENTS, verifyAuditRegistry } = registry;
  const registered = new Set(AUDIT_EVENTS.map((item) => item.code));
  const active = AUDIT_EVENTS.filter((item) => !item.deprecated);
  const findings = [];
  const warnings = [];

  // ① 注册表自检
  for (const issue of verifyAuditRegistry()) findings.push(`注册表自检失败：${issue}`);

  // ② 扫描生产代码
  const files = SCAN_ROOTS.flatMap((root) => collectFiles(join(ROOT, root)));
  const usedLiterals = new Set();
  const declared = new Map(); // code → [file:line]

  for (const file of files) {
    const content = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file).replace(/\\/g, '/');

    for (const pattern of DECLARED_PATTERNS) {
      pattern.lastIndex = 0;
      let match;
      while ((match = pattern.exec(content)) !== null) {
        const code = match[1];
        if (!registered.has(code)) findings.push(`未登记事件码：${code}（${rel}:${lineOf(content, match.index)}）`);
        declared.set(code, [...(declared.get(code) ?? []), `${rel}:${lineOf(content, match.index)}`]);
      }
    }

    ANY_LITERAL.lastIndex = 0;
    let literal;
    while ((literal = ANY_LITERAL.exec(content)) !== null) {
      if (registered.has(literal[1])) usedLiterals.add(literal[1]);
    }

    const dynamicCount = (content.match(DYNAMIC_CALL) ?? []).length;
    if (dynamicCount > 0) warnings.push(`动态事件码调用 ${dynamicCount} 处（无法静态校验）：${rel}`);
  }

  // ③ 注册表条目必须有写入点
  for (const item of active) {
    if (!usedLiterals.has(item.code)) {
      findings.push(`注册表条目无写入点：${item.code}（生产代码中找不到该码的字面量）`);
    }
  }

  // ④ 覆盖矩阵与注册表一致
  const doc = readFileSync(MATRIX_DOC, 'utf8');
  for (const item of active) {
    if (!doc.includes(item.code)) findings.push(`覆盖矩阵缺条目：${item.code}（docs/45 §7 未列出）`);
  }

  // ⑤ mock 侧注册表是生成物：与后端注册表逐字节一致，杜绝手抄漂移
  //    （B3 首版手抄 12 条，页面大半事件显示「未登记」——本项就是那次事故的护栏）
  const mockRegistryPath = join(ROOT, 'apps', 'admin-web', 'mock', 'audit-events.ts');
  try {
    const expected = await buildMockAuditEventsFile();
    const actual = readFileSync(mockRegistryPath, 'utf8');
    if (actual !== expected) {
      findings.push('mock 注册表过期：apps/admin-web/mock/audit-events.ts 与后端注册表不一致（运行 pnpm run gen:audit-events-mock）');
    }
  } catch (error) {
    findings.push(`mock 注册表校验失败：${error instanceof Error ? error.message : String(error)}`);
  }

  console.log('[audit-events] 注册表条目 %d（有效 %d / 废弃 %d）', AUDIT_EVENTS.length, active.length, AUDIT_EVENTS.length - active.length);
  console.log('[audit-events] 扫描生产文件 %d，命中已登记码 %d 个', files.length, usedLiterals.size);
  if (declared.size > 0) console.log('[audit-events] 显式声明点 %d 处（event: / recordEvent 字面量）', [...declared.values()].flat().length);

  if (warnings.length > 0) {
    console.log('\n[audit-events] 提示（不阻断，共 %d 条）：', warnings.length);
    for (const warning of warnings) console.log('    - %s', warning);
  }

  if (findings.length > 0) {
    console.error('\n[audit-events] 发现 %d 处缺口：', findings.length);
    for (const finding of findings) console.error('    - %s', finding);
    console.error('\n修复方式：先在 packages/auth/src/audit-events.ts 登记事件，再补写入点与 docs/45 §7 矩阵行。');
    process.exit(1);
  }

  console.log('\n[audit-events] OK：注册表 / 写入点 / 覆盖矩阵三方一致（PRD-015 FR-15-21）');
}

await main();
