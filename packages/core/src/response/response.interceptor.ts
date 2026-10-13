/*
 * @file 统一响应拦截器
 * @description 把 Controller 返回值包装为 { code: 0, message: 'ok', data, traceId }；健康检查与指标端点（/health /ready /metrics）保持原始格式不包装。
 * @author donttemo
 * @created 2026-10-09
 * @module core
 * @since v0.1.0
 */
import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import type { Request, Response } from 'express';
import { map, Observable } from 'rxjs';
import { getTraceId } from '@fw/logger';

/** 不做包装的前缀（运维端点，格式固定） */
const RAW_PATH_PREFIXES = ['/health', '/ready', '/metrics'];

/** 统一成功响应体 */
export interface OkBody<T> {
  code: 0;
  message: 'ok';
  data: T;
  traceId: string;
}

/**
 * 全局响应拦截器：bootstrap 中注册
 */
@Injectable()
export class ResponseInterceptor<T> implements NestInterceptor<T, OkBody<T> | T> {
  /**
   * 拦截并包装响应
   * @param context 执行上下文
   * @param next 下一步处理器
   * @returns 包装后的响应流
   */
  intercept(context: ExecutionContext, next: CallHandler<T>): Observable<OkBody<T> | T> {
    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();
    const isRaw = RAW_PATH_PREFIXES.some((p) => req.path === p || req.path.startsWith(p + '/'));
    return next.handle().pipe(
      map((data) => {
        if (isRaw || res.headersSent) return data;
        return { code: 0, message: 'ok', data, traceId: getTraceId() };
      }),
    );
  }
}
