/*
 * @file 存储 key 合法性与工具
 * @description 端口侧 key 卫兵：两个驱动共用同一套规则，非法 key 统一拒绝（不猜测、不静默修正）。
 *   key 形如 `202610/<uuid>.png`：段内只允许安全字符，禁止 `..`、反斜杠、绝对路径与空段。
 * @author donttemo
 * @created 2026-10-16
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module @fw/storage
 */

import { BizError, ErrorCode } from '@fw/core';

/** 单段合法字符：字母数字与 `-._`（uuid、扩展名、日期目录天然满足） */
const SEGMENT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** key 最大长度（s3 对象 key 上限 1024 字节，这里收紧到 512） */
export const MAX_KEY_LENGTH = 512;

/**
 * 校验存储 key：非法即抛错（BAD_REQUEST 语义）
 * @param key 待校验 key
 */
export function assertKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：长度必须在 1~${MAX_KEY_LENGTH} 之间`);
  }
  if (key.includes('\\')) {
    throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：禁止反斜杠（${JSON.stringify(key)}）`);
  }
  if (key.startsWith('/')) {
    throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：禁止绝对路径（${JSON.stringify(key)}）`);
  }
  const segments = key.split('/');
  for (const segment of segments) {
    if (segment.length === 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：存在空路径段（${JSON.stringify(key)}）`);
    }
    if (segment === '.' || segment === '..') {
      throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：禁止相对路径段（${JSON.stringify(key)}）`);
    }
    if (!SEGMENT_PATTERN.test(segment)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：路径段含不安全字符（${JSON.stringify(segment)}）`);
    }
  }
}

/**
 * 提取扩展名（小写含点；无扩展名返回空串）
 * @param fileName 文件名
 */
export function extOf(fileName: string): string {
  const base = fileName.split(/[\\/]/).pop() ?? '';
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return '';
  return base.slice(dot).toLowerCase();
}

/** 默认扩展名白名单（与 admin 模板既有清单一致，默认收紧、按需放宽） */
export const DEFAULT_ALLOWED_EXTS = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv', '.xlsx', '.docx', '.zip'] as const;

/** 默认大小上限：20MB（与任务中心产物口径一致） */
export const DEFAULT_MAX_BYTES = 20 * 1024 * 1024;
