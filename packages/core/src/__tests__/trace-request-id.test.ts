/*
 * @file requestId 双 ID 分层契约（PRD-012 OBS-09，ADR-0026）
 * @description 反向验证：① 每请求生成 ULID requestId 并回带 X-Request-Id；② 上游合法 requestId 复用、
 *   非法值替换；③ REQUEST_ID_ENABLED=false 回退仅 traceId（零行为差异：无 requestId 头、无 ALS 字段）；
 *   ④ 错误信封 additive 增 requestId（上下文存在时输出）；⑤ REQUEST_ID_HEADER 自定义头名生效。
 * @author donttemo
 * @created 2026-10-17
 * @module core
 */
import type { NextFunction, Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ArgumentsHost } from '@nestjs/common';
import { BizError } from '../errors/biz-error.js';
import { ErrorCode } from '../errors/error-codes.js';
import { GlobalExceptionFilter } from '../exception/global-exception.filter.js';
import { traceMiddleware } from '../trace/trace.middleware.js';
import { REQUEST_ID_PATTERN, getRequestId, runWithRequestContext } from '@fw/logger';

/** 最小 req/res 桩 */
function makePair(headers: Record<string, string | undefined> = {}): { req: Request; res: Response; next: NextFunction; setHeaders: Record<string, string> } {
  const setHeaders: Record<string, string> = {};
  const req = { headers } as unknown as Request;
  const res = { setHeader: vi.fn((name: string, value: string) => { setHeaders[name] = value; }) } as unknown as Response;
  const next = (() => undefined) as unknown as NextFunction;
  return { req, res, next, setHeaders };
}

describe('M12 W2 · requestId 双 ID 分层（OBS-09）', () => {
  afterEach(() => {
    delete process.env.REQUEST_ID_ENABLED;
    delete process.env.REQUEST_ID_HEADER;
  });

  it('每请求生成 ULID requestId：进 ALS + 回带 X-Request-Id', () => {
    const { req, res, next, setHeaders } = makePair();
    traceMiddleware(req, res, () => {
      const requestId = getRequestId();
      expect(requestId).toBeDefined();
      expect(REQUEST_ID_PATTERN.test(requestId!)).toBe(true);
      expect(setHeaders['X-Request-Id']).toBe(requestId);
    });
    void next;
  });

  it('上游合法 X-Request-Id 复用（跨代理排障锚点不变）', () => {
    const fixed = '01ARZ3NDEKTSV4RRFFQ69G5FAV';
    const { req, res } = makePair({ 'x-request-id': fixed });
    traceMiddleware(req, res, () => {
      expect(getRequestId()).toBe(fixed);
      expect(res.setHeader).toHaveBeenCalledWith('X-Request-Id', fixed);
    });
  });

  it('反向验证：上游非法 requestId 被替换为服务端生成值', () => {
    const { req, res } = makePair({ 'x-request-id': 'not-a-ulid!!!' });
    traceMiddleware(req, res, () => {
      const requestId = getRequestId();
      expect(requestId).toBeDefined();
      expect(requestId).not.toBe('not-a-ulid!!!');
      expect(REQUEST_ID_PATTERN.test(requestId!)).toBe(true);
    });
  });

  it('REQUEST_ID_ENABLED=false 回退仅 traceId（零行为差异：无头、无 ALS 字段、X-Trace-Id 保留）', () => {
    process.env.REQUEST_ID_ENABLED = 'false';
    const { req, res, setHeaders } = makePair({ 'x-request-id': '01ARZ3NDEKTSV4RRFFQ69G5FAV' });
    traceMiddleware(req, res, () => {
      expect(getRequestId()).toBeUndefined();
      expect(setHeaders['X-Request-Id']).toBeUndefined();
      expect(setHeaders['X-Trace-Id']).toBeDefined();
    });
  });

  it('REQUEST_ID_HEADER 自定义头名生效（请求读取 + 响应回带同用）', () => {
    process.env.REQUEST_ID_HEADER = 'X-Custom-Req-Id';
    const fixed = '01ARZ3NDEKTSV4RRFFQ69G5FAW';
    const { req, res, setHeaders } = makePair({ 'x-custom-req-id': fixed });
    traceMiddleware(req, res, () => {
      expect(getRequestId()).toBe(fixed);
      expect(setHeaders['X-Custom-Req-Id']).toBe(fixed);
    });
  });

  it('错误信封 additive 增 requestId（与 traceId 并列；上下文存在时输出）', () => {
    const res = { headersSent: false, status: vi.fn().mockReturnThis(), json: vi.fn() };
    const req = { method: 'GET', path: '/rid' };
    const host = {
      switchToHttp: () => ({ getResponse: () => res, getRequest: () => req }),
    } as unknown as ArgumentsHost;
    runWithRequestContext({ traceId: 't-rid', spanId: '', requestId: '01ARZ3NDEKTSV4RRFFQ69G5FAV' }, () =>
      new GlobalExceptionFilter().catch(new BizError(ErrorCode.NOT_FOUND, '不存在'), host),
    );
    const body = res.json.mock.calls[0][0] as Record<string, unknown>;
    expect(body.requestId).toBe('01ARZ3NDEKTSV4RRFFQ69G5FAV');
    expect(body.traceId).toBe('t-rid');
    expect(body.code).toBe(ErrorCode.NOT_FOUND);
  });
});
