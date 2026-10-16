/*
 * @file 单测：前端错误上报端点（M10/E-17）
 * @description 直接实例化 ClientErrorsController（不经 HTTP 层）验证摄取契约：合法信封归一化
 *   （stack/resource/traceId 可空）、reports 非数组/空数组/超单批上限（10）拒收、app 非法拒收、
 *   字段级错误一次回齐（details 带 reports[i].field 定位）；服务侧验证逐条 error 级结构化日志
 *   与进程内计数（received/total 累计、bySource 分布）。观测旁路语义：ingest 不抛业务异常。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/client-errors
 */
import 'reflect-metadata';
import { afterEach, describe, expect, it } from 'vitest';
import { configureLogger } from '@fw/logger';
import { ErrorCode } from '@fw/core';
import { ClientErrorsController, parseClientErrorBatch } from './client-errors.controller.js';
import { ClientErrorsService, type ClientErrorReport } from './client-errors.service.js';

/** 构造一条合法上报（字段可覆盖） */
function makeReport(overrides: Partial<ClientErrorReport> = {}): ClientErrorReport {
  return {
    source: 'error',
    message: 'Cannot read properties of undefined',
    stack: 'TypeError: Cannot read properties of undefined\n    at render (AppMain.vue:42:11)',
    resource: null,
    page: '/dashboard',
    url: 'https://admin.example.com/dashboard?tab=1',
    traceId: 'b3f1c9d2e4f5a6b7',
    repeat: 1,
    at: '2026-10-15T12:00:00.000Z',
    ...overrides,
  };
}

/** 合法信封 */
function makeBatch(reports: ClientErrorReport[] = [makeReport()]): unknown {
  return { app: 'admin-web', reports };
}

/** 取 BizError 的 details（字段级错误明细） */
function detailsOf(error: unknown): Array<{ field: string; message: string }> {
  return (error as { details?: Array<{ field: string; message: string }> }).details ?? [];
}

/** 断言同步调用抛 BizError 且带指定错误码（未抛则断言失败） */
function expectBizError(fn: () => unknown, code: number): void {
  let thrown: unknown;
  try {
    fn();
  } catch (error) {
    thrown = error;
  }
  expect(thrown).toMatchObject({ code });
}

describe('parseClientErrorBatch：信封校验', () => {
  it('合法信封原样归一（可空字段保留 null）', () => {
    const batch = parseClientErrorBatch(makeBatch([makeReport({ stack: null, traceId: null })]));
    expect(batch.app).toBe('admin-web');
    expect(batch.reports).toHaveLength(1);
    expect(batch.reports[0]?.stack).toBeNull();
    expect(batch.reports[0]?.traceId).toBeNull();
  });

  it('body 为 null / undefined → 400/1001（app 缺失）', () => {
    expectBizError(() => parseClientErrorBatch(null), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(undefined), ErrorCode.BAD_REQUEST);
  });

  it('app 缺失 / 空串 / 超长 → 400/1001', () => {
    expectBizError(() => parseClientErrorBatch({ reports: [] }), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch({ app: '', reports: [] }), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch({ app: 'x'.repeat(65), reports: [] }), ErrorCode.BAD_REQUEST);
  });

  it('reports 非数组 / 空数组 / 超单批上限 10 → 400/1001', () => {
    expectBizError(() => parseClientErrorBatch({ app: 'admin-web', reports: 'nope' }), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch({ app: 'admin-web', reports: [] }), ErrorCode.BAD_REQUEST);
    const many = Array.from({ length: 11 }, () => makeReport());
    expectBizError(() => parseClientErrorBatch({ app: 'admin-web', reports: many }), ErrorCode.BAD_REQUEST);
  });

  it('恰好 10 条（前端 RUM_MAX_BATCH 同口径）合法放行', () => {
    const many = Array.from({ length: 10 }, () => makeReport());
    const batch = parseClientErrorBatch({ app: 'admin-web', reports: many });
    expect(batch.reports).toHaveLength(10);
  });

  it('source 不在枚举 → 400/1001 且 details 定位到 reports[0].source', () => {
    try {
      parseClientErrorBatch(makeBatch([makeReport({ source: 'weird' as never })]));
      expect.unreachable('应抛 BizError');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.BAD_REQUEST });
      expect(detailsOf(error)).toEqual([{ field: 'reports[0].source', message: expect.any(String) }]);
    }
  });

  it('message 缺失 / 空串 / 超 2000 字符 → 400/1001', () => {
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ message: undefined as never })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ message: '' })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ message: 'x'.repeat(2001) })])), ErrorCode.BAD_REQUEST);
  });

  it('stack / resource / traceId 非字符串非 null → 400/1001', () => {
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ stack: 42 as never })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ resource: {} as never })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ traceId: [] as never })])), ErrorCode.BAD_REQUEST);
  });

  it('stack 超 4000 字符 → 400/1001（防大包撑爆日志管道）', () => {
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ stack: 'x'.repeat(4001) })])), ErrorCode.BAD_REQUEST);
  });

  it('repeat 非整数 / <1 / 超上界 → 400/1001', () => {
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ repeat: 0 })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ repeat: 1.5 })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ repeat: 1001 })])), ErrorCode.BAD_REQUEST);
  });

  it('page / url / at 缺失 → 400/1001', () => {
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ page: undefined as never })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ url: undefined as never })])), ErrorCode.BAD_REQUEST);
    expectBizError(() => parseClientErrorBatch(makeBatch([makeReport({ at: '' })])), ErrorCode.BAD_REQUEST);
  });

  it('同一条目多字段错误一次回齐（details 含全部定位，不逐条试错）', () => {
    try {
      parseClientErrorBatch(makeBatch([makeReport({ message: '', repeat: -1 })]));
      expect.unreachable('应抛 BizError');
    } catch (error) {
      expect(error).toMatchObject({ code: ErrorCode.BAD_REQUEST });
      const fields = detailsOf(error).map((item) => item.field);
      expect(fields).toContain('reports[0].message');
      expect(fields).toContain('reports[0].repeat');
    }
  });

  it('第二条目错误定位到 reports[1]（下标准确）', () => {
    try {
      parseClientErrorBatch(makeBatch([makeReport(), makeReport({ source: 'bad' as never })]));
      expect.unreachable('应抛 BizError');
    } catch (error) {
      expect(detailsOf(error)).toEqual([{ field: 'reports[1].source', message: expect.any(String) }]);
    }
  });
});

describe('ClientErrorsService：摄取日志与计数', () => {
  afterEach(() => {
    // 恢复默认 sink（configureLogger 改的是模块级全局状态；直接传 undefined 会把默认
    // sink 覆盖成 undefined，后续未注入 sink 的用例必崩——必须显式写回默认实现）
    configureLogger({ sink: (line) => process.stdout.write(`${line}\n`) });
  });

  it('逐条 error 级结构化日志（module=rum，字段化上下文）', () => {
    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line) });
    const service = new ClientErrorsService();

    service.ingest(parseClientErrorBatch(makeBatch([makeReport({ source: 'vue', page: '/users' })])));

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0] as string) as { level: string; module: string; msg: string; ctx: Record<string, unknown> };
    expect(record.level).toBe('error');
    expect(record.module).toBe('rum');
    expect(record.msg).toBe('前端错误上报');
    expect(record.ctx).toMatchObject({ app: 'admin-web', source: 'vue', page: '/users', traceId: 'b3f1c9d2e4f5a6b7' });
  });

  it('received/total 跨批累计；bySource 按来源分布', () => {
    const service = new ClientErrorsService();

    const first = service.ingest(parseClientErrorBatch(makeBatch([makeReport(), makeReport({ source: 'rejection' })])));
    expect(first).toEqual({ received: 2, total: 2 });

    const second = service.ingest(parseClientErrorBatch(makeBatch([makeReport({ source: 'resource', resource: 'https://x/a.js' })])));
    expect(second).toEqual({ received: 1, total: 3 });

    const stats = service.stats();
    expect(stats.total).toBe(3);
    expect(stats.bySource).toEqual({ error: 1, rejection: 1, resource: 1 });
  });

  it('空信封不进 ingest（控制器已拒收；此处防御性直调不崩）', () => {
    const service = new ClientErrorsService();
    const result = service.ingest({ app: 'admin-web', reports: [] });
    expect(result).toEqual({ received: 0, total: 0 });
  });
});

describe('ClientErrorsController：端点编排', () => {
  it('POST client-errors：校验通过 → 服务摄取并回带 { received, total }', () => {
    const service = new ClientErrorsService();
    const controller = new ClientErrorsController(service);

    const result = controller.ingest(makeBatch([makeReport(), makeReport({ source: 'vue' })]));

    expect(result).toEqual({ received: 2, total: 2 });
    expect(service.stats().bySource).toEqual({ error: 1, vue: 1 });
  });

  it('POST client-errors：载荷非法 → 400/1001 且不落日志（摄取前置拦截）', () => {
    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line) });
    const controller = new ClientErrorsController(new ClientErrorsService());

    expectBizError(() => controller.ingest({ app: 'admin-web', reports: 'nope' }), ErrorCode.BAD_REQUEST);
    expect(lines).toHaveLength(0);
  });
});
