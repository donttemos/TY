/*
 * @file 业务错误定义与错误码处理
 * @description 统一响应信封 { code, message, data, traceId } 的失败分支（C-06 契约 / API 规格 §2）：
 *   BizError 承载 code/message/traceId/details；错误码 → 用户可读提示与后续动作（是否静默刷新、是否跳登录）。
 *   与后端错误码表同源，新增码只允许加枚举，不允许改语义。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/utils
 */

/** 业务错误码（docs/40-api-spec.md §2，C-01/C-06 同源） */
export const BIZ_CODE = {
  OK: 0,
  BAD_REQUEST: 1001,
  NOT_FOUND: 1002,
  CONFLICT: 1003,
  STATE_NOT_ALLOWED: 1004,
  BUSINESS: 2001,
  UNAUTHORIZED: 3001,
  FORBIDDEN: 3002,
  TOKEN_EXPIRED: 3003,
  ACCOUNT_LOCKED: 3004,
  TENANT_INVALID: 4001,
  /** 该配置键不可热更新（M9/PRD-009：boot 键或不在白名单） */
  CONFIG_NOT_HOT: 5001,
  /** 配置新值非法（M9/PRD-009：details 带原因） */
  CONFIG_INVALID_VALUE: 5002,
  /** 配置键不存在（M9/PRD-009） */
  CONFIG_NOT_FOUND: 5003,
  INTERNAL: 9001,
  DEPENDENCY_UNAVAILABLE: 9002,
  RATE_LIMITED: 9003,
} as const;

/** 字段级校验错误（1001 时 data.details） */
export interface FieldError {
  field: string;
  message: string;
}

/** 业务错误：请求链路（HTTP 成功但 code≠0，或 HTTP 非 2xx 带信封）统一转为此类 */
export class BizError extends Error {
  readonly code: number;
  readonly traceId: string | null;
  readonly details: FieldError[] | null;

  constructor(code: number, message: string, traceId: string | null = null, details: FieldError[] | null = null) {
    super(message);
    this.name = 'BizError';
    this.code = code;
    this.traceId = traceId;
    this.details = details;
  }

  /** 是否应触发「静默刷新并重试」（3001 未登录/无效 + 3003 过期；刷新成功即可重放） */
  get shouldTryRefresh(): boolean {
    return this.code === BIZ_CODE.UNAUTHORIZED || this.code === BIZ_CODE.TOKEN_EXPIRED;
  }

  /** 是否应跳转登录页（刷新也救不回来：账号锁定 / 刷新本身失败） */
  get shouldRedirectLogin(): boolean {
    return this.code === BIZ_CODE.ACCOUNT_LOCKED;
  }
}

/** 错误码 → 用户可读提示（与 docs/25-ui-prototype.md §7 交互规范一致） */
export function describeBizError(error: BizError): string {
  switch (error.code) {
    case BIZ_CODE.BAD_REQUEST:
      return error.message || '请求参数有误';
    case BIZ_CODE.NOT_FOUND:
      return error.message || '资源不存在或已删除';
    case BIZ_CODE.CONFLICT:
      return error.message || '数据冲突，请检查唯一性约束';
    case BIZ_CODE.STATE_NOT_ALLOWED:
      return error.message || '当前状态不允许该操作，请刷新后重试';
    case BIZ_CODE.BUSINESS:
      return error.message || '业务校验未通过';
    case BIZ_CODE.UNAUTHORIZED:
      return error.message || '登录状态已失效，请重新登录';
    case BIZ_CODE.FORBIDDEN:
      return error.message || '无操作权限';
    case BIZ_CODE.TOKEN_EXPIRED:
      return error.message || '登录状态已过期，请重新登录';
    case BIZ_CODE.ACCOUNT_LOCKED:
      return error.message || '账号已锁定或禁用，请联系管理员';
    case BIZ_CODE.INTERNAL:
      return error.traceId ? `系统开小差了（已上报，traceId：${error.traceId}）` : '系统开小差了，请稍后重试';
    case BIZ_CODE.DEPENDENCY_UNAVAILABLE:
      return '依赖服务暂不可用，请稍后重试';
    case BIZ_CODE.CONFIG_NOT_HOT:
      return error.message || '该配置键不可热更新（boot 键或不在白名单）';
    case BIZ_CODE.CONFIG_INVALID_VALUE:
      return error.details?.length ? `新值非法：${error.details.map((d) => d.message).join('；')}` : error.message || '新值非法，请检查后重试';
    case BIZ_CODE.CONFIG_NOT_FOUND:
      return error.message || '配置键不存在';
    case BIZ_CODE.RATE_LIMITED:
      return error.message || '操作过于频繁，请稍后重试';
    default:
      return error.message || '请求失败，请稍后重试';
  }
}

/** 从信封体构造 BizError（code≠0 时；code 缺省按 9001 处理，data 可为 null） */
export function toBizError(body: { code?: number; message?: string; traceId?: string; details?: FieldError[]; data?: { details?: FieldError[] } | null }): BizError {
  // 真实后端（GlobalExceptionFilter）把 details 放在信封顶层；兼容 data.details（历史 mock 形态）
  const details = Array.isArray(body.details) ? body.details : Array.isArray(body.data?.details) ? (body.data?.details as FieldError[]) : null;
  return new BizError(body.code ?? BIZ_CODE.INTERNAL, body.message ?? '', body.traceId ?? null, details);
}
