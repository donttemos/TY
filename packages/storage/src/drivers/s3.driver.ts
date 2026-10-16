/*
 * @file s3 驱动：S3 兼容对象存储
 * @description STORAGE_PORT 的对象存储实现（PRD-010 E-09）：官方 @aws-sdk/client-s3 为 optional peer
 *   （懒加载，未安装且启用时启动即失败并提示安装命令，ADR-0015）；MinIO / COS / OSS 等 S3 兼容端点
 *   经 STORAGE_S3_ENDPOINT + FORCE_PATH_STYLE 接入。行为与 local 驱动逐字节同构（N-02 纪律）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

import { BizError, ErrorCode } from '@fw/core';
import { assertKey } from '../key.js';
import type { S3ClientLike, S3CommandFactory } from './s3-client.js';
import { bodyToBuffer } from './s3-client.js';
import type { StorageObjectMeta, StoragePort } from '../storage.port.js';
import type { StorageDriverName } from '../types.js';

/** S3 服务端「对象不存在」的错误形状（官方 SDK 抛 NotFound（name）或 404 状态码） */
function isNotFound(error: unknown): boolean {
  const candidate = error as { name?: string; $metadata?: { httpStatusCode?: number }; Code?: string; statusCode?: number };
  return (
    candidate?.name === 'NotFound' ||
    candidate?.name === 'NoSuchKey' ||
    candidate?.Code === 'NoSuchKey' ||
    candidate?.$metadata?.httpStatusCode === 404 ||
    candidate?.statusCode === 404
  );
}

/**
 * S3 对象存储驱动
 */
export class S3Storage implements StoragePort {
  readonly kind: StorageDriverName = 's3';

  /**
   * @param client S3 客户端（官方 SDK 实例或测试 fake）
   * @param commands 命令工厂
   * @param bucket 桶名
   */
  constructor(
    private readonly client: S3ClientLike,
    private readonly commands: S3CommandFactory,
    private readonly bucket: string,
  ) {}

  async put(key: string, data: Buffer, contentType?: string): Promise<void> {
    assertKey(key);
    await this.client.send(this.commands.putObject({ Bucket: this.bucket, Key: key, Body: data, ...(contentType ? { ContentType: contentType } : {}) }));
  }

  async get(key: string): Promise<Buffer> {
    assertKey(key);
    try {
      const result = (await this.client.send(this.commands.getObject({ Bucket: this.bucket, Key: key }))) as { Body?: unknown };
      return await bodyToBuffer(result?.Body);
    } catch (error) {
      if (isNotFound(error)) throw new BizError(ErrorCode.NOT_FOUND, '文件不存在或已删除');
      throw error;
    }
  }

  async delete(key: string): Promise<void> {
    assertKey(key);
    await this.client.send(this.commands.deleteObject({ Bucket: this.bucket, Key: key }));
  }

  async exists(key: string): Promise<boolean> {
    assertKey(key);
    try {
      await this.client.send(this.commands.headObject({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (error) {
      if (isNotFound(error)) return false;
      throw error;
    }
  }

  async stat(key: string): Promise<StorageObjectMeta | null> {
    assertKey(key);
    try {
      const result = (await this.client.send(this.commands.headObject({ Bucket: this.bucket, Key: key }))) as {
        ContentLength?: number;
        ContentType?: string;
      };
      return { key, size: result?.ContentLength ?? 0, ...(result?.ContentType ? { contentType: result.ContentType } : {}) };
    } catch (error) {
      if (isNotFound(error)) return null;
      throw error;
    }
  }

  async ping(): Promise<boolean> {
    // head 桶内一个必然不存在的探测 key：404 即「服务可达 + 鉴权通过」
    try {
      await this.client.send(this.commands.headObject({ Bucket: this.bucket, Key: 'fw-ping-probe' }));
      return true;
    } catch (error) {
      return isNotFound(error);
    }
  }

  async close(): Promise<void> {
    /* 官方 SDK 客户端无需显式销毁；连接由底层 agent 管理 */
  }
}
