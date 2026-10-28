/*
 * @file 生成清单 fw.gen.json（PRD-016 FR-16-03）
 * @description 生成器的唯一事实源：记录已生成模型、产物路径与需要接线的符号，使重跑幂等、
 *   接线可整块重建、门禁可做「清单 ↔ 产物 ↔ 接线」三方比对。
 *   落盘位置固定为后端应用根（不跟随 cwd），因此从仓库根或应用目录执行得到同一份清单。
 *   条目按 model 排序写出，保证同一输入产出逐字节相同的文件（可进版本库、diff 稳定）。
 * @author donttemo
 * @created 2026-10-22
 * @modified 2026-10-22 S4：新增 mergeArtifactHashes——部分范围生成（--only=backend/frontend/seed）
 *   只更新本次写过的产物指纹，未触碰的产物沿用旧指纹；否则一次局部重跑会把其余指纹清空，
 *   漂移检测退回「不知道」，用户手改的文件就此失去保护。
 * @module cli/gen
 * @since v0.8.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 清单文件名 */
export const MANIFEST_FILE = 'fw.gen.json';

/** 产物指纹（PRD-017 FR-17-14） */
export interface ArtifactHash {
  /**
   * 相对**后端应用根**（即 fw.gen.json 所在目录）的路径，`/` 分隔。
   * 基准必须与 cwd 无关：从仓库根或应用目录执行生成，得到的清单要能互相读懂；
   * 前端产物在后端根之外，用 `../admin-web/...` 表达。
   */
  path: string;
  /** 生成当时的 sha256（十六进制） */
  hash: string;
}

/**
 * 把绝对路径转成清单口径（相对后端应用根、`/` 分隔）
 * @param backendRoot 后端应用根（清单所在目录）
 * @param absoluteFile 产物绝对路径
 */
export function relativeArtifactPath(backendRoot: string, absoluteFile: string): string {
  return path.relative(backendRoot, absoluteFile).split(path.sep).join('/');
}

/** 单个模型的生成记录 */
export interface GenManifestEntry {
  /** 模型名（PascalCase，如 Product） */
  model: string;
  /** kebab 名（如 product） */
  kebab: string;
  /** 模块文件（相对后端应用根） */
  modulePath: string;
  /** 模块类名（如 ProductModule） */
  moduleClass: string;
  /** 种子文件（相对后端应用根） */
  seedPath: string;
  /** 种子导出函数名（如 seedProductPermissions） */
  seedExport: string;
  /** 该模型的四个权限码 */
  permissionCodes: string[];
  /** 最近一次生成日期 YYYY-MM-DD */
  updatedAt: string;
  /**
   * 生成当时的产物指纹。用于判断「用户改过没有」：
   * 缺失（老清单）时不做任何结论，绝不把「未知」当成「未改动」。
   */
  files?: ArtifactHash[];
}

/** 清单文件结构 */
export interface GenManifest {
  /** 结构版本（破坏性变更时递增，读到更高版本直接报错） */
  version: 1;
  /** 生成记录（按 model 升序） */
  entries: GenManifestEntry[];
}

/** 清单文件绝对路径 */
export function manifestPath(backendRoot: string): string {
  return path.join(backendRoot, MANIFEST_FILE);
}

/**
 * 读取清单（不存在时返回空清单，不抛错）
 * @param backendRoot 后端应用根
 */
export function readManifest(backendRoot: string): GenManifest {
  const file = manifestPath(backendRoot);
  if (!fs.existsSync(file)) return { version: 1, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${MANIFEST_FILE} 不是合法 JSON：${detail}（可删除该文件后重跑生成器重建）`);
  }
  const manifest = parsed as Partial<GenManifest>;
  if (manifest.version !== 1) {
    throw new Error(`${MANIFEST_FILE} 版本不支持：${String(manifest.version)}（当前支持 version=1）`);
  }
  if (!Array.isArray(manifest.entries)) {
    throw new Error(`${MANIFEST_FILE} 缺少 entries 数组（可删除该文件后重跑生成器重建）`);
  }
  return { version: 1, entries: manifest.entries };
}

/**
 * 写入清单（排序后落盘，末尾带换行）
 * @param backendRoot 后端应用根
 * @param manifest 清单
 */
export function writeManifest(backendRoot: string, manifest: GenManifest): void {
  const sorted: GenManifest = {
    version: 1,
    entries: [...manifest.entries].sort((a, b) => a.model.localeCompare(b.model)),
  };
  fs.writeFileSync(manifestPath(backendRoot), `${JSON.stringify(sorted, null, 2)}\n`, 'utf8');
}

/**
 * 合并条目（同 model 覆盖，结果按 model 升序）
 * @param manifest 现有清单
 * @param entries 新增 / 更新的条目
 * @returns 新清单（不修改入参）
 */
export function upsertEntries(manifest: GenManifest, entries: GenManifestEntry[]): GenManifest {
  const byModel = new Map(manifest.entries.map((entry) => [entry.model, entry]));
  for (const entry of entries) byModel.set(entry.model, entry);
  return { version: 1, entries: [...byModel.values()].sort((a, b) => a.model.localeCompare(b.model)) };
}

/**
 * 构造单个模型的清单条目
 * @param params 命名与路径信息（路径均为相对后端应用根、`/` 分隔）
 */
export function makeEntry(params: {
  model: string;
  kebab: string;
  modulePath: string;
  seedPath: string;
  updatedAt: string;
}): GenManifestEntry {
  return {
    model: params.model,
    kebab: params.kebab,
    modulePath: params.modulePath,
    moduleClass: `${params.model}Module`,
    seedPath: params.seedPath,
    seedExport: `seed${params.model}Permissions`,
    permissionCodes: ['create', 'read', 'update', 'delete'].map((action) => `${params.kebab}:${action}`),
    updatedAt: params.updatedAt,
  };
}

/** 计算文本指纹（sha256 hex） */
export function hashContent(content: string): string {
  return crypto.createHash('sha256').update(content, 'utf8').digest('hex');
}

/**
 * 计算文件指纹
 * @param file 绝对路径
 * @returns 指纹；文件不存在返回 null
 */
export function hashFile(file: string): string | null {
  if (!fs.existsSync(file)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/** 单个产物的漂移状态 */
export interface DriftItem {
  /** 相对后端应用根 */
  path: string;
  /** unchanged=没动过；modified=用户改过；missing=文件被删；untracked=老清单无指纹 */
  status: 'unchanged' | 'modified' | 'missing' | 'untracked';
}

/**
 * 合并产物指纹（部分范围生成用）
 * @description 只替换本次**确实写过**的路径，其余旧指纹原样保留：
 *   `--only=backend` 不会把上次生成的前端产物指纹抹掉，反之亦然。
 *   按 path 排序输出，保证同一输入逐字节相同（清单可进版本库、diff 稳定）。
 * @param previous 上一次记录的指纹（老清单可能没有）
 * @param updates 本次写入后重新计算的指纹
 * @returns 合并结果（新数组，不修改入参）
 */
export function mergeArtifactHashes(
  previous: ArtifactHash[] | undefined,
  updates: ArtifactHash[],
): ArtifactHash[] {
  const byPath = new Map<string, ArtifactHash>();
  for (const item of previous ?? []) byPath.set(item.path, item);
  for (const item of updates) byPath.set(item.path, item);
  return [...byPath.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** 单个模型的漂移结果 */
export interface ModelDrift {
  model: string;
  files: DriftItem[];
  /** 用户改过或删除的文件数（>0 说明重新生成不会更新它们） */
  affected: number;
}

/**
 * 检测生成物漂移（PRD-017 FR-17-14）
 * @description 对比清单里记录的指纹与磁盘现状。**没有指纹的老清单一律标 untracked**，
 *   不做「未改动」的推断——宁可说不知道，也不能让用户以为安全。
 * @param backendRoot 后端应用根（清单内路径相对它，与生成时的 cwd 无关）
 * @param entries 清单条目
 */
export function checkArtifactDrift(backendRoot: string, entries: GenManifestEntry[]): ModelDrift[] {
  return entries.map((entry) => {
    const files: DriftItem[] = (entry.files ?? []).map((artifact) => {
      const absolute = path.resolve(backendRoot, artifact.path);
      const current = hashFile(absolute);
      if (current === null) return { path: artifact.path, status: 'missing' as const };
      return { path: artifact.path, status: current === artifact.hash ? ('unchanged' as const) : ('modified' as const) };
    });
    return {
      model: entry.model,
      files,
      affected: files.filter((file) => file.status === 'modified' || file.status === 'missing').length,
    };
  });
}
