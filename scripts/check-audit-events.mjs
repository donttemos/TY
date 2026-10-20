#!/usr/bin/env node
/*
 * @file 审计事件门禁（PRD-015 FR-15-21，ADR-0032 R1）
 * @description 一条事件必须同时满足四件事才算「已接入」，本脚本把四者对撞：
 *   ① 注册表（packages/auth/src/audit-events.ts）自检通过：码唯一、命名合规、文案/模板变量完整；
 *   ② 代码里不出现未登记的事件码（`event: 'x'` 与 `recordEvent('x')` 两处语义位置）；
 *   ③ 注册表每个未废弃条目都能在生产代码中找到**真实写入点**；
 *   ④ 覆盖矩阵（docs/45 §7）逐一列出注册表条目——文档与代码不许各说各话。
 *   另有 ⑤ mock 侧注册表为生成物，与后端注册表逐字节一致。
 *
 *   ③ 的口径是本次安全加固的重点（此前用「任意字面量出现即算」，注册表自身也在扫描范围内，
 *   于是删掉唯一写入调用后门禁依旧是绿的）：
 *   - 注册表定义文件**整体排除**：它列出全部事件码，是码表而不是「有人真的记了这条审计」；
 *   - 写入点只认 `recordEvent('x')` / `recordEventSync('x')` 与 `event: 'x'` 属性（仅服务端文件）；
 *   - 间接引用只认**显式标注的映射表**（文件内含 `@audit-event-map`，如 saas 的
 *     `LIFECYCLE_EVENTS[action]`）——「任意字面量出现」不再算数。
 *   判定逻辑拆在 scripts/lib/audit-gate.mjs（纯函数），由 scripts/__tests__/audit-gate.test.mjs
 *   反向验证：删掉某事件唯一的写入点后，分析结果必须报「无写入点」。
 *
 *   注册表以 TypeScript 源码直接导入（Node --experimental-strip-types），
 *   **不生成第二份码表副本**——否则门禁本身会成为新的漂移源。
 *
 *   运行：pnpm run check:audit-events（缺 strip-types 标记时给出可复制的修复命令）
 *   退出码：0 = 通过；1 = 存在缺口；2 = 注册表读取失败
 * @author donttemo
 * @created 2026-10-20
 * @modified 2026-10-20 donttemo M15 安全加固：写入点判定排除注册表定义文件、只认真实事件调用与
 *   显式映射表，判定逻辑抽到 lib/audit-gate.mjs 以支持反向测试
 * @module scripts
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { buildMockAuditEventsFile } from './gen-audit-events-mock.mjs';
import { analyzeAuditCoverage } from './lib/audit-gate.mjs';

const ROOT = process.cwd();
/** 注册表定义文件（相对仓库根，POSIX 分隔符）：既是导入源，也是「不是写入点」的定义文件 */
const REGISTRY_REL = 'packages/auth/src/audit-events.ts';
const REGISTRY_PATH = join(ROOT, REGISTRY_REL);
const MATRIX_DOC = join(ROOT, 'docs', '45-observability-contract.md');
/** 生产代码扫描根（模板项目是独立产物，不参与框架门禁） */
const SERVER_ROOTS = ['packages', join('apps', 'example-api', 'src')];
/** 前端扫描根：仍要检查未登记码，但 `event:` 只是查询参数，不算写入点 */
const FRONTEND_ROOTS = [join('apps', 'admin-web', 'src')];
const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', '.turbo', '.git', 'migrations']);
const TEST_FILE = /(\.spec\.ts|\.test\.ts)$|__tests__/;

/** 递归收集待扫描文件（返回绝对路径） */
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

/** 绝对路径 → 仓库相对 POSIX 路径（门禁输出与定义文件比对都用它） */
function toRel(file) {
  return relative(ROOT, file).replace(/\\/g, '/');
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
  const active = AUDIT_EVENTS.filter((item) => !item.deprecated);
  const findings = [];

  // ① 注册表自检
  for (const issue of verifyAuditRegistry()) findings.push(`注册表自检失败：${issue}`);

  // ②③ 扫描生产代码并按「真实写入点」判定覆盖
  const files = [
    ...SERVER_ROOTS.flatMap((root) => collectFiles(join(ROOT, root))).map((file) => ({ file, countsEventProperty: true })),
    ...FRONTEND_ROOTS.flatMap((root) => collectFiles(join(ROOT, root))).map((file) => ({ file, countsEventProperty: false })),
  ].map((entry) => ({
    path: toRel(entry.file),
    content: readFileSync(entry.file, 'utf8'),
    countsEventProperty: entry.countsEventProperty,
  }));

  const coverage = analyzeAuditCoverage({
    registry: AUDIT_EVENTS,
    files,
    definitionPaths: [REGISTRY_REL],
  });
  findings.push(...coverage.findings);

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

  const writePointTotal = [...coverage.writePoints.values()].reduce((sum, list) => sum + list.length, 0);
  console.log('[audit-events] 注册表条目 %d（有效 %d / 废弃 %d）', AUDIT_EVENTS.length, active.length, AUDIT_EVENTS.length - active.length);
  console.log('[audit-events] 扫描生产文件 %d，有真实写入点的事件 %d 个（共 %d 处）', files.length, coverage.writePoints.size, writePointTotal);
  console.log('[audit-events] 显式声明点 %d 处（event: / recordEvent 字面量）', coverage.declaredCount);

  if (coverage.warnings.length > 0) {
    console.log('\n[audit-events] 提示（不阻断，共 %d 条）：', coverage.warnings.length);
    for (const warning of coverage.warnings) console.log('    - %s', warning);
  }

  if (findings.length > 0) {
    console.error('\n[audit-events] 发现 %d 处缺口：', findings.length);
    for (const finding of findings) console.error('    - %s', finding);
    console.error('\n修复方式：先在 packages/auth/src/audit-events.ts 登记事件，再补真实写入调用');
    console.error('（recordEvent / event: 属性，或显式标注 @audit-event-map 的映射表），最后补 docs/45 §7 矩阵行。');
    process.exit(1);
  }

  console.log('\n[audit-events] OK：注册表 / 真实写入点 / 覆盖矩阵三方一致（PRD-015 FR-15-21）');
}

await main();
