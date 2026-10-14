/*
 * @file DB 层链路追踪测试
 * @description 验证 M8 T-M8-06（PRD-008 FR-07）：$allOperations 漏斗内的 DB span——
 *   span 名含 model.operation、CLIENT 类型、属性记录 db.system/db.operation/db.collection.name、
 *   查询耗时；查询抛异常时记 ERROR；未注册 SDK 时退化为非记录 span 且不影响返回值与慢查询告警。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/db
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { SpanKind, SpanStatusCode } from '@opentelemetry/api';
import * as sdk from '@opentelemetry/sdk-node';
import { withSlowQueryLog } from '../observability.js';
import type { PrismaClientLike } from '../types.js';

// 全局 tracer provider 单文件只注册一次（registerGlobal 先注册者胜）
const exporter = new sdk.node.InMemorySpanExporter();
const provider = new sdk.node.NodeTracerProvider({
  spanProcessors: [new sdk.node.SimpleSpanProcessor(exporter)],
});

beforeAll(() => {
  provider.register();
});

afterAll(async () => {
  await provider.shutdown();
});

type Middleware = (args: {
  model?: string;
  operation: string;
  args: unknown;
  query: (a: unknown) => Promise<unknown>;
}) => Promise<unknown>;

/** 记录 $extends 传入的 query 中间件 */
function makeCapturingClient() {
  let middleware: Middleware | undefined;
  const client = {
    testUser: {},
    $transaction: vi.fn(),
    $queryRaw: vi.fn(async () => []),
    $connect: vi.fn(),
    $disconnect: vi.fn(),
    $on: vi.fn(),
    $extends: vi.fn((ext: { query: { $allOperations: Middleware } }) => {
      middleware = ext.query.$allOperations;
      return client;
    }),
  } as unknown as PrismaClientLike;
  return { client, getMiddleware: () => middleware! };
}

/** 取最后一批 span */
function lastSpan() {
  const spans = exporter.getFinishedSpans();
  return spans[spans.length - 1];
}

describe('@fw/db · DB span 插桩（T-M8-06）', () => {
  it('查询产生 DB span：命名/类型/属性齐全', async () => {
    const { client, getMiddleware } = makeCapturingClient();
    withSlowQueryLog(client, 5000);
    const mw = getMiddleware();
    const result = await mw({ model: 'testUser', operation: 'findMany', args: { where: { id: 1 } }, query: async () => ['row'] });
    expect(result).toEqual(['row']);

    const span = lastSpan();
    expect(span.name).toBe('db.query testUser.findMany');
    expect(span.kind).toBe(SpanKind.CLIENT);
    expect(span.attributes['db.system']).toBe('prisma');
    expect(span.attributes['db.operation']).toBe('findMany');
    expect(span.attributes['db.collection.name']).toBe('testUser');
    expect(typeof span.attributes['db.query.duration_ms']).toBe('number');
    expect(span.status.code).toBe(SpanStatusCode.UNSET);
  });

  it('无 model 的操作（raw）span 名只含 operation', async () => {
    const { client, getMiddleware } = makeCapturingClient();
    withSlowQueryLog(client, 5000);
    const mw = getMiddleware();
    await mw({ operation: '$queryRaw', args: [], query: async () => [] });
    const span = lastSpan();
    expect(span.name).toBe('db.query $queryRaw');
    expect(span.attributes['db.collection.name']).toBeUndefined();
  });

  it('查询抛异常：span 记 ERROR 且异常原样上抛（慢查询告警不受影响）', async () => {
    const { client, getMiddleware } = makeCapturingClient();
    const onSlow = vi.fn();
    withSlowQueryLog(client, 5000, onSlow);
    const mw = getMiddleware();
    await expect(
      mw({
        model: 'testUser',
        operation: 'create',
        args: {},
        query: async () => {
          throw new Error('db-boom');
        },
      }),
    ).rejects.toThrow('db-boom');

    const span = lastSpan();
    expect(span.status.code).toBe(SpanStatusCode.ERROR);
    expect(span.status.message).toBe('db-boom');
    expect(span.events.some((event) => event.name === 'exception')).toBe(true);
    // 未超阈值：不触发慢查询告警
    expect(onSlow).not.toHaveBeenCalled();
  });
});
