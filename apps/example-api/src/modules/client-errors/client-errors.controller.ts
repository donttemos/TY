/*
 * @file 前端错误上报端点（M10/E-17）
 * @description `POST /api/v1/telemetry/client-errors`：admin-web RUM 的接收面（@Public——
 *   登录页与未登录态的异常同样要能上报；fire-and-forget 语义，前端不依赖响应内容）。
 *   入参校验在本控制器完成（与 auth.controller 同约定）：信封形状、来源枚举、字段长度与
 *   条数上限（与前端 RUM_MAX_BATCH 对齐）；校验失败回 400/1001 且 details 带字段级原因。
 *   响应体统一信封 `{ received, total }`：received 本批接收条数，total 本实例累计计数
 *   （被动观测面——不设 stats 查询端点，主观测路径是 error 级结构化日志）。
 *   体积防御：单字段长度钳制（message/url ≤2000、stack ≤4000、page ≤500），
 *   叠加 Nest 默认 body 上限，防恶意大包撑爆日志管道。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/client-errors
 */

import { Body, Controller, Post } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { Public } from '@fw/auth';
import {
  CLIENT_ERROR_MAX_BATCH,
  CLIENT_ERROR_SOURCES,
  ClientErrorsService,
  type ClientErrorBatch,
  type ClientErrorReport,
} from './client-errors.service.js';

/** message / url / resource 字段长度上限 */
const MAX_TEXT_CHARS = 2000;

/** stack 字段长度上限（堆栈多帧，较消息放宽） */
const MAX_STACK_CHARS = 4000;

/** page 字段长度上限 */
const MAX_PAGE_CHARS = 500;

/** app 标识长度上限 */
const MAX_APP_CHARS = 64;

/** traceId 长度上限 */
const MAX_TRACE_CHARS = 64;

/** repeat 上界（前端每签名上限 5，此处放宽防御异常值） */
const MAX_REPEAT = 1000;

/** at 字段长度上限（ISO 8601） */
const MAX_AT_CHARS = 40;

/** 字段级错误明细（details 逐项 { field, message }） */
interface FieldError {
  field: string;
  message: string;
}

/** 取字符串字段（null / undefined 归一为 null；非字符串视为缺失） */
function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

/**
 * 校验单条上报（纯函数，可单测）
 * @param raw 原始载荷条目
 * @param index 条目下标（错误定位用）
 * @returns 归一化后的上报记录
 * @throws BizError 400/1001（details 含全部字段级原因，一次回齐不逐条试错）
 */
export function parseClientErrorReport(raw: unknown, index: number): ClientErrorReport {
  const errors: FieldError[] = [];
  const item = (raw ?? {}) as Record<string, unknown>;
  const field = (name: string): string => `reports[${index}].${name}`;

  const source = item.source;
  if (typeof source !== 'string' || !CLIENT_ERROR_SOURCES.includes(source as never)) {
    errors.push({ field: field('source'), message: `需为 ${CLIENT_ERROR_SOURCES.join(' / ')} 之一` });
  }

  const message = item.message;
  if (typeof message !== 'string' || message.length === 0) {
    errors.push({ field: field('message'), message: '必填且为非空字符串' });
  } else if (message.length > MAX_TEXT_CHARS) {
    errors.push({ field: field('message'), message: `长度不得超过 ${MAX_TEXT_CHARS}` });
  }

  const stack = strOrNull(item.stack);
  if (item.stack != null && stack === null) {
    errors.push({ field: field('stack'), message: '需为字符串或 null' });
  } else if (stack !== null && stack.length > MAX_STACK_CHARS) {
    errors.push({ field: field('stack'), message: `长度不得超过 ${MAX_STACK_CHARS}` });
  }

  const resource = strOrNull(item.resource);
  if (item.resource != null && resource === null) {
    errors.push({ field: field('resource'), message: '需为字符串或 null' });
  } else if (resource !== null && resource.length > MAX_TEXT_CHARS) {
    errors.push({ field: field('resource'), message: `长度不得超过 ${MAX_TEXT_CHARS}` });
  }

  const page = item.page;
  if (typeof page !== 'string' || page.length > MAX_PAGE_CHARS) {
    errors.push({ field: field('page'), message: `必填字符串，长度不得超过 ${MAX_PAGE_CHARS}` });
  }

  const url = item.url;
  if (typeof url !== 'string' || url.length > MAX_TEXT_CHARS) {
    errors.push({ field: field('url'), message: `必填字符串，长度不得超过 ${MAX_TEXT_CHARS}` });
  }

  const traceId = strOrNull(item.traceId);
  if (item.traceId != null && traceId === null) {
    errors.push({ field: field('traceId'), message: '需为字符串或 null' });
  } else if (traceId !== null && traceId.length > MAX_TRACE_CHARS) {
    errors.push({ field: field('traceId'), message: `长度不得超过 ${MAX_TRACE_CHARS}` });
  }

  const repeat = item.repeat;
  if (typeof repeat !== 'number' || !Number.isInteger(repeat) || repeat < 1 || repeat > MAX_REPEAT) {
    errors.push({ field: field('repeat'), message: `需为 1-${MAX_REPEAT} 的整数` });
  }

  const at = item.at;
  if (typeof at !== 'string' || at.length === 0 || at.length > MAX_AT_CHARS) {
    errors.push({ field: field('at'), message: `必填字符串（ISO 8601），长度不得超过 ${MAX_AT_CHARS}` });
  }

  if (errors.length > 0) {
    throw new BizError(ErrorCode.BAD_REQUEST, '前端错误上报载荷校验失败', errors);
  }

  return {
    source: source as ClientErrorReport['source'],
    message: message as string,
    stack,
    resource,
    page: page as string,
    url: url as string,
    traceId,
    repeat: repeat as number,
    at: at as string,
  };
}

/**
 * 校验上报信封（纯函数，可单测）
 * @param body 原始请求体
 * @returns 归一化后的批量信封
 * @throws BizError 400/1001（reports 非数组 / 空数组 / 超单批上限 / app 非法）
 */
export function parseClientErrorBatch(body: unknown): ClientErrorBatch {
  const payload = (body ?? {}) as Record<string, unknown>;

  const app = payload.app;
  if (typeof app !== 'string' || app.length === 0 || app.length > MAX_APP_CHARS) {
    throw new BizError(ErrorCode.BAD_REQUEST, `app 必填字符串，长度不得超过 ${MAX_APP_CHARS}`, [
      { field: 'app', message: `必填字符串，长度 1-${MAX_APP_CHARS}` },
    ]);
  }

  const reports = payload.reports;
  if (!Array.isArray(reports)) {
    throw new BizError(ErrorCode.BAD_REQUEST, 'reports 需为数组', [
      { field: 'reports', message: '需为数组' },
    ]);
  }
  if (reports.length === 0) {
    throw new BizError(ErrorCode.BAD_REQUEST, 'reports 不能为空', [
      { field: 'reports', message: '至少包含 1 条上报' },
    ]);
  }
  if (reports.length > CLIENT_ERROR_MAX_BATCH) {
    throw new BizError(ErrorCode.BAD_REQUEST, `单批最多 ${CLIENT_ERROR_MAX_BATCH} 条上报`, [
      { field: 'reports', message: `条数不得超过 ${CLIENT_ERROR_MAX_BATCH}` },
    ]);
  }

  return {
    app,
    reports: reports.map((item, index) => parseClientErrorReport(item, index)),
  };
}

/**
 * 前端错误上报控制器：路径前缀 /api/v1/telemetry
 */
@Controller('/api/v1/telemetry')
export class ClientErrorsController {
  /**
   * @param clientErrors 上报服务（日志 + 计数）
   */
  constructor(private readonly clientErrors: ClientErrorsService) {}

  /**
   * 接收一批前端错误（公开；fire-and-forget——前端不依赖响应内容）
   * @param body 上报信封 `{ app, reports[] }`
   * @returns `{ received, total }`：本批接收条数与本实例累计条数
   */
  @Public()
  @Post('client-errors')
  ingest(@Body() body: unknown): { received: number; total: number } {
    const batch = parseClientErrorBatch(body);
    return this.clientErrors.ingest(batch);
  }
}
