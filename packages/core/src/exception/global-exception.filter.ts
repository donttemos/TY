/*
 * @file 全局异常过滤器
 * @description 把一切异常归一化为统一错误体：BizError 按错误码；Nest HttpException 映射到错误码表（校验数组转 details）；未知异常收敛为 9001 并记录服务端日志——杜绝裸 500。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-05）：错误码升为日志一等字段（LogOptions.code），不再内嵌 ctx
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-09）：信封 additive 增 requestId（请求上下文存在时输出）
 * @module core
 * @since v0.1.0
 */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException, HttpStatus } from '@nestjs/common';
import type { Request, Response } from 'express';
import { getRequestId, getTraceId, Logger } from '@fw/logger';
import { BizError } from '../errors/biz-error.js';
import { ERROR_CODE_META, HTTP_TO_ERROR_CODE, type BizErrorCode, type ErrorBody } from '../errors/error-codes.js';

/** 服务端内部错误日志器（堆栈只落日志，不外发） */
const logger = Logger.for('exception-filter');

/**
 * 全局异常过滤器：bootstrap 中注册，捕获所有未处理异常
 */
@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  /**
   * 异常归一化入口
   * @param exception 捕获到的任意异常
   * @param host 参数宿主（含 req/res）
   */
  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const res = http.getResponse<Response>();
    const req = http.getRequest<Request>();
    if (res.headersSent) return;

    const body = this.toErrorBody(exception);
    const level = body.code === 9001 ? 'error' : 'warn';
    // PRD-012 OBS-05：code 升为日志一等字段（LogOptions），不再内嵌 ctx——日志侧可按错误码检索
    logger[level](`请求异常 ${req.method} ${req.path}`, {
      message: body.message,
      stack: exception instanceof Error ? exception.stack : undefined,
    }, { code: body.code });
    res.status(this.httpOf(exception, body.code)).json(body);
  }

  /** 异常 → 统一错误体 */
  private toErrorBody(exception: unknown): ErrorBody {
    const traceId = getTraceId();
    const requestId = getRequestId();
    if (exception instanceof BizError) {
      const body: ErrorBody = {
        code: exception.code,
        message: exception.message,
        data: null,
        traceId,
        ...(requestId ? { requestId } : {}),
      };
      if (exception.details) body.details = exception.details;
      return body;
    }
    if (exception instanceof HttpException) {
      const code = this.httpToCode(exception);
      const body: ErrorBody = {
        code,
        message: this.httpMessage(exception, code),
        data: null,
        traceId,
        ...(requestId ? { requestId } : {}),
      };
      const details = this.extractDetails(exception);
      if (details) body.details = details;
      return body;
    }
    // 未知异常：对外只暴露错误码，不泄漏内部细节
    return { code: 9001, message: ERROR_CODE_META[9001].message, data: null, traceId, ...(requestId ? { requestId } : {}) };
  }

  /** 决定 HTTP 状态码 */
  private httpOf(exception: unknown, code: BizErrorCode): number {
    if (exception instanceof BizError) return exception.http;
    if (exception instanceof HttpException) return exception.getStatus();
    return ERROR_CODE_META[code].http;
  }

  /** Nest HttpException 状态码 → 业务错误码 */
  private httpToCode(exception: HttpException): BizErrorCode {
    const status = exception.getStatus();
    return HTTP_TO_ERROR_CODE[status] ?? 9001;
  }

  /** 提取 HttpException 的默认或自定义文案 */
  private httpMessage(exception: HttpException, code: BizErrorCode): string {
    const payload = exception.getResponse();
    if (typeof payload === 'string') return payload;
    if (payload !== null && typeof payload === 'object' && 'message' in payload) {
      const msg = (payload as { message: unknown }).message;
      if (typeof msg === 'string') return msg;
    }
    return ERROR_CODE_META[code].message;
  }

  /** 校验类异常（message 为数组）转字段级 details */
  private extractDetails(exception: HttpException): Array<{ field: string; message: string }> | undefined {
    const payload = exception.getResponse();
    if (payload === null || typeof payload !== 'object' || !('message' in payload)) return undefined;
    const msg = (payload as { message: unknown }).message;
    if (!Array.isArray(msg)) return undefined;
    return msg.map((item) => {
      const text = String(item);
      const matched = text.match(/^(\S+)\s/);
      return { field: matched ? matched[1] : text, message: text };
    });
  }
}
