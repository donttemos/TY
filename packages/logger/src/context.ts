/*
 * @file 请求上下文（AsyncLocalStorage）
 * @description 进程内单例的异步上下文存储：traceId / spanId / 当前用户；由 @fw/core 的 trace 中间件写入，日志与后续 DAO 层默认携带；M8 接入 OTel 前 spanId 为空串。
 * @author donttemo
 * @created 2026-10-09
 * @module logger
 * @since v0.1.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';

/** 单次请求的上下文数据 */
export interface RequestContext {
  /** 链路 ID：透传上游 X-Trace-Id 或服务端生成 */
  traceId: string;
  /** span 标识，M8 接 OTel 前固定为空串 */
  spanId: string;
  /** 当前登录用户 ID（M3 起由鉴权层写入） */
  userId?: string;
}

/** 全局异步上下文存储（进程单例） */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * 生成 traceId：32 位十六进制
 * @returns 新 traceId
 */
export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

/**
 * 在指定异步作用域内运行回调（供中间件包裹请求处理）
 * @param ctx 本次请求上下文
 * @param callback 请求处理回调
 * @returns 回调返回值
 */
export function runWithRequestContext<T>(ctx: RequestContext, callback: () => T): T {
  return requestContextStorage.run(ctx, callback);
}

/**
 * 读取当前异步作用域的请求上下文
 * @returns 上下文对象；不在请求作用域内时返回 undefined
 */
export function getRequestContext(): RequestContext | undefined {
  return requestContextStorage.getStore();
}

/**
 * 就地补充当前上下文字段（如鉴权后写入 userId）
 * @param patch 需要合并的字段
 */
export function patchRequestContext(patch: Partial<RequestContext>): void {
  const store = requestContextStorage.getStore();
  if (store) Object.assign(store, patch);
}

/**
 * 获取当前 traceId（日志字段用）
 * @returns traceId；无上下文时为空串（如启动阶段日志）
 */
export function getTraceId(): string {
  return requestContextStorage.getStore()?.traceId ?? '';
}

/**
 * 获取当前 spanId
 * @returns spanId；无上下文时为空串
 */
export function getSpanId(): string {
  return requestContextStorage.getStore()?.spanId ?? '';
}
