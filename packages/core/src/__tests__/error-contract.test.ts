/*
 * @file 错误面契约测试（PRD-012 OBS-08，ADR-0025）
 * @description 每个错误码 → 信封形状 + http 映射逐码锁定；含反向验证：
 *   ① 未知异常收敛 9001 且响应体不含内部细节（异常 message / 类名 / stack）；
 *   ② details 顶层位置由断言锁死（防回退到 data.details 历史形态）；
 *   ③ HTTP_TO_ERROR_CODE 兜底映射与码表 http 逐条自洽（三方异常归一不产生错位码）。
 * @author donttemo
 * @created 2026-10-17
 * @module core
 */
import { ArgumentsHost } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { runWithRequestContext } from '@fw/logger';
import { BizError } from '../errors/biz-error.js';
import { ErrorCode, ERROR_CODE_META, HTTP_TO_ERROR_CODE, type BizErrorCode } from '../errors/error-codes.js';
import { GlobalExceptionFilter } from '../exception/global-exception.filter.js';

/** 调用全局异常过滤器并捕获响应体与状态码 */
function capture(exception: unknown, traceId = 'trace-contract'): { body: Record<string, unknown>; status: number } {
  const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
  const req = { method: 'GET', path: '/contract' };
  const host = {
    switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
  } as unknown as ArgumentsHost;
  runWithRequestContext({ traceId, spanId: '' }, () => new GlobalExceptionFilter().catch(exception, host));
  return {
    body: res.json.mock.calls[0][0] as Record<string, unknown>,
    status: res.status.mock.calls[0][0] as number,
  };
}

describe('M12 W1 · 错误面契约（OBS-08）', () => {
  it('每个错误码 → 信封形状 + http 映射逐码锁定（含码表默认文案）', () => {
    const codes = Object.keys(ERROR_CODE_META).map(Number) as BizErrorCode[];
    expect(codes.length).toBeGreaterThanOrEqual(16);
    for (const code of codes) {
      const meta = ERROR_CODE_META[code];
      const error = new BizError(code);
      expect(error.http, `码 ${code} 的 BizError.http 应由码表派生`).toBe(meta.http);
      expect(error.message).toBe(meta.message);

      const { body, status } = capture(error);
      // 信封冻结形态：{ code, message, data, traceId, details? }——无多余字段（requestId 为 W2 additive）
      expect(Object.keys(body).sort(), `码 ${code} 信封字段冻结`).toEqual(['code', 'data', 'message', 'traceId']);
      expect(body).toEqual({ code, message: meta.message, data: null, traceId: 'trace-contract' });
      expect(status, `码 ${code} 的 HTTP 状态映射`).toBe(meta.http);
      expect(JSON.stringify(body)).not.toContain('stack');
    }
  });

  it('details 顶层位置由断言锁死（防回退 data.details），data 恒为 null', () => {
    const details = [{ field: 'message', message: '不能为空' }];
    const { body } = capture(new BizError(ErrorCode.CONFIG_INVALID_VALUE, '配置新值非法', details));
    expect(body.details).toEqual(details);
    expect(body.data).toBeNull();
    expect((body.data as Record<string, unknown> | null)?.details).toBeUndefined();
  });

  it('反向验证：未知异常收敛 9001，响应体不含异常 message / 内部类名 / stack', () => {
    const { body, status } = capture(new TypeError('boom-internal-detail'));
    expect(body).toEqual({
      code: ErrorCode.INTERNAL,
      message: ERROR_CODE_META[ErrorCode.INTERNAL].message,
      data: null,
      traceId: 'trace-contract',
    });
    expect(status).toBe(500);
    const serialized = JSON.stringify(body);
    expect(serialized).not.toContain('boom-internal-detail');
    expect(serialized).not.toContain('TypeError');
    expect(serialized).not.toContain('stack');
  });

  it('HTTP_TO_ERROR_CODE 兜底映射自洽：每个 http 值与码表元信息互逆', () => {
    for (const [http, code] of Object.entries(HTTP_TO_ERROR_CODE)) {
      expect(ERROR_CODE_META[code].http, `兜底映射 ${http}→${code} 应与码表 http 一致`).toBe(Number(http));
    }
  });

  it('过滤器日志携带 code 一等字段（OBS-05 契约联动：按错误码检索在日志侧成立）', async () => {
    const { configureLogger } = await import('@fw/logger');
    const lines: string[] = [];
    configureLogger({ sink: (line) => lines.push(line) });
    capture(new BizError(ErrorCode.CONFLICT, '唯一约束冲突'));
    const logLine = lines.find((l) => l.includes('请求异常'));
    expect(logLine).toBeDefined();
    const record = JSON.parse(logLine!) as { level: string; code?: number };
    expect(record.level).toBe('warn');
    expect(record.code).toBe(ErrorCode.CONFLICT);
  });
});
