/*
 * @file 审查素材收集（PRD-017 FR-17-23）
 * @description 只收 `fw.gen.json` 记录的产物 + 两个接线文件，不扫整个仓库：
 *   - 范围可控（token 与费用可预期），也避免把业务密钥、.env 之类发出去；
 *   - 文件不存在、单文件过大、总量超限都**跳过并说明原因**，不截断半截代码让模型下错结论。
 * @author donttemo
 * @created 2026-10-22
 * @modified 2026-10-22 无指纹的老清单回退到「生成器约定」的后端六文件 + 种子，
 *   否则 S4 之前生成的项目第一次审查看不到任何产物。
 * @module cli/review
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type { GenManifestEntry } from '../gen/manifest.js';

/** 接线文件（相对后端应用根）：生成器托管、不在清单指纹里，但审查必须看 */
const WIRING_FILES = ['src/app.module.ts', 'prisma/seed.ts'];

/** 后端产物的固定文件后缀（生成器约定，见 render.ts） */
const BACKEND_SUFFIXES = ['entity', 'repository', 'dto', 'service', 'controller', 'module'];

/**
 * 老清单的回退路径（没有指纹时用）
 * @description 指纹是 S4 才加的，之前生成的清单只有 modulePath / seedPath。
 *   按生成器约定补齐后端六文件，否则真实项目第一次审查只能看到两个接线文件。
 *   前端路径因布局而异（`../admin-web` / 同目录），没有指纹时不做猜测。
 * @param entry 清单条目
 */
export function fallbackArtifactPaths(entry: GenManifestEntry): string[] {
  const dir = entry.modulePath.includes('/')
    ? entry.modulePath.slice(0, entry.modulePath.lastIndexOf('/'))
    : 'src/modules';
  return [
    ...BACKEND_SUFFIXES.map((suffix) => `${dir}/${entry.kebab}.${suffix}.ts`),
    entry.seedPath,
  ];
}

/** 单个待审文件 */
export interface ReviewFile {
  /** 相对后端应用根 */
  path: string;
  /** 文件正文 */
  content: string;
  /** 字节数 */
  bytes: number;
  /** 归属模型（PascalCase）；共享接线文件为 shared */
  model?: string;
}

/** 被跳过的文件与原因 */
export interface SkippedFile {
  path: string;
  reason: string;
}

/** 收集选项 */
export interface CollectOptions {
  /** 后端应用根（清单与产物路径的基准） */
  backendRoot: string;
  /** 清单条目 */
  entries: GenManifestEntry[];
  /** 只审查这些模型（PascalCase 或 kebab，大小写不敏感）；空 = 全部 */
  models?: string[];
  /** 文件数上限 */
  maxFiles?: number;
  /** 单文件字节上限 */
  maxBytesPerFile?: number;
  /** 总字节上限 */
  maxTotalBytes?: number;
}

/** 收集结果 */
export interface CollectResult {
  /** 待审文件（确定性顺序） */
  files: ReviewFile[];
  /** 跳过清单 */
  skipped: SkippedFile[];
  /** 实际涉及的模型名（PascalCase） */
  models: string[];
}

/** 默认上限：40 个文件 / 64KB 单文件 / 256KB 总量（约 6~8 万 token 的代码量） */
export const DEFAULT_LIMITS = {
  maxFiles: 40,
  maxBytesPerFile: 64 * 1024,
  maxTotalBytes: 256 * 1024,
} as const;

/**
 * 按模型过滤清单条目
 * @param entries 清单条目
 * @param models 模型名（PascalCase 或 kebab，大小写不敏感）
 * @returns 命中的条目
 * @throws 指定了不存在的模型时抛错并列出可用模型
 */
export function selectEntries(entries: GenManifestEntry[], models?: string[]): GenManifestEntry[] {
  const wanted = (models ?? []).map((item) => item.trim()).filter(Boolean);
  if (wanted.length === 0) return entries;

  const matched: GenManifestEntry[] = [];
  for (const name of wanted) {
    const lower = name.toLowerCase();
    const hit = entries.find(
      (entry) => entry.model.toLowerCase() === lower || entry.kebab.toLowerCase() === lower,
    );
    if (!hit) {
      throw new Error(`清单里没有模型 ${name}（可用：${entries.map((entry) => entry.model).join(' / ')}）`);
    }
    if (!matched.includes(hit)) matched.push(hit);
  }
  return matched;
}

/**
 * 收集待审文件
 * @param options 选项
 * @returns 文件、跳过项与实际模型
 */
export function collectReviewFiles(options: CollectOptions): CollectResult {
  const maxFiles = options.maxFiles ?? DEFAULT_LIMITS.maxFiles;
  const maxBytesPerFile = options.maxBytesPerFile ?? DEFAULT_LIMITS.maxBytesPerFile;
  const maxTotalBytes = options.maxTotalBytes ?? DEFAULT_LIMITS.maxTotalBytes;

  const selected = selectEntries(options.entries, options.models);
  const files: ReviewFile[] = [];
  const skipped: SkippedFile[] = [];
  const seen = new Set<string>();
  let totalBytes = 0;

  /** 读一个文件（各种越界都转成 skipped，不中断整次审查） */
  const take = (relPath: string, model?: string): void => {
    if (seen.has(relPath)) return;
    seen.add(relPath);

    const absolute = path.resolve(options.backendRoot, relPath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) {
      skipped.push({ path: relPath, reason: '文件不存在' });
      return;
    }
    const bytes = fs.statSync(absolute).size;
    if (bytes > maxBytesPerFile) {
      skipped.push({ path: relPath, reason: `单文件 ${Math.ceil(bytes / 1024)}KB 超过上限 ${Math.ceil(maxBytesPerFile / 1024)}KB` });
      return;
    }
    const content = fs.readFileSync(absolute, 'utf8');
    if (content.includes('\u0000')) {
      skipped.push({ path: relPath, reason: '疑似二进制文件' });
      return;
    }
    if (files.length >= maxFiles) {
      skipped.push({ path: relPath, reason: `文件数超过上限 ${maxFiles}` });
      return;
    }
    if (totalBytes + bytes > maxTotalBytes) {
      skipped.push({ path: relPath, reason: `总量超过上限 ${Math.ceil(maxTotalBytes / 1024)}KB` });
      return;
    }
    files.push({ path: relPath, content, bytes, ...(model === undefined ? {} : { model }) });
    totalBytes += bytes;
  };

  for (const entry of selected) {
    const paths = (entry.files ?? []).length > 0 ? (entry.files ?? []).map((artifact) => artifact.path) : fallbackArtifactPaths(entry);
    for (const artifactPath of paths) take(artifactPath, entry.model);
  }
  // 接线文件不属于任何模型，单独归为 shared：分组审查时它们需要和所有模型一起看
  for (const wiring of WIRING_FILES) take(wiring, 'shared');

  return { files, skipped, models: selected.map((entry) => entry.model) };
}
