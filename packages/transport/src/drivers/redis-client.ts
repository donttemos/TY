/*
 * @file redis 依赖的懒加载与连接构造
 * @description 仅在 TRANSPORT_DRIVER=redis 时经动态 import 加载 ioredis，in-process 驱动下
 *   不进入依赖图（PRD-008 FR-06：小系统/单体零 Redis 依赖）。ioredis 为 **optional peerDependency**，
 *   只用 in-process 的项目不必安装。客户端类型以本文件的最小结构接口描述，避免框架层泄漏 ioredis 类型。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { TransportUnavailableError } from '../errors.js';

/** Redis 客户端最小接口（ioredis 天然满足） */
export interface RedisLike {
  /** 列表头压入（请求入队 / 应答回传） */
  lpush(key: string, value: string): Promise<number>;
  /** 阻塞弹出（队尾；调用方等应答用） */
  blpop(key: string, timeoutSeconds: number): Promise<[string, string] | null>;
  /** 阻塞弹出（队头；处理方取请求用） */
  brpop(key: string, timeoutSeconds: number): Promise<[string, string] | null>;
  /** 删除键（调用方读到应答后清理） */
  del(key: string): Promise<number>;
  /** 设置过期（应答键安全网，防调用方异常退出后泄漏） */
  expire(key: string, seconds: number): Promise<number>;
  /** 发布事件到频道（M10 E-12 事件面；PUBLISH） */
  publish(channel: string, message: string): Promise<number>;
  /** 订阅频道（M10 E-12 事件面；订阅模式下该连接不可执行常规命令，故独立连接） */
  subscribe(channel: string): Promise<unknown>;
  /** 取消订阅频道（M10 E-12 事件面） */
  unsubscribe(channel: string): Promise<unknown>;
  /** 探测连通性 */
  ping(): Promise<string>;
  /** 优雅关闭 */
  quit(): Promise<unknown>;
  /** 立即断开（quit 失败兜底） */
  disconnect(): void;
  /** 事件订阅（error 必须监听，否则未捕获事件会导致进程退出） */
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

/** ioredis 模块结构 */
interface IoredisModule {
  default: new (urlOrOptions: unknown, options?: Record<string, unknown>) => RedisLike;
  /** ioredis.Cluster 构造器（M10 E-06：Redis Cluster 形态） */
  Cluster?: new (nodes: Array<{ host: string; port: number }>, options?: Record<string, unknown>) => RedisLike;
}

/** 解析多节点连接串（逗号分隔）→ 节点数组；非逗号串返回 null */
export function parseClusterNodes(url: string): Array<{ host: string; port: number }> | null {
  if (!url.includes(',')) return null;
  return url
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => {
      const stripped = part.replace(/^[a-z]+:\/\//i, '').replace(/^[^@]*@/, '');
      const host = stripped.includes(':') ? stripped.slice(0, stripped.lastIndexOf(':')) : stripped;
      const port = Number(stripped.slice(stripped.lastIndexOf(':') + 1)) || 6379;
      return { host, port };
    });
}

/** 缺连接串的可操作报错文案（createRedisClient 与驱动 start 校验共用） */
export const MISSING_REDIS_URL_MESSAGE =
  'TRANSPORT_DRIVER=redis 时必须配置 TRANSPORT_URL 或 CACHE_URL（如 redis://127.0.0.1:6379）';

/** 懒加载缓存：同一进程只解析一次 */
let ioredisModule: IoredisModule | undefined;

/**
 * 加载 ioredis（缺失时给出可操作提示）
 * @returns ioredis 模块最小结构
 * @throws TransportUnavailableError 未安装 ioredis
 */
export async function loadIoredis(): Promise<IoredisModule> {
  if (ioredisModule) return ioredisModule;
  try {
    ioredisModule = (await import('ioredis')) as unknown as IoredisModule;
    return ioredisModule;
  } catch (cause) {
    throw new TransportUnavailableError(
      '未安装 ioredis：TRANSPORT_DRIVER=redis 需要 ioredis（pnpm add ioredis）。in-process 驱动无需安装。',
      cause,
    );
  }
}

/**
 * 创建 Redis 客户端
 *
 * `maxRetriesPerRequest` 取有限值（2）：阻塞命令（BLPOP/BRPOP）在连接断开时不会无限重试，
 * 保证「Redis 不可达 → 快速失败」而非把调用方挂死（与 @fw/queue 的 bullmq 连接语义相反，
 * 那里阻塞命令由失速检测兜底，可以无限重试）。
 * @param url Redis 连接串
 * @returns Redis 客户端（已挂 error 监听）
 * @throws TransportUnavailableError 缺连接串或未安装 ioredis
 */
export async function createRedisClient(url: string | undefined): Promise<RedisLike> {
  if (!url) {
    throw new TransportUnavailableError(MISSING_REDIS_URL_MESSAGE);
  }
  const mod = await loadIoredis();
  // M10 E-06：多节点连接串（逗号分隔）→ Redis Cluster 客户端。transport 的键操作全部单键
  // （LPUSH/BLPOP/BRPOP/DEL/EXPIRE 各自独立），cluster 下无 CROSSSLOT 风险，无需 hash-tag。
  const nodes = parseClusterNodes(url);
  let client: RedisLike;
  if (nodes && mod.Cluster) {
    client = new mod.Cluster(nodes, {
      redisOptions: {
        maxRetriesPerRequest: 2,
        connectTimeout: 3000,
        enableReadyCheck: true,
      },
      clusterRetryStrategy: (times: number) => (times < 5 ? Math.min(times * 200, 1000) : null),
    });
  } else {
    client = new mod.default(url, {
      maxRetriesPerRequest: 2,
      connectTimeout: 3000,
      enableReadyCheck: true,
    });
  }
  client.on('error', () => {
    // 连接异常由调用超时 / 就绪探针反映；此处仅消费事件，避免未捕获异常导致进程退出
  });
  return client;
}
