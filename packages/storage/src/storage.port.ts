/*
 * @file 文件存储端口（StoragePort）
 * @description 框架最底层的对象/文件存储抽象（PRD-010 E-09）：local 与 s3 两种驱动实现同一端口，
 *   业务与 StorageService 只依赖本端口，切换驱动只改 STORAGE_DRIVER 配置，业务代码 diff = 0
 *   （与 @fw/cache 的 CacheStorePort 同构，ADR-0015）。
 *   本文件不得出现任何驱动特有类型（fs / @aws-sdk/client-s3）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

import type { StorageDriverName } from './types.js';

/** 对象元信息（stat 返回；不存在时为 null） */
export interface StorageObjectMeta {
  /** 存储 key（端口内唯一；形如 `<yyyyMM>/<uuid><ext>`，由 StorageService 生成） */
  key: string;
  /** 字节数 */
  size: number;
  /** 内容类型（驱动未记录时缺省） */
  contentType?: string;
}

/**
 * 存储端口：全部方法均为 Promise（local 同步实现也返回 Promise，保证行为一致）
 *
 * 约定：
 * - key 一律为相对路径（禁止绝对路径 / `..` 穿越段 / 反斜杠），非法 key 由驱动统一拒绝；
 * - `delete` 幂等：对象不存在不报错；
 * - `get` / `stat` 对不存在的对象分别抛 404 语义错误 / 返回 null（不泄露存在性差异由调用方处理）；
 * - 二进制语义：data 一律 Buffer，驱动不得改写字节（N-02 逐字节同构纪律）。
 */
export interface StoragePort {
  /** 驱动名 */
  readonly kind: StorageDriverName;
  /** 写入对象（覆盖写） */
  put(key: string, data: Buffer, contentType?: string): Promise<void>;
  /** 读取对象；不存在抛 404 语义 BizError */
  get(key: string): Promise<Buffer>;
  /** 删除对象（幂等） */
  delete(key: string): Promise<void>;
  /** 对象是否存在 */
  exists(key: string): Promise<boolean>;
  /** 读取元信息；不存在返回 null */
  stat(key: string): Promise<StorageObjectMeta | null>;
  /** 可用性探测 */
  ping(): Promise<boolean>;
  /** 释放连接（优雅停机；local 驱动为空操作） */
  close(): Promise<void>;
}
