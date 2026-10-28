/*
 * @file 自动接线（PRD-016 FR-16-02）
 * @description 由清单条目重建框架文件里被标记块托管的区域，产出 mode='patch' 的生成计划：
 *   - app.module.ts：模块 import 语句 + imports 数组项；
 *   - prisma/seed.ts：种子 import 语句 + 种子调用 + 生成器权限码。
 *   块内容**由清单全量重建**（不是增量插入），因此重跑幂等、删除模型后残留会被自动清掉。
 *   标记块缺失 / 重复时直接抛 GenMarkerError，不猜测位置。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/gen
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { GEN_BLOCKS, hasBlock, replaceBlock } from './markers.js';
import type { GenManifestEntry } from './manifest.js';
import type { AppLayout, PlanFile } from './render.js';

/** 接线范围 */
export interface WiringScope {
  /** 是否接线 app.module.ts */
  backend: boolean;
  /** 是否接线 prisma/seed.ts */
  seed: boolean;
}

/** 接线产物信息（供 gen 打印与门禁使用） */
export interface WiringResult {
  /** 待写入的 patch 计划 */
  plan: PlanFile[];
  /**
   * 未能接线的告警（目标文件缺失 / 缺标记块）。
   * 接线是增强而非前置条件：老项目没接入标记时**降级为不接线**并明确告警，
   * 产物照常生成（否则任何存量项目第一次升级都会直接失败）。
   */
  warnings: string[];
  /** app.module.ts 的绝对路径（后端范围内） */
  appModuleFile?: string;
  /** prisma/seed.ts 的绝对路径（种子范围内） */
  seedFile?: string;
}

/** 相对路径统一用 `/` 分隔（跨平台一致，写入计划与 windows 无关） */
function toPosix(relativePath: string): string {
  return relativePath.split(path.sep).join('/');
}

/** 由后端应用根到目标文件的相对路径（不带扩展名，供 import 使用） */
function importSpecifier(fromFile: string, toFile: string): string {
  const relativePath = toPosix(path.relative(path.dirname(fromFile), toFile)).replace(/\.ts$/, '.js');
  return relativePath.startsWith('.') ? relativePath : `./${relativePath}`;
}

/** 渲染 app.module.ts 的 import 语句块（按 model 排序，保证稳定） */
function renderModuleImports(entries: GenManifestEntry[], appModuleFile: string, backendRoot: string): string {
  return entries
    .map((entry) => `import { ${entry.moduleClass} } from '${importSpecifier(appModuleFile, path.join(backendRoot, entry.modulePath))}';`)
    .join('\n');
}

/** 渲染 imports 数组项块 */
function renderModuleEntries(entries: GenManifestEntry[]): string {
  return entries.map((entry) => `${entry.moduleClass},`).join('\n');
}

/** 渲染 seed import 语句块 */
function renderSeedImports(entries: GenManifestEntry[], seedFile: string, backendRoot: string): string {
  return entries
    .map((entry) => `import { ${entry.seedExport} } from '${importSpecifier(seedFile, path.join(backendRoot, entry.seedPath))}';`)
    .join('\n');
}

/** 渲染种子调用块 */
function renderSeedCalls(entries: GenManifestEntry[]): string {
  return entries.map((entry) => `await ${entry.seedExport}();`).join('\n');
}

/** 渲染权限码块（每个码一行，便于 diff） */
function renderPermCodes(entries: GenManifestEntry[]): string {
  return entries.flatMap((entry) => entry.permissionCodes.map((code) => `'${code}',`)).join('\n');
}

/**
 * 读取文本文件（不存在或未接入标记块时返回 null，由调用方降级）
 * @param file 绝对路径
 * @param hint 修复提示
 * @param blockIds 该文件要求的标记块
 * @param warnings 告警收集
 * @param projectRoot 项目根（告警里用相对路径）
 */
function readWired(
  file: string,
  hint: string,
  blockIds: string[],
  warnings: string[],
  projectRoot: string,
): string | null {
  const rel = toPosix(path.relative(projectRoot, file));
  if (!fs.existsSync(file)) {
    warnings.push(`${rel} 不存在，本次未自动接线（${hint}）`);
    return null;
  }
  const source = fs.readFileSync(file, 'utf8');
  const missing = blockIds.filter((id) => !hasBlock(source, id));
  if (missing.length > 0) {
    warnings.push(
      `${rel} 缺少标记块 ${missing.map((id) => `// <fw:gen:${id}>`).join(' / ')}，本次未自动接线；` +
        `按需补上成对标记后重跑即可（标记内不要写业务代码，生成器会整块重写）`,
    );
    return null;
  }
  return source;
}

/**
 * 组装接线计划
 * @param layout 应用布局
 * @param entries 清单里的全部条目（含本次新生成的）
 * @param scope 接线范围
 * @param projectRoot 项目根（用于把绝对路径转成计划里的相对路径）
 */
export function buildWiringPlan(
  layout: AppLayout,
  entries: GenManifestEntry[],
  scope: WiringScope,
  projectRoot: string,
): WiringResult {
  const plan: PlanFile[] = [];
  const warnings: string[] = [];
  const result: WiringResult = { plan, warnings };
  // 排序必须在此处兜住：调用方（清单读回、单测直调）不保证有序，无序条目会让输出随入参变动
  const ordered = [...entries].sort((a, b) => a.model.localeCompare(b.model));

  if (scope.backend) {
    const appModuleFile = path.join(layout.backendRoot, 'src', 'app.module.ts');
    result.appModuleFile = appModuleFile;
    const source = readWired(
      appModuleFile,
      '请确认后端应用为 NestJS 结构（src/app.module.ts），或用 --app 指定应用目录',
      [GEN_BLOCKS.IMPORTS.id, GEN_BLOCKS.MODULES.id],
      warnings,
      projectRoot,
    );
    if (source !== null) {
      const appModuleRel = toPosix(path.relative(projectRoot, appModuleFile));
      const withImports = replaceBlock(source, GEN_BLOCKS.IMPORTS.id, renderModuleImports(ordered, appModuleFile, layout.backendRoot), {
        file: appModuleRel,
      });
      const withModules = replaceBlock(withImports, GEN_BLOCKS.MODULES.id, renderModuleEntries(ordered), {
        indent: '    ',
        file: appModuleRel,
      });
      if (withModules !== source) {
        plan.push({ path: appModuleRel, content: withModules, kind: 'backend', mode: 'patch' });
      }
    }
  }

  if (scope.seed) {
    const seedFile = path.join(layout.backendRoot, 'prisma', 'seed.ts');
    result.seedFile = seedFile;
    const source = readWired(
      seedFile,
      '请确认 prisma/seed.ts 存在（fw new 模板自带）',
      [GEN_BLOCKS.SEED_IMPORTS.id, GEN_BLOCKS.SEED_CALLS.id, GEN_BLOCKS.PERM_CODES.id],
      warnings,
      projectRoot,
    );
    if (source !== null) {
      const seedRel = toPosix(path.relative(projectRoot, seedFile));
      let next = replaceBlock(source, GEN_BLOCKS.SEED_IMPORTS.id, renderSeedImports(ordered, seedFile, layout.backendRoot), {
        file: seedRel,
      });
      next = replaceBlock(next, GEN_BLOCKS.SEED_CALLS.id, renderSeedCalls(ordered), { indent: '  ', file: seedRel });
      next = replaceBlock(next, GEN_BLOCKS.PERM_CODES.id, renderPermCodes(ordered), { indent: '  ', file: seedRel });
      if (next !== source) {
        plan.push({ path: seedRel, content: next, kind: 'seed', mode: 'patch' });
      }
    }
  }

  return result;
}
