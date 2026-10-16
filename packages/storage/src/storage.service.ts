/*
 * @file 存储门面服务（校验 + key 生成 + 端口代理）
 * @description PRD-010 E-09 NFR「上传类型/大小白名单校验默认收紧」的落地层：业务与控制器只注入本服务，
 *   校验不过抛 400 语义 BizError；存储 key 一律由本服务生成（`<yyyyMM>/<uuid><ext>`，
 *   不透传用户输入，天然免疫路径穿越）。读/删/探测直接代理端口。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

import { Inject, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { BizError, ErrorCode } from '@fw/core';
import { assertKey, DEFAULT_ALLOWED_EXTS, DEFAULT_MAX_BYTES, extOf } from './key.js';
import type { StoragePort } from './storage.port.js';
import { STORAGE_PORT } from './tokens.js';
import type { StorageObjectMeta } from './storage.port.js';
import type { StorageRuntimeOptions, StorageUploadInput, StoredFile } from './types.js';
import { STORAGE_OPTIONS } from './tokens.js';

/**
 * 存储门面服务
 */
@Injectable()
export class StorageService {
  constructor(
    @Inject(STORAGE_PORT) private readonly port: StoragePort,
    @Inject(STORAGE_OPTIONS) private readonly options: StorageRuntimeOptions,
  ) {}

  /** 当前生效的大小上限（字节） */
  get maxBytes(): number {
    return this.options.maxBytes;
  }

  /** 当前生效的扩展名白名单 */
  get allowedExts(): readonly string[] {
    return this.options.allowedExts;
  }

  /**
   * 上传校验：大小与扩展名白名单（默认收紧；超限/越权类型一律 400，不静默截断）
   * @param input 上传输入
   */
  validate(input: Pick<StorageUploadInput, 'buffer' | 'originalName'>): void {
    if (!input.buffer || input.buffer.length === 0) {
      throw new BizError(ErrorCode.BAD_REQUEST, '上传内容为空');
    }
    if (input.buffer.length > this.options.maxBytes) {
      throw new BizError(ErrorCode.BAD_REQUEST, `文件超出大小上限（${Math.floor(this.options.maxBytes / 1024 / 1024)}MB）`);
    }
    const ext = extOf(input.originalName);
    if (!this.options.allowedExts.includes(ext)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `不支持的文件类型：${ext || '(无扩展名)'}`);
    }
  }

  /**
   * 保存上传文件：校验 → 生成 key → 写入端口
   * @param input 上传输入
   */
  async save(input: StorageUploadInput): Promise<StoredFile> {
    this.validate(input);
    const ext = extOf(input.originalName);
    const month = new Date().toISOString().slice(0, 7).replace('-', '');
    const key = `${month}/${randomUUID()}${ext}`;
    await this.port.put(key, input.buffer, input.mimeType);
    return {
      key,
      originalName: input.originalName,
      mimeType: input.mimeType ?? 'application/octet-stream',
      size: input.buffer.length,
    };
  }

  /** 读取对象内容（key 合法性由端口校验） */
  async read(key: string): Promise<Buffer> {
    return this.port.get(key);
  }

  /** 读取元信息；不存在返回 null */
  async meta(key: string): Promise<StorageObjectMeta | null> {
    return this.port.stat(key);
  }

  /** 删除对象（幂等） */
  async remove(key: string): Promise<void> {
    await this.port.delete(key);
  }
}

/** StorageService 构造缺省（供测试与无 Nest 场景复用） */
export const STORAGE_SERVICE_DEFAULTS = {
  maxBytes: DEFAULT_MAX_BYTES,
  allowedExts: DEFAULT_ALLOWED_EXTS,
} as const;
