/*
 * @file 业务异常
 * @description 业务代码唯一合法的抛错方式：带错误码、可带字段级 details；全局异常过滤器负责转成统一响应体，禁止裸 throw new Error()。
 * @author donttemo
 * @created 2026-10-09
 * @module core
 * @since v0.1.0
 */
import { ERROR_CODE_META, type BizErrorCode } from './error-codes.js';

/** 字段级校验错误 */
export interface FieldIssue {
  /** 字段名 */
  field: string;
  /** 中文提示 */
  message: string;
}

/**
 * 业务异常：抛出即返回结构化错误码与文案
 *
 * 用法：`throw new BizError(ErrorCode.NOT_FOUND, '订单不存在')`
 */
export class BizError extends Error {
  /** 业务错误码（见 error-codes.ts） */
  readonly code: BizErrorCode;
  /** 对应 HTTP 状态码（可覆盖默认值） */
  readonly http: number;
  /** 字段级错误（可选） */
  readonly details?: FieldIssue[];

  /**
   * @param code 业务错误码
   * @param message 覆盖默认文案（不传取错误码表默认值）
   * @param details 字段级错误列表
   */
  constructor(code: BizErrorCode, message?: string, details?: FieldIssue[]) {
    super(message ?? ERROR_CODE_META[code].message);
    this.name = 'BizError';
    this.code = code;
    this.http = ERROR_CODE_META[code].http;
    this.details = details;
  }
}
