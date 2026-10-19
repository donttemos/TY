/*
 * @file 业务错误定义与错误码处理
 * @description 统一响应信封 { code, message, data, traceId } 的失败分支（C-06 契约 / API 规格 §2）：
 *   BizError 承载 code/message/traceId/details；错误码 → 用户可读提示与后续动作（是否静默刷新、是否跳登录）。
 *   与后端错误码表同源，新增码只允许加枚举，不允许改语义。
 *   E-14 i18n 骨架（PRD-010 / ADR-0014）：用户可读文案改经 src/locales 文案表出（zh-CN 语义零回归）——
 *   zh-CN 沿用「后端 message 优先」（业务上下文更具体）；非 zh-CN 按 OQ-4 决策由前端表接管（后端 message 是中文）。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-14：describeBizError 文案表化 + locale 参数化；行为基准不变（zh-CN 分支
 *   与既有逐分支对照，全部既有断言零改动通过）
 * @module admin-web/utils
 */

import { currentLocale, DEFAULT_LOCALE, interpolate, messages, type Locale } from '@/locales';

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
  /** 配额已达上限（M13/ADR-0030：details 带 metricKey 与升级指引） */
  QUOTA_EXCEEDED: 4029,
  /** 非法生命周期迁移（M13/ADR-0031） */
  LIFECYCLE_TRANSITION_INVALID: 4030,
  /** 租户已冻结或终止（M13/ADR-0031） */
  TENANT_SUSPENDED: 4031,
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

/** 错误码数值全集（locale 错误码文案表键集与此编译期同构，见 src/locales/index.ts ErrorMessages） */
export type BizCodeValue = Exclude<(typeof BIZ_CODE)[keyof typeof BIZ_CODE], 0>;

/** 字段级校验错误（1001 时 data.details） */
export interface FieldError {
  field: string;
  message: string;
}

/** 业务错误：请求链路（HTTP 成功但 code≠0，或 HTTP 非 2xx 带信封）统一转为此类 */
export class BizError extends Error {
  readonly code: number;
  readonly traceId: string | null;
  /** 单请求 ID（M12 W2 OBS-09：后端信封 additive 字段，弹错报障时与 traceId 一并展示） */
  readonly requestId: string | null;
  readonly details: FieldError[] | null;

  constructor(
    code: number,
    message: string,
    traceId: string | null = null,
    details: FieldError[] | null = null,
    requestId: string | null = null,
  ) {
    super(message);
    this.name = 'BizError';
    this.code = code;
    this.traceId = traceId;
    this.requestId = requestId;
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

/**
 * 错误码 → 用户可读提示（docs/25-ui-prototype.md §7 交互规范）。
 * 文案出 src/locales 文案表（E-14，zh-CN 表值与既有字面量逐条一致——零回归基准）：
 * - zh-CN：既有行为——后端 message 优先（业务上下文文案更具体），缺省回落 zh 表；
 * - 非 zh-CN：OQ-4 决策前端接管——表优先（后端 message 是中文，直出会串味），未知码再回落后端 message 与 fallback。
 * 特例语义（两语言一致）：9001 固定文案不直出内部 message（带 traceId 用上报变体）；9002 固定文案；
 * 5002 有 details 走拼接模板，无 details zh-CN 回落后端 message。
 */
export function describeBizError(error: BizError, locale: Locale = currentLocale()): string {
  const table = messages[locale].errors;
  const preferBackendMessage = locale === DEFAULT_LOCALE;
  switch (error.code) {
    case BIZ_CODE.INTERNAL:
      return error.traceId
        ? interpolate(table['9001Trace'], { traceId: error.traceId })
        : table[BIZ_CODE.INTERNAL];
    case BIZ_CODE.DEPENDENCY_UNAVAILABLE:
      return table[BIZ_CODE.DEPENDENCY_UNAVAILABLE];
    case BIZ_CODE.CONFIG_INVALID_VALUE:
      if (error.details?.length) {
        return interpolate(table['5002Details'], {
          details: error.details.map((d) => d.message).join(preferBackendMessage ? '；' : '; '),
        });
      }
      return preferBackendMessage ? error.message || table[BIZ_CODE.CONFIG_INVALID_VALUE] : table[BIZ_CODE.CONFIG_INVALID_VALUE];
    default: {
      const text = (table as unknown as Record<string, string>)[error.code] ?? null;
      if (preferBackendMessage) {
        return error.message || text || table.fallback;
      }
      return text || error.message || table.fallback;
    }
  }
}

/** 从信封体构造 BizError（code≠0 时；code 缺省按 9001 处理，data 可为 null） */
export function toBizError(body: { code?: number; message?: string; traceId?: string; requestId?: string; details?: FieldError[]; data?: { details?: FieldError[] } | null }): BizError {
  // 真实后端（GlobalExceptionFilter）把 details 放在信封顶层；兼容 data.details（历史 mock 形态）
  const details = Array.isArray(body.details) ? body.details : Array.isArray(body.data?.details) ? (body.data?.details as FieldError[]) : null;
  return new BizError(body.code ?? BIZ_CODE.INTERNAL, body.message ?? '', body.traceId ?? null, details, body.requestId ?? null);
}
