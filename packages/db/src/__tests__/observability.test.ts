/*
 * @file 慢查询观测测试（TC-ORM-006）
 * @description 验证 $extends 中间件对超阈值查询输出 warn 日志（含 model/operation/耗时/SQL摘要/traceId），
 *   低于阈值不输出；createDbReadinessProbe 的 markConnected/check 语义。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { describe, it, expect, vi } from 'vitest';
import { withSlowQueryLog, createDbReadinessProbe, DEFAULT_SLOW_QUERY_MS } from '../observability.js';
import type { PrismaClientLike } from '../types.js';

/** 记录 $extends 传入的 query 中间件 */
function makeCapturingClient(rows: unknown[] = []) {
  let middleware: ((args: { model?: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) => Promise<unknown>) | undefined;
  const client = {
    testUser: {},
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async () => rows),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $on: vi.fn(),
    $extends: vi.fn((ext: { query: { $allOperations: typeof middleware } }) => {
      middleware = ext.query.$allOperations;
      return client;
    }),
  } as unknown as PrismaClientLike & { $extends: { mock: { calls: unknown[][] } } };
  return { client, getMiddleware: () => middleware };
}

describe('@fw/db · 慢查询告警（TC-ORM-006）', () => {
  it('超过阈值（默认500ms）触发 onSlow 回调', async () => {
    const { client, getMiddleware } = makeCapturingClient();
    const onSlow = vi.fn();
    withSlowQueryLog(client, 50, onSlow);
    const mw = getMiddleware()!;
    const slowQuery = () => new Promise((res) => setTimeout(() => res('ok'), 80));
    const result = await mw({ model: 'testUser', operation: 'findMany', args: {}, query: slowQuery });
    expect(result).toBe('ok');
    expect(onSlow).toHaveBeenCalledOnce();
    const info = onSlow.mock.calls[0][0];
    expect(info.model).toBe('testUser');
    expect(info.operation).toBe('findMany');
    expect(info.durationMs).toBeGreaterThanOrEqual(50);
    expect(info.sqlSummary).toBeTruthy();
    expect(typeof info.traceId).toBe('string');
  });

  it('低于阈值不触发回调且不拖慢结果', async () => {
    const { client, getMiddleware } = makeCapturingClient();
    const onSlow = vi.fn();
    withSlowQueryLog(client, 500, onSlow);
    const mw = getMiddleware()!;
    const result = await mw({ operation: 'findUnique', args: {}, query: async () => 'fast' });
    expect(result).toBe('fast');
    expect(onSlow).not.toHaveBeenCalled();
  });

  it('默认阈值为 500ms（PRD-002 FR-08）', () => {
    expect(DEFAULT_SLOW_QUERY_MS).toBe(500);
  });

  it('query 抛错时依然上报耗时（finally 语义）', async () => {
    const { client, getMiddleware } = makeCapturingClient();
    const onSlow = vi.fn();
    withSlowQueryLog(client, 10, onSlow);
    const mw = getMiddleware()!;
    // 延迟 30ms 后抛错：超阈值且走 finally 上报路径
    await expect(
      mw({
        operation: 'create',
        args: {},
        query: () =>
          new Promise((_, reject) => setTimeout(() => reject(new Error('db down')), 30)),
      }),
    ).rejects.toThrow('db down');
    expect(onSlow).toHaveBeenCalledOnce();
  });
});

describe('@fw/db · 就绪探针（TC-ORM-006 /ready 接入）', () => {
  it('未连接时 check=false，markConnected 后 true', async () => {
    const probe = createDbReadinessProbe('sqlite', 500);
    expect(await probe.check()).toBe(false);
    probe.markConnected();
    expect(await probe.check()).toBe(true);
    expect(probe.stats()).toEqual({ provider: 'sqlite', connected: true, slowQueryThresholdMs: 500 });
  });

  it('探针名为 db（/ready checks 键）', () => {
    expect(createDbReadinessProbe('postgresql', 300).name).toBe('db');
  });
});
