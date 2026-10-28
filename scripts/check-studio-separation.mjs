#!/usr/bin/env node
/*
 * @file Studio 与后台平台的边界门禁（PRD-017 铁律 6）
 * @description TY Studio 是**开发者本地工具**，后台管理平台（apps/admin-web + 应用服务）是**产品**。
 *   两者受众、部署位置、鉴权模型都不同，混在一起会同时坏掉两边：Studio 的 token 模型进后台就是安全漏洞，
 *   后台的页面进 Studio 就是体积与耦合负担。本门禁把边界变成可执行的检查：
 *   R1 Studio 源码不得依赖 apps/**（开发工具不拿产品应用当运行时依赖）
 *   R2 后台前端不得引用 Studio（产品不依赖开发工具）
 *   R3 部署产物（deploy/**）不得出现 Studio（它永远不该被部署到服务器）
 *   R4 Studio 的端口与命令不得出现在部署配置或后台代码里
 *   用法：node scripts/check-studio-separation.mjs
 * @author donttemo
 * @created 2026-10-22
 * @module scripts
 */

import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';

/** 规则定义 */
const RULES = [
  {
    id: 'R1',
    description: 'Studio 源码不得依赖 apps/**（开发工具不拿产品应用当运行时依赖）',
    roots: ['packages/cli/src/studio'],
    pattern: /from\s+['"][^'"]*\/?apps\/|require\(\s*['"][^'"]*\/?apps\//,
    skipTests: false,
  },
  {
    id: 'R2',
    description: '后台前端不得引用 Studio（产品不依赖开发工具）',
    roots: ['apps/admin-web/src', 'apps/admin-web/package.json'],
    pattern: /@fw\/studio|fw studio|\/api\/schema\/(preview|apply)/,
    skipTests: true,
  },
  {
    id: 'R3',
    description: '部署产物不得出现 Studio（它只在本机运行，永不部署）',
    roots: ['deploy'],
    pattern: /fw studio|@fw\/studio|\/api\/schema\/apply/,
    skipTests: false,
  },
  {
    id: 'R4',
    description: 'Studio 端口不得出现在部署配置或后台代码里（避免被当成对外服务）',
    roots: ['deploy', 'apps/admin-web/src'],
    pattern: /\b4310\b/,
    skipTests: true,
  },
];

/** 跳过的目录 */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage', '.git', '.turbo', 'e2e-artifacts']);
/** 参与检查的后缀 */
const EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs', '.vue', '.json', '.yml', '.yaml', '.sh', '.conf']);

/**
 * 收集文件
 * @param target 目标（文件或目录）
 */
function collect(target) {
  if (!fs.existsSync(target)) return [];
  const stat = fs.statSync(target);
  if (stat.isFile()) return [target];
  const files = [];
  for (const entry of fs.readdirSync(target, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(target, entry.name);
    if (entry.isDirectory()) files.push(...collect(full));
    else if (EXTENSIONS.has(path.extname(entry.name)) || entry.name === 'Dockerfile') files.push(full);
  }
  return files;
}

const root = process.cwd();
const violations = [];

for (const rule of RULES) {
  for (const relativeRoot of rule.roots) {
    for (const file of collect(path.join(root, relativeRoot))) {
      const rel = path.relative(root, file).split(path.sep).join('/');
      if (rule.skipTests && rel.includes('__tests__')) continue;
      const lines = fs.readFileSync(file, 'utf8').split('\n');
      lines.forEach((line, index) => {
        if (rule.pattern.test(line)) {
          violations.push({ rule: rule.id, description: rule.description, file: rel, line: index + 1, text: line.trim() });
        }
      });
    }
  }
}

if (violations.length > 0) {
  console.error(`[studio-separation] 发现 ${violations.length} 处越界（PRD-017 铁律 6）：\n`);
  for (const item of violations) {
    console.error(`  [${item.rule}] ${item.file}:${item.line}\n    ${item.text}\n    ${item.description}\n`);
  }
  console.error('修复：Studio 与后台平台互不依赖；Studio 只在本机运行，不得进入 deploy/**');
  process.exit(1);
}

console.log('[studio-separation] 检查通过：Studio 与后台平台边界清晰（R1~R4）');
