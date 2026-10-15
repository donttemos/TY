/*
 * @file Redis Cluster 连接构造单测（M10 E-06）
 * @description 覆盖 parseClusterNodes 的解析面（scheme / 凭据 / 多节点 / 非逗号）与
 *   createBullConnection 的 Cluster 分支（多节点走 ioredis.Cluster、单节点走默认构造）。
 *   真实集群行为由真机实测覆盖（docs/94 系列）。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/queue
 */
import { describe, expect, it, vi } from 'vitest';
import { createBullConnection, parseClusterNodes } from '../drivers/bullmq-client.js';

describe('parseClusterNodes', () => {
  it('非逗号串返回 null（单实例路径）', () => {
    expect(parseClusterNodes('redis://127.0.0.1:6379')).toBeNull();
    expect(parseClusterNodes('127.0.0.1:6379')).toBeNull();
  });

  it('多节点解析：剥 scheme 与凭据、缺省端口 6379', () => {
    expect(
      parseClusterNodes('redis://:pwd@127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002'),
    ).toEqual([
      { host: '127.0.0.1', port: 7000 },
      { host: '127.0.0.1', port: 7001 },
      { host: '127.0.0.1', port: 7002 },
    ]);
    expect(parseClusterNodes('127.0.0.1:7000, host2 ,h3')).toEqual([
      { host: '127.0.0.1', port: 7000 },
      { host: 'host2', port: 6379 },
      { host: 'h3', port: 6379 },
    ]);
  });
});

describe('createBullConnection Cluster 分支', () => {
  it('多节点 URL 走 ioredis.Cluster（maxRetriesPerRequest=null 传入 redisOptions）', async () => {
    const clusterCtor = vi.fn(function (this: unknown) {
      return {
        on: vi.fn(),
        // bullmq 驱动在 start 时才用连接，此处仅验证构造参数
      };
    });
    vi.doMock('ioredis', () => ({
      default: vi.fn(function () {
        throw new Error('单实例构造不应被调用');
      }),
      Cluster: clusterCtor,
    }));
    const mod = await import('../drivers/bullmq-client.js');
    await mod.createBullConnection('127.0.0.1:7000,127.0.0.1:7001,127.0.0.1:7002');
    expect(clusterCtor).toHaveBeenCalledTimes(1);
    const [nodes, options] = clusterCtor.mock.calls[0] as unknown as [
      Array<{ host: string; port: number }>,
      { redisOptions: { maxRetriesPerRequest: number | null } },
    ];
    expect(nodes).toHaveLength(3);
    expect(options.redisOptions.maxRetriesPerRequest).toBeNull();
    vi.doUnmock('ioredis');
  });
});
