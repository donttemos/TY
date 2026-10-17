/*
 * @file local 驱动：本地磁盘存储
 * @description STORAGE_PORT 的文件系统实现（PRD-010 E-09）：对象落 STORAGE_LOCAL_ROOT 之下，
 *   key 即相对路径。逐字节写盘（writeFile 不改写 Buffer），读盘逐字节返回（N-02 同构纪律）。
 *   越界防护：key 经 assertKey 校验后仍按「resolve 后必须落在 root 内」做最终防线。
 * @author donttemo
 * @created 2026-10-16
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module @fw/storage
 */

import { createReadStream } from 'node:fs';
import { mkdir, rm, stat, unlink, writeFile, readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { BizError, ErrorCode } from '@fw/core';
import { assertKey } from '../key.js';
import type { StorageObjectMeta, StoragePort } from '../storage.port.js';
import type { StorageDriverName } from '../types.js';

/**
 * 本地磁盘存储驱动
 */
export class LocalStorage implements StoragePort {
  readonly kind: StorageDriverName = 'local';

  /**
   * @param root 存储根目录（默认 ./uploads）
   */
  constructor(private readonly root: string) {}

  /** key → 磁盘绝对路径（含根内越界最终防线） */
  private resolve(key: string): string {
    assertKey(key);
    const abs = path.resolve(this.root, key);
    const base = path.resolve(this.root);
    if (abs !== base && !abs.startsWith(base + path.sep)) {
      throw new BizError(ErrorCode.BAD_REQUEST, `非法存储 key：解析后越出存储根目录（${JSON.stringify(key)}）`);
    }
    return abs;
  }

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    const abs = this.resolve(key);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, data);
    // contentType 对 local 驱动无持久化位：下载面由业务表的 mime 字段提供（与 admin 模板同构）
    void contentType;
  }

  async get(key: string): Promise<Buffer> {
    const abs = this.resolve(key);
    try {
      return await readFile(abs);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        throw new BizError(ErrorCode.NOT_FOUND, '文件不存在或已删除');
      }
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    const abs = this.resolve(key);
    await unlink(abs).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
    // 顺带清理空父目录（月份目录），失败不阻断（并发下他文件同目录属正常竞态）
    const dir = path.dirname(abs);
    if (dir !== path.resolve(this.root)) {
      await rm(dir, { recursive: false }).catch(() => undefined);
    }
  }

  async exists(key: string): Promise<boolean> {
    try {
      await access(this.resolve(key));
      return true;
    } catch {
      return false;
    }
  }

  async stat(key: string): Promise<StorageObjectMeta | null> {
    // 先出卫兵（非法 key 抛错而非静默 null），再进「不存在 → null」分支
    const abs = this.resolve(key);
    try {
      const info = await stat(abs);
      return { key, size: info.size };
    } catch {
      return null;
    }
  }

  async ping(): Promise<boolean> {
    // 根目录可创建即可用（惰性创建语义与 put 一致）
    try {
      await mkdir(this.root, { recursive: true });
      return true;
    } catch {
      return false;
    }
  }

  async close(): Promise<void> {
    /* 本地盘无连接可释放 */
  }

  /**
   * 打开读取流（下载面 StreamableFile 场景；端口主方法之外的 local 便利能力，
   * 仅 local 驱动提供，业务代码须按 StoragePort 编程时不得依赖）
   */
  openStream(key: string): Readable {
    return createReadStream(this.resolve(key));
  }
}
