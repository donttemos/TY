/*
 * @file transport Redis Cluster 连接构造单测（M10 E-06）
 * @description transport 的键操作全部单键（cluster 无 CROSSSLOT 风险），本文件验证
 *   连接构造分支：多节点走 ioredis.Cluster 且保留 maxRetriesPerRequest=2 的快速失败语义。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/transport
 */
import { describe, expect, it, vi } from 'vitest';
import { createRedisClient } from '../drivers/redis-client.js';

describe('transport createRedisClient Cluster 分支', () => {
  it('多节点 URL 走 ioredis.Cluster（快速失败语义保留）', async () => {
    const clusterCtor = vi.fn(function (this: unknown) {
      return { on: vi.fn() };
    });
    vi.doMock('ioredis', () => ({
      default: vi.fn(function () {
        throw new Error('单实例构造不应被调用');
      }),
      Cluster: clusterCtor,
    }));
    const mod = await import('../drivers/redis-client.js');
    await mod.createRedisClient('127.0.0.1:7000,127.0.0.1:7001');
    expect(clusterCtor).toHaveBeenCalledTimes(1);
    const [, options] = clusterCtor.mock.calls[0] as unknown as [
      Array<{ host: string; port: number }>,
      { redisOptions: { maxRetriesPerRequest: number } },
    ];
    expect(options.redisOptions.maxRetriesPerRequest).toBe(2);
    vi.doUnmock('ioredis');
  });
});
