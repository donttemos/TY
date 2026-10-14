/**
 * @file 文件头注释校验脚本
 * @description 扫描源码目录，校验每个文件是否存在中文文件头（@file / @author / @created）以及 TODO 标记是否带责任人与日期；--fix 可为缺头文件按模板补头。CI 中失败即阻断。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo 跳过 prisma 多 schema 矩阵生成物（matrix-client-*）与点号前缀的工具生成文件（如 .redis-probe.mjs），与 test-client 既有约定一致
 * @since v0.1.0
 */

import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** 扫描根目录（相对当前工作目录） */
const SCAN_DIRS = ['packages', 'apps', 'templates', 'scripts', 'deploy'];
/** 需要检查的文件后缀 */
const EXTENSIONS = ['.ts', '.tsx', '.js', '.mjs', '.cjs', '.vue', '.sql', '.yml', '.yaml', '.py', '.sh'];
/** 跳过的目录（构建产物 / VCS / 工具生成物） */
const SKIP_DIRS = [
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  '.turbo',
  '.workbuddy',
  // Prisma 生成物：test-client 为 prisma generate 产物，migrations 为 Prisma 管理的迁移（命名规范已是约束）
  'test-client',
  'migrations',
];
/** 生成物目录名模式：三库矩阵的 prisma generate 输出（matrix-client-mysql / matrix-client-postgresql，见 packages/db/scripts/matrix-db-setup.mjs） */
const SKIP_DIR_PATTERN = /^matrix-client-/;
/** 跳过的文件（按文件名匹配）：vitest 用 tsx 编译 .ts 配置时产生的临时产物，以及点号前缀的工具生成文件（如 .redis-probe.mjs），不属于源码 */
const SKIP_FILES = (name) => /\.(?:timestamp-[\w-]+|[a-z0-9-]+\.tmp)\.(?:mjs|js)$/i.test(name) || name.startsWith('.');

const args = process.argv.slice(2);
const fixMode = args.includes('--fix');
const rootIndex = args.indexOf('--root');
const root = rootIndex >= 0 ? args[rootIndex + 1] : '.';

/** 获取当天日期，格式 YYYY-MM-DD（本地时区） */
function today() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 仓库统一署名，git 未配置 user.name 时回退使用 */
const DEFAULT_AUTHOR = 'donttemo';

/** 取 git 提交者姓名，作为文件头 @author 默认值 */
function gitUserName() {
  try {
    return execSync('git config user.name', { encoding: 'utf8' }).trim();
  } catch {
    console.warn(`[warn] 未检测到 git config user.name，@author 回退为默认署名 ${DEFAULT_AUTHOR}`);
    return DEFAULT_AUTHOR;
  }
}

/** 递归收集待检查文件 */
function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.includes(entry.name) || SKIP_DIR_PATTERN.test(entry.name)) continue;
      collectFiles(full, out);
    } else if (!SKIP_FILES(entry.name) && EXTENSIONS.includes(path.extname(entry.name))) {
      out.push(full);
    }
  }
  return out;
}

/** 按文件类型生成文件头模板 */
function buildHeader(file, author, date) {
  const name = path.basename(file);
  const moduleName = path.basename(path.dirname(file));
  const body = [
    ` * @file ${name}`,
    ` * @description 待补充：用中文说明该文件职责与边界`,
    ` * @author ${author}`,
    ` * @created ${date}`,
    ` * @module ${moduleName}`,
  ].join('\n');
  const ext = path.extname(file);
  if (ext === '.sql') return `-- @file ${name}\n-- @description 待补充：用中文说明该文件职责\n-- @author ${author}\n-- @created ${date}\n`;
  if (['.yml', '.yaml', '.py', '.sh'].includes(ext)) {
    return `# @file ${name}\n# @description 待补充：用中文说明该文件职责\n# @author ${author}\n# @created ${date}\n`;
  }
  if (ext === '.vue') return `<!--\n${body}\n-->\n`;
  return `/*\n${body}\n */\n`;
}

const files = SCAN_DIRS.flatMap((d) => collectFiles(path.join(root, d)));
const problems = [];
const dateRe = /@created\s+(\d{4}-\d{2}-\d{2})/;
// 只识别注释行中的标记：// TODO(张三, 2026-10-09): ... ；正文里出现 TODO 字样不算
const todoLineRe = /^\s*(?:\/\/|#|\*|<!--)\s*(TODO|FIXME)\b(.*)$/;
const todoHasOwnerAndDateRe = /\([^)]*\d{4}-\d{2}-\d{2}[^)]*\)/;

for (const file of files) {
  let source = fs.readFileSync(file, 'utf8');
  const head = source.split('\n').slice(0, 30).join('\n');

  if (!head.includes('@file') || !head.includes('@author') || !head.includes('@created')) {
    if (!fixMode) {
      problems.push({ file, type: '缺少文件头（@file / @author / @created）' });
      continue;
    }
    const author = gitUserName();
    source = buildHeader(file, author, today()) + source;
    fs.writeFileSync(file, source, 'utf8');
    problems.push({ file, type: `已补头（作者：${author}，请补全 @description）`, fixed: true });
  }

  const matched = head.match(dateRe);
  if (matched && !/^\d{4}-\d{2}-\d{2}$/.test(matched[1])) {
    problems.push({ file, type: `@created 日期格式应为 YYYY-MM-DD（当前：${matched[1]}）` });
  }

  const todoLines = source
    .split('\n')
    .map((line) => line.match(todoLineRe))
    .filter((m) => m && !todoHasOwnerAndDateRe.test(m[2]));
  for (const m of todoLines) {
    problems.push({ file, type: `TODO/FIXME 未带责任人与日期：${m[0].trim().slice(0, 60)}` });
  }
}

if (problems.length > 0) {
  for (const p of problems) {
    console.log(`${p.fixed ? '[fix]' : '[err]'} ${p.file} — ${p.type}`);
  }
  const blocking = problems.filter((p) => !p.fixed).length;
  if (blocking > 0) {
    console.error(`\n文件头校验未通过：${blocking} 项待修（规范见 docs/70-engineering-standards.md §1.6）`);
    process.exit(1);
  }
  console.log('\n已自动补全文件头，请补充 @description 后再提交。');
} else {
  console.log(`文件头校验通过（已检查 ${files.length} 个文件）。`);
}
