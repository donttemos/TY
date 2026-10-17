/*
 * @file S3 客户端构造（懒加载 @aws-sdk/client-s3）
 * @description 仅在 STORAGE_DRIVER=s3 且未注入自定义命令工厂时经动态 import 加载官方 SDK，
 *   local 驱动下 SDK 不进入依赖图（沿用 @fw/cache ioredis 的 optional peer 先例，ADR-0015）。
 *   客户端与命令类型以本文件的最小结构接口描述，框架导出面不泄漏 SDK 类型。
 *   测试注入 FakeS3CommandFactory + FakeS3Client，不需要真实 SDK。
 * @author donttemo
 * @created 2026-10-16
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-02）：裸抛迁移至 BizError 统一码（ADR-0025 三类治理）
 * @module @fw/storage
 */

import { BizError, ErrorCode } from '@fw/core';

/** S3 命令最小结构（官方 SDK 的 XxxCommand 实例天然满足；测试用 fake 实现） */
export interface S3CommandLike {
  /** 命令名（如 PutObjectCommand），fake 客户端按此分发 */
  readonly name?: string;
  /** 命令输入（Bucket/Key/Body/ContentType 等） */
  readonly input: unknown;
}

/** S3 客户端最小结构 */
export interface S3ClientLike {
  /** 发送命令并返回结果（GetObject 的 Body / HeadObject 的 ContentLength 等） */
  send(command: S3CommandLike): Promise<unknown>;
}

/** 命令工厂：输入对象 → SDK 命令实例（测试可注入 fake） */
export interface S3CommandFactory {
  putObject(input: Record<string, unknown>): S3CommandLike;
  getObject(input: Record<string, unknown>): S3CommandLike;
  deleteObject(input: Record<string, unknown>): S3CommandLike;
  headObject(input: Record<string, unknown>): S3CommandLike;
}

/** S3 客户端构造入参 */
export interface S3ClientOptions {
  endpoint?: string;
  region: string;
  bucket: string;
  accessKeyId?: string;
  secretAccessKey?: string;
  forcePathStyle: boolean;
}

/** 官方 SDK 模块形状（只声明用到的成员，动态 import 后按此收窄） */
interface S3SdkModule {
  S3Client: new (config: Record<string, unknown>) => S3ClientLike;
  PutObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  GetObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  DeleteObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
  HeadObjectCommand: new (input: Record<string, unknown>) => S3CommandLike;
}

/** 官方 SDK 命令工厂实现（动态加载；SDK 未安装时给出可执行的安装提示） */
class AwsSdkCommandFactory implements S3CommandFactory {
  constructor(private readonly sdk: S3SdkModule) {}

  putObject(input: Record<string, unknown>): S3CommandLike {
    return new this.sdk.PutObjectCommand(input);
  }
  getObject(input: Record<string, unknown>): S3CommandLike {
    return new this.sdk.GetObjectCommand(input);
  }
  deleteObject(input: Record<string, unknown>): S3CommandLike {
    return new this.sdk.DeleteObjectCommand(input);
  }
  headObject(input: Record<string, unknown>): S3CommandLike {
    return new this.sdk.HeadObjectCommand(input);
  }
}

/**
 * 创建 S3 客户端与命令工厂（官方 SDK 路径）
 *
 * 说明：包名经变量传入动态 import——SDK 是 optional peer，本包 tsc 时不解析其类型，
 * 返回对象按 S3SdkModule 最小形状收窄；未安装时启动即失败并给出安装命令。
 * @param options 客户端配置
 */
export async function createS3Client(options: S3ClientOptions): Promise<{ client: S3ClientLike; commands: S3CommandFactory }> {
  const packageName = '@aws-sdk/client-s3';
  let mod: unknown;
  try {
    mod = await import(/* webpackIgnore: true */ packageName);
  } catch {
    throw new BizError(
      ErrorCode.DEPENDENCY_UNAVAILABLE,
      'STORAGE_DRIVER=s3 需要安装 S3 SDK：pnpm add @aws-sdk/client-s3（optional peer，local 驱动无需安装）',
    );
  }
  const sdk = mod as Partial<S3SdkModule>;
  if (!sdk.S3Client || !sdk.PutObjectCommand || !sdk.GetObjectCommand || !sdk.DeleteObjectCommand || !sdk.HeadObjectCommand) {
    throw new BizError(ErrorCode.DEPENDENCY_UNAVAILABLE, '@aws-sdk/client-s3 版本不满足最小形状要求（需 v3：S3Client 与四类 Object Command）');
  }
  const client = new sdk.S3Client({
    region: options.region,
    ...(options.endpoint ? { endpoint: options.endpoint } : {}),
    ...(options.accessKeyId && options.secretAccessKey
      ? { credentials: { accessKeyId: options.accessKeyId, secretAccessKey: options.secretAccessKey } }
      : {}),
    forcePathStyle: options.forcePathStyle,
  });
  return { client, commands: new AwsSdkCommandFactory(sdk as S3SdkModule) };
}

/**
 * 把 GetObject 返回的 Body 收敛为 Buffer（逐字节保真，不改写）：
 * Buffer 直返；Node Readable（asyncIterable）与 Web ReadableStream（getReader）分路聚合。
 * @param body SDK 返回体
 */
export async function bodyToBuffer(body: unknown): Promise<Buffer> {
  if (body === undefined || body === null) throw new BizError(ErrorCode.INTERNAL, 'S3 GetObject 返回空 Body');
  if (Buffer.isBuffer(body)) return body;
  if (typeof body !== 'object') throw new BizError(ErrorCode.INTERNAL, `S3 GetObject 返回了不支持的 Body 类型：${Object.prototype.toString.call(body)}`);
  const candidate = body as { getReader?: () => { read: () => Promise<{ done: boolean; value?: Uint8Array }> } };
  if (Symbol.asyncIterator in body) {
    const chunks: Buffer[] = [];
    for await (const chunk of body as AsyncIterable<Uint8Array>) {
      chunks.push(Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
  if (typeof candidate.getReader === 'function') {
    const reader = candidate.getReader();
    const chunks: Buffer[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks);
  }
  throw new BizError(ErrorCode.INTERNAL, `S3 GetObject 返回了不支持的 Body 类型：${Object.prototype.toString.call(body)}`);
}
