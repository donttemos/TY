/*
 * @file @fw/storage 类型定义
 * @description 驱动枚举、运行时配置与上传输入/输出类型（PRD-010 E-09）。
 * @author donttemo
 * @created 2026-10-16
 * @module @fw/storage
 */

/** 存储驱动可选值（与 @fw/config 的 STORAGE_DRIVER_VALUES 一致） */
export type StorageDriverName = 'local' | 's3';

/** 运行时配置（StorageModule.forRoot 按 env 构建） */
export interface StorageRuntimeOptions {
  /** 驱动名 */
  driver: StorageDriverName;
  /** local 驱动存储根目录（默认 ./uploads） */
  localRoot: string;
  /** s3 驱动：S3 兼容端点（MinIO / COS / OSS 等；缺省走 AWS 原生端点） */
  s3Endpoint?: string;
  /** s3 驱动：区域 */
  s3Region?: string;
  /** s3 驱动：桶名（s3 驱动必填，缺失启动即失败） */
  s3Bucket?: string;
  /** s3 驱动：访问密钥 ID */
  s3AccessKeyId?: string;
  /** s3 驱动：访问密钥（敏感，不入日志） */
  s3SecretAccessKey?: string;
  /** s3 驱动：path-style 寻址（MinIO 默认 true；AWS 原生为 false） */
  s3ForcePathStyle: boolean;
  /** 单文件大小上限（字节，默认 20MB，与任务中心产物口径一致） */
  maxBytes: number;
  /** 扩展名白名单（小写含点，默认收紧清单） */
  allowedExts: readonly string[];
}

/** 上传输入（multer 文件对象的形状子集，测试可传桩） */
export interface StorageUploadInput {
  /** 文件内容 */
  buffer: Buffer;
  /** 原始文件名（仅用于扩展名识别与元数据展示；不参与存储 key） */
  originalName: string;
  /** MIME 类型（元数据展示与下载回传） */
  mimeType?: string;
}

/** 保存结果（业务落库用；id/时间戳由业务表自管） */
export interface StoredFile {
  /** 存储 key（`<yyyyMM>/<uuid><ext>`；不透传用户输入，天然免疫路径穿越） */
  key: string;
  /** 原始文件名 */
  originalName: string;
  /** MIME 类型 */
  mimeType: string;
  /** 字节数 */
  size: number;
}
