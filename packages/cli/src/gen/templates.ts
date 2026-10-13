/*
 * @file 模板定位与生成配置
 * @description PRD-006 FR-06：模板存放于 templates/codegen/（框架仓库内置），
 *   项目根目录 templates/codegen/ 下的同名模板优先覆盖（团队统一风格入口）。
 *   项目级配置 codegen.config.json 提供自定义变量 vars 与类型覆盖 typeOverrides。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-13 donttemo listBuiltinTemplates 只列 .tpl：目录内 README 等文档不算模板
 * @module cli/gen
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { TypeOverrides } from './type-map.js';

/** 内置模板根目录名（相对仓库根） */
export const CODEGEN_TEMPLATE_DIR = 'codegen';
/** 项目级配置文件 */
export const CODEGEN_CONFIG_FILE = 'codegen.config.json';

/** 项目级生成配置 */
export interface CodegenConfig {
  /** 自定义模板变量（透传给所有模板） */
  vars?: Record<string, string>;
  /** 类型映射覆盖（按 prisma 类型名） */
  typeOverrides?: TypeOverrides;
}

/**
 * 从 CLI 包位置向上查找框架仓库根（以 pnpm-workspace.yaml 为标志）
 * @returns 仓库根绝对路径
 */
export function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 8; i++) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error('未找到框架仓库根（pnpm-workspace.yaml）；请在框架 monorepo 内执行 fw gen');
}

/**
 * 读取项目级生成配置
 * @param projectRoot 项目根目录（生成目标目录）
 * @returns 配置；文件不存在时返回空配置
 */
export function loadCodegenConfig(projectRoot: string): CodegenConfig {
  const configPath = path.join(projectRoot, CODEGEN_CONFIG_FILE);
  if (!fs.existsSync(configPath)) return {};
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as CodegenConfig;
  } catch (error) {
    throw new Error(`${CODEGEN_CONFIG_FILE} 解析失败：${error instanceof Error ? error.message : String(error)}`);
  }
}

/**
 * 定位模板文件：项目级同名模板优先，否则用框架内置模板
 * @param relativeName 模板相对名（如 backend/service.ts.tpl）
 * @param projectRoot 项目根目录
 * @returns 模板绝对路径；两侧都不存在时抛出错误
 */
export function resolveTemplate(relativeName: string, projectRoot: string): string {
  const projectTemplate = path.join(projectRoot, 'templates', CODEGEN_TEMPLATE_DIR, relativeName);
  if (fs.existsSync(projectTemplate)) return projectTemplate;
  const builtin = path.join(findRepoRoot(), 'templates', CODEGEN_TEMPLATE_DIR, relativeName);
  if (fs.existsSync(builtin)) return builtin;
  throw new Error(`模板缺失：${relativeName}（项目 ${projectTemplate} 与内置 ${builtin} 均不存在）`);
}

/** 列出某目录下全部模板相对名（用于 --list-templates 之类的排查场景） */
export function listBuiltinTemplates(subdir = ''): string[] {
  const root = path.join(findRepoRoot(), 'templates', CODEGEN_TEMPLATE_DIR, subdir);
  if (!fs.existsSync(root)) return [];
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) walk(path.join(dir, entry.name), `${prefix}${entry.name}/`);
      // 只收集模板文件：目录内文档（README.md 等）不是模板，resolveTemplate 也只按 .tpl 解析
      else if (entry.name.endsWith('.tpl')) out.push(`${prefix}${entry.name}`);
    }
  };
  walk(root, '');
  return out.sort();
}
