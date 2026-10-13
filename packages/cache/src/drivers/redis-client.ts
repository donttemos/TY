/*
 * @file redis 客户端构造（懒加载 ioredis）
 * @description 仅在 CACHE_DRIVER=redis / redis-cluster 时经动态 import 加载 ioredis，
 *   memory 驱动下 ioredis 不进入依赖图（PRD-004 AC-001：小系统零 Redis 依赖）。
 *   ioredis 声明为 **optional peerDependency**：只用 memory 的项目不必安装它。
 *   客户端类型以本文件的最小接口 RedisClientLike 描述，避免框架层泄漏 ioredis 类型（ADR-0004）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/cache
 */

import { Logger } from '@fw/logger';
import type { CacheDriverName } from '../types.js';

const logger = Logger.for('cache.redis');

/** 框架使用到的 Redis 命令子集（ioredis 天然满足；测试用 fake 实现） */
export interface RedisClientLike {
  /** 读取单键，不存在返回 null */
  get(key: string): Promise<string | null>;
  /** SET 支持 `PX <ms>` 与 `NX` 选项 */
  set(key: string, value: string, ...args: Array<string | number>): Promise<unknown>;
  /** 删除若干键，返回删除数量 */
  del(...keys: string[]): Promise<number>;
  /** 判断存在，返回 1/0 */
  exists(key: string): Promise<number>;
  /** 设置毫秒级 TTL，返回 1/0 */
  pexpire(key: string, ms: number): Promise<number>;
  /** 批量读取 */
  mget(...keys: string[]): Promise<Array<string | null>>;
  /** 集合写入 */
  sadd(key: string, ...members: string[]): Promise<number>;
  /** 集合读取 */
  smembers(key: string): Promise<string[]>;
  /** 执行 Lua 脚本 */
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  /** 探测连通性 */
  ping(): Promise<string>;
  /** 关闭连接 */
  quit(): Promise<unknown>;
  /** 立即断开（quit 失败时兜底） */
  disconnect(): void;
  /** 当前库键数量（近似） */
  dbsize(): Promise<number>;
  /** 订阅事件（error 必须监听，否则未捕获事件会导致进程退出） */
  on(event: string, handler: (...args: unknown[]) => void): unknown;
}

/** ioredis 构造器结构（动态 import 后的最小依赖面） */
interface IoredisModule {
  default: IoredisCtor;
  Cluster: IoredisCtor;
}

/** ioredis 构造器结构 */
interface IoredisCtor {
  new (urlOrOptions: unknown, options?: Record<string, unknown>): RedisClientLike;
  Cluster?: unknown;
}

/** 单实例客户端选项：离线队列保留但重试上限 1 次，故障时快速失败进入降级 */
const COMMON_OPTIONS: Record<string, unknown> = {
  maxRetriesPerRequest: 1,
  connectTimeout: 3000,
  lazyConnect: false,
  enableReadyCheck: true,
};

/**
 * 按驱动名创建 Redis 客户端
 * @param driver 驱动名（redis / redis-cluster）
 * @param url 连接串：单实例 `redis://host:port`；集群为逗号分隔的 `host:port` 列表
 * @returns 客户端（已挂 error 监听，避免未捕获异常）
 * @throws Error 缺少连接串或未安装 ioredis
 */
export async function createRedisClient(driver: CacheDriverName, url: string | undefined): Promise<RedisClientLike> {
  if (!url) {
    throw new Error(`CACHE_DRIVER=${driver} 时必须配置 CACHE_URL（如 redis://127.0.0.1:6379）`);
  }
  let mod: IoredisModule;
  try {
    mod = (await import('ioredis')) as unknown as IoredisModule;
  } catch (cause) {
    throw new Error(`未安装 ioredis：CACHE_DRIVER=${driver} 需要 ioredis（pnpm add ioredis）。memory 驱动无需安装。`, { cause });
  }

  const client =
    driver === 'redis-cluster'
      ? new mod.Cluster(parseClusterNodes(url), { redisOptions: { ...COMMON_OPTIONS }, clusterRetryStrategy: () => 200 } as never)
      : new mod.default(url, { ...COMMON_OPTIONS });

  // ioredis 的 error 事件不消费会导致进程崩溃；此处降级为告警日志（观测指标由 CacheService 记录）
  client.on('error', (error) => {
    logger.warn('Redis 连接异常（缓存将按 CACHE_FAIL_OPEN 降级）', {
      driver,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  return client;
}

/**
 * 解析集群节点列表
 * @param url 逗号分隔的节点（`host:port` 或 `redis://host:port`）
 * @returns ioredis Cluster 节点数组
 */
export function parseClusterNodes(url: string): Array<{ host: string; port: number }> {
  return url
    .split(',')
    .map((node) => node.trim())
    .filter((node) => node.length > 0)
    .map((node) => {
      const cleaned = node.replace(/^rediss?:\/\//, '');
      const [host, port = '6379'] = cleaned.split(':');
      return { host, port: Number.parseInt(port, 10) };
    });
}
