#!/usr/bin/env node
/*
 * @file 生成清单与接线一致性门禁（PRD-016 FR-16-03 / AC-16-10）
 * @description 对每个含 fw.gen.json 的应用做三方比对：
 *   ① 清单记录的产物文件是否仍存在（模块 / 种子）；
 *   ② app.module.ts 的标记块内容是否包含清单里的每个模块（import + imports 数组项）；
 *   ③ prisma/seed.ts 的标记块内容是否包含每个种子导出、调用与四个权限码。
 *   任一不符即失败——否则「清单说已接线、实际没接」这类漂移只会在联调时暴露。
 *   用法：node scripts/check-gen-sync.mjs [--root <路径>]
 * @author donttemo
 * @created 2026-10-22
 * @module scripts
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 清单文件名（与 packages/cli/src/gen/manifest.ts 保持一致） */
const MANIFEST_FILE = 'fw.gen.json';
/** 扫描候选目录（含清单的应用根） */
const CANDIDATES = ['apps', 'templates'];

/** 读取标记块正文（不存在返回 null；与 markers.ts 的成对标记约定一致） */
function readBlock(source, id) {
  const lines = source.split('\n');
  const begin = lines.findIndex((line) => line.trim() === `// <fw:gen:${id}>`);
  const end = lines.findIndex((line, index) => index > begin && line.trim() === `// </fw:gen:${id}>`);
  if (begin === -1 || end === -1) return null;
  return lines.slice(begin + 1, end).join('\n');
}

/** 递归找出含 fw.gen.json 的目录（深度限制在 3 层，避免扫进 node_modules） */
function findManifestDirs(root, depth = 0) {
  if (depth > 3) return [];
  const found = [];
  if (fs.existsSync(path.join(root, MANIFEST_FILE))) found.push(root);
  let entries = [];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo'].includes(entry.name)) continue;
    found.push(...findManifestDirs(path.join(root, entry.name), depth + 1));
  }
  return found;
}

/** 校验单个应用，返回问题列表 */
function checkApp(appRoot) {
  const problems = [];
  const manifestFile = path.join(appRoot, MANIFEST_FILE);
  const rel = (target) => path.relative(process.cwd(), target).split(path.sep).join('/');

  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  } catch (error) {
    return [`${rel(manifestFile)} 无法解析：${error.message}`];
  }
  if (!Array.isArray(manifest.entries)) return [`${rel(manifestFile)} 缺少 entries 数组`];

  // 标记块只读一次
  const appModuleFile = path.join(appRoot, 'src', 'app.module.ts');
  const seedFile = path.join(appRoot, 'prisma', 'seed.ts');
  const appModule = fs.existsSync(appModuleFile) ? fs.readFileSync(appModuleFile, 'utf8') : '';
  const seed = fs.existsSync(seedFile) ? fs.readFileSync(seedFile, 'utf8') : '';
  const importsBlock = readBlock(appModule, 'imports');
  const modulesBlock = readBlock(appModule, 'modules');
  const seedImportsBlock = readBlock(seed, 'seed-imports');
  const seedCallsBlock = readBlock(seed, 'seed-calls');
  const permCodesBlock = readBlock(seed, 'perm-codes');

  if (manifest.entries.length > 0) {
    if (importsBlock === null) problems.push(`${rel(appModuleFile)} 缺少标记块 // <fw:gen:imports>`);
    if (modulesBlock === null) problems.push(`${rel(appModuleFile)} 缺少标记块 // <fw:gen:modules>`);
    if (seedImportsBlock === null) problems.push(`${rel(seedFile)} 缺少标记块 // <fw:gen:seed-imports>`);
    if (seedCallsBlock === null) problems.push(`${rel(seedFile)} 缺少标记块 // <fw:gen:seed-calls>`);
    if (permCodesBlock === null) problems.push(`${rel(seedFile)} 缺少标记块 // <fw:gen:perm-codes>`);
  }

  for (const entry of manifest.entries) {
    const moduleFile = path.join(appRoot, entry.modulePath);
    const seedPath = path.join(appRoot, entry.seedPath);
    if (!fs.existsSync(moduleFile)) problems.push(`产物缺失：${rel(moduleFile)}（清单记录 ${entry.model}）`);
    if (!fs.existsSync(seedPath)) problems.push(`产物缺失：${rel(seedPath)}（清单记录 ${entry.model}）`);
    if (importsBlock !== null && !importsBlock.includes(`${entry.moduleClass} }`)) {
      problems.push(`${rel(appModuleFile)} 的 imports 块缺少 ${entry.moduleClass}`);
    }
    if (modulesBlock !== null && !new RegExp(`^\\s*${entry.moduleClass},`, 'm').test(modulesBlock)) {
      problems.push(`${rel(appModuleFile)} 的 modules 块缺少 ${entry.moduleClass}`);
    }
    if (seedImportsBlock !== null && !seedImportsBlock.includes(entry.seedExport)) {
      problems.push(`${rel(seedFile)} 的 seed-imports 块缺少 ${entry.seedExport}`);
    }
    if (seedCallsBlock !== null && !seedCallsBlock.includes(`${entry.seedExport}()`)) {
      problems.push(`${rel(seedFile)} 的 seed-calls 块缺少 ${entry.seedExport}()`);
    }
    for (const code of entry.permissionCodes ?? []) {
      if (permCodesBlock !== null && !permCodesBlock.includes(`'${code}'`)) {
        problems.push(`${rel(seedFile)} 的 perm-codes 块缺少 ${code}`);
      }
    }
  }

  // 反向抽查：模块块里出现的 *Module 必须都在清单中（防止手工改动后清单失真）
  if (modulesBlock !== null) {
    const wired = [...modulesBlock.matchAll(/^\s*(\w+Module),/gm)].map((match) => match[1]);
    const known = new Set(manifest.entries.map((entry) => entry.moduleClass));
    for (const name of wired) {
      if (!known.has(name)) problems.push(`${rel(appModuleFile)} 的 modules 块含清单外模块 ${name}（请重跑 fw gen crud 或手工校正清单）`);
    }
  }

  return problems;
}

const args = process.argv.slice(2);
const rootArg = args.indexOf('--root');
const root = rootArg >= 0 && args[rootArg + 1] ? path.resolve(args[rootArg + 1]) : process.cwd();

const roots = CANDIDATES.map((dir) => path.join(root, dir)).filter((dir) => fs.existsSync(dir));
const appDirs = roots.flatMap((dir) => findManifestDirs(dir));

if (appDirs.length === 0) {
  console.log('[gen-sync] 未发现 fw.gen.json（无生成器托管的应用），检查通过');
  process.exit(0);
}

const allProblems = appDirs.flatMap((appRoot) => checkApp(appRoot).map((problem) => ({ appRoot, problem })));

if (allProblems.length > 0) {
  console.error(`[gen-sync] 发现 ${allProblems.length} 处清单与接线不一致（PRD-016 FR-16-03）：\n`);
  for (const item of allProblems) {
    console.error(`  ${item.problem}`);
  }
  console.error('\n修复：在该应用目录执行 fw gen crud <模型> 重建接线；若产物已删除，请从 fw.gen.json 移除对应条目');
  process.exit(1);
}

console.log(`[gen-sync] 检查通过：${appDirs.length} 个应用的清单、产物与接线一致`);
