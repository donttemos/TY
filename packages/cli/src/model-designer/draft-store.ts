/*
 * @file 草案本地持久化（PRD-017 FR-17-24）
 * @description 生成一份草案要十几到几十秒，刷新一次就丢是不可接受的。
 *   存在用户目录 `~/.fw/drafts/<项目哈希>.json`（0700/0600），按项目隔离；
 *   只缓存**最近一份**并带 revision/savedAt，不做版本库——真正的版本仍在 schema 的 git 历史里。
 *   文件损坏按「没有缓存」处理并给出说明，绝不因为缓存坏了打不开界面。
 * @author donttemo
 * @created 2026-10-27
 * @module cli/model-designer
 * @since v0.8.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 缓存文件结构 */
interface DraftFile {
  version: 1;
  savedAt: string;
  draft: Record<string, unknown>;
}

/** 缓存上限（超过说明模型输出异常，拒绝写入而不是撑爆磁盘） */
export const MAX_DRAFT_BYTES = 512 * 1024;

/** 默认缓存路径（FW_STUDIO_DRAFT_FILE 可覆盖，测试用） */
export function draftFilePath(projectRoot: string, env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.FW_STUDIO_DRAFT_FILE ?? '').trim();
  if (override !== '') return path.resolve(override);
  const normalized = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
  const key = crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
  return path.join(os.homedir(), '.fw', 'drafts', `${key}.json`);
}

/** 读取结果 */
export interface SavedDraft {
  savedAt: string;
  draft: Record<string, unknown>;
}

/**
 * 读取最近一份草案
 * @param file 文件路径
 * @returns 草案或 null（不存在/损坏都返回 null，损坏时带 error）
 */
export function readSavedDraft(file: string): { saved: SavedDraft | null; error?: string } {
  if (!fs.existsSync(file)) return { saved: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<DraftFile>;
    if (parsed.version !== 1 || typeof parsed.draft !== 'object' || parsed.draft === null) {
      return { saved: null, error: '缓存格式不认识（可清空后重新生成）' };
    }
    return {
      saved: { savedAt: String(parsed.savedAt ?? ''), draft: parsed.draft as Record<string, unknown> },
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { saved: null, error: `缓存无法解析：${detail}（可清空后重新生成）` };
  }
}

/**
 * 保存草案（覆盖最近一份）
 * @param draft 已校验草案
 * @param file 文件路径
 * @returns 保存时间
 */
export function saveDraft(draft: Record<string, unknown>, file: string): string {
  // 只取一次时间：返回值与文件内容必须一致，否则界面显示的时间会对不上
  const savedAt = new Date().toISOString();
  const payload = JSON.stringify({ version: 1, savedAt, draft }, null, 2);
  if (Buffer.byteLength(payload, 'utf8') > MAX_DRAFT_BYTES) {
    throw new Error(`草案过大（超过 ${Math.round(MAX_DRAFT_BYTES / 1024)}KB），未写入缓存`);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(`${file}.tmp`, payload, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(`${file}.tmp`, file); // 原子替换：写到一半断电不会留下半个 JSON
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上只影响只读位，尽力而为
  }
  return savedAt;
}

/**
 * 清空缓存
 * @param file 文件路径
 * @returns 是否真的删除了文件
 */
export function clearSavedDraft(file: string): boolean {
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file, { force: true });
  return true;
}
