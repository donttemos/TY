/*
 * @file 传输层异常
 * @description 全部传输错误的基类与细分：驱动不可用（未安装依赖 / 缺连接串 / 不支持的驱动）、
 *   调用超时、地址未注册、地址非法、地址重复注册。跨进程回传的错误经 serializeTransportError
 *   序列化、deserializeTransportError 重建——BizError 按原错误码重建，保证两种驱动下调用方
 *   catch 到同一类错误（PRD-008 FR-06：切换 transport 不改调用方代码）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/transport
 */

import { BizError, ERROR_CODE_META, type BizErrorCode, type FieldIssue } from '@fw/core';
import type { TransportErrorPayload } from './types.js';

/** 传输错误基类 */
export class TransportError extends Error {
  /** 错误码（透传对端业务错误码时携带） */
  readonly code?: number;
  /** 字段级错误（对端 BizError 携带时透传） */
  readonly details?: FieldIssue[];

  /**
   * @param message 错误消息
   * @param options 附加信息（错误码 / 字段级错误 / 原因）
   */
  constructor(message: string, options?: { code?: number; details?: FieldIssue[]; cause?: unknown }) {
    super(message, options?.cause !== undefined ? { cause: options.cause } : undefined);
    this.name = 'TransportError';
    this.code = options?.code;
    this.details = options?.details;
  }
}

/** 驱动不可用：未安装依赖、缺连接串、不支持的驱动 */
export class TransportUnavailableError extends TransportError {
  /**
   * @param message 可操作的错误提示（含修复手段）
   * @param cause 原始异常
   */
  constructor(message: string, cause?: unknown) {
    super(message, { cause });
    this.name = 'TransportUnavailableError';
  }
}

/** 调用超时：对端在超时窗口内未应答（含无处理方消费的场景） */
export class TransportTimeoutError extends TransportError {
  /** 超时的传输地址 */
  readonly address: string;
  /** 超时上限（毫秒） */
  readonly timeoutMs: number;

  /**
   * @param address 传输地址
   * @param timeoutMs 超时上限（毫秒）
   */
  constructor(address: string, timeoutMs: number) {
    super(`传输调用超时：${address}（${timeoutMs}ms 内未收到应答）`);
    this.name = 'TransportTimeoutError';
    this.address = address;
    this.timeoutMs = timeoutMs;
  }
}

/** 地址未注册（含 caller 角色下本进程按设计不处理请求） */
export class HandlerNotRegisteredError extends TransportError {
  /** 未注册的传输地址 */
  readonly address: string;

  /**
   * @param address 传输地址
   */
  constructor(address: string) {
    super(`传输地址未注册：${address}（确认提供方进程已用 @TransportHandler 注册且角色包含 handler）`);
    this.name = 'HandlerNotRegisteredError';
    this.address = address;
  }
}

/** 地址非法：须为点分非空段（至少两段），段内字符 [a-zA-Z0-9_-] */
export class InvalidAddressError extends TransportError {
  /** 非法的传输地址 */
  readonly address: string;

  /**
   * @param address 传输地址
   */
  constructor(address: string) {
    super(`传输地址非法：${address}（须为点分非空段，如 demo-transport.echo）`);
    this.name = 'InvalidAddressError';
    this.address = address;
  }
}

/** 同一地址被重复注册 */
export class DuplicateAddressError extends TransportError {
  /** 重复的传输地址 */
  readonly address: string;

  /**
   * @param address 传输地址
   */
  constructor(address: string) {
    super(`传输地址重复注册：${address}`);
    this.name = 'DuplicateAddressError';
    this.address = address;
  }
}

/** 事件主题非法：须为点分非空段（至少两段），段内字符 [a-zA-Z0-9_-] */
export class InvalidTopicError extends TransportError {
  /** 非法主题 */
  readonly topic: string;

  /**
   * @param topic 事件主题
   */
  constructor(topic: string) {
    super(`事件主题非法：${topic}（须为点分非空段，如 job.progress / queue.alert）`);
    this.name = 'InvalidTopicError';
    this.topic = topic;
  }
}

/** 驱动不支持事件面（tcp / kafka 预留驱动或自定义注入的 RPC-only 驱动） */
export class TransportEventsUnsupportedError extends TransportError {
  /** 驱动名 */
  readonly driver: string;

  /**
   * @param driver 驱动名
   */
  constructor(driver: string) {
    super(`传输驱动 ${driver} 未实现事件面（publish / subscribe）：E-12 SSE 需 in-process 或 redis 驱动`);
    this.name = 'TransportEventsUnsupportedError';
    this.driver = driver;
  }
}

/** 地址格式：点分非空段（至少两段），段内仅字母/数字/下划线/连字符 */
const ADDRESS_PATTERN = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/;

/** 主题格式：点分非空段（至少两段），段内仅字母/数字/下划线/连字符（与地址同约束，降低记忆成本） */
const TOPIC_PATTERN = /^[a-zA-Z0-9_-]+(?:\.[a-zA-Z0-9_-]+)+$/;

/**
 * 校验事件主题，非法即抛 InvalidTopicError（发布与订阅共用同一约束）
 * @param topic 事件主题
 */
export function assertTopic(topic: string): void {
  if (typeof topic !== 'string' || !TOPIC_PATTERN.test(topic)) {
    throw new InvalidTopicError(String(topic));
  }
}

/**
 * 校验传输地址，非法即抛 InvalidAddressError（注册与调用共用同一约束）
 * @param address 传输地址
 */
export function assertAddress(address: string): void {
  if (typeof address !== 'string' || !ADDRESS_PATTERN.test(address)) {
    throw new InvalidAddressError(String(address));
  }
}

/**
 * 序列化对端回传前的错误：BizError 携带错误码与字段级详情，其余错误只带名称与消息
 * @param error 处理器抛出的异常
 * @returns 可 JSON 序列化的错误结构
 */
export function serializeTransportError(error: unknown): TransportErrorPayload {
  if (error instanceof BizError) {
    return { name: error.name, message: error.message, code: error.code, details: error.details };
  }
  if (error instanceof Error) {
    return { name: error.name || 'Error', message: error.message };
  }
  return { name: 'Error', message: String(error) };
}

/**
 * 重建对端回传的错误：携带已知业务错误码时按 BizError 重建（调用方 catch 与 in-process 一致），
 * 否则重建为通用 TransportError 并透传码与字段级错误。
 * @param payload 序列化的错误结构
 * @returns 重建后的异常（BizError 或 TransportError）
 */
export function deserializeTransportError(payload: TransportErrorPayload): Error {
  if (typeof payload.code === 'number' && payload.code in ERROR_CODE_META) {
    return new BizError(payload.code as BizErrorCode, payload.message, payload.details as FieldIssue[] | undefined);
  }
  return new TransportError(payload.message, { code: payload.code, details: payload.details });
}
