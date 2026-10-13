#!/usr/bin/env node
/*
 * @file 原生 SQL 静态检查（TC-ORM-005）
 * @description 扫描 packages/ 与 apps/ 源码中的 $queryRaw/$executeRaw 调用：
 *   调用处上方 3 行内无 `@sql('<dialect>')` 标注即失败。
 *   框架自身的 @fw/db 适配器（方言分支封装点）在豁免清单内。
 *   用法：node scripts/check-no-raw-sql.mjs [--dir packages,apps]
 * @author donttemo
 * @created 2026-10-12
 * @module scripts
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 扫描根目录（相对当前工作目录） */
const SCAN_DIRS = ['packages', 'apps'];
/** 检查的后缀 */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs'];
/** 跳过的目录 */
const SKIP_DIRS = ['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', '__tests__', 'prisma'];
/** 豁免文件（框架方言适配器封装点，允许 raw SQL） */
const EXEMPT_FILES = [
  path.normalize('packages/db/src/prisma-repository.ts'),
  path.normalize('packages/db/src/__tests__/prisma-repository.test.ts'),
];
/** 原生 SQL 调用模式：仅匹配成员访问调用（.$queryRaw），接口签名/对象属性不匹配 */
const RAW_CALL_RE = /\.\s*\$(queryRaw|executeRaw)/;
/** 方言标注模式：@sql('mysql') / @sql("mysql","postgresql") / @sql('mysql','pg','sqlite') */
const SQL_ANNOTATION_RE = /@sql\(\s*['"](mysql|postgresql|sqlite|pg|mariadb)['"]/;
/** 标注允许的最大行距（调用处往上数） */
const ANNOTATION_LOOKBACK = 3;

/** 递归收集待检查文件 */
function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name)) continue;
      collectFiles(full, out);
    } else if (EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 检查单文件：返回违规列表 */
function checkFile(file) {
  const rel = path.normalize(file);
  if (EXEMPT_FILES.includes(rel)) return [];
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  const violations = [];
  for (let i = 0; i < lines.length; i++) {
    if (!RAW_CALL_RE.test(lines[i])) continue;
    // 往上找标注
    const from = Math.max(0, i - ANNOTATION_LOOKBACK);
    const context = lines.slice(from, i).join('\n');
    if (!SQL_ANNOTATION_RE.test(context)) {
      violations.push({ file: rel, line: i + 1, text: lines[i].trim() });
    }
  }
  return violations;
}

const roots = process.argv.includes('--dir')
  ? process.argv[process.argv.indexOf('--dir') + 1].split(',')
  : SCAN_DIRS;

const files = roots.flatMap((root) => collectFiles(root));
const violations = files.flatMap(checkFile);

if (violations.length > 0) {
  console.error(`[raw-sql] 发现 ${violations.length} 处未标注方言的原生 SQL（TC-ORM-005）：\n`);
  for (const v of violations) {
    console.error(`  ${v.file}:${v.line}\n    ${v.text}\n`);
  }
  console.error('修复：调用处上方 3 行内加 // @sql(\'mysql\',\'postgresql\') 标注，或改用 @fw/db 适配器方法');
  process.exit(1);
}
console.log(`[raw-sql] 检查通过：${files.length} 个文件无未标注原生 SQL`);
