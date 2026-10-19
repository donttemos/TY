/*
 * @file 错误码表
 * @description 与 docs/40-api-spec.md 第 2 节同源：分段 1xxx 通用、2xxx 业务预留、3xxx 鉴权、4xxx 租户、9xxx 系统；新增错误码必须同步该表与 PRD-001。
 *   码表为全仓唯一权威（PRD-012 OBS-03）：error-codes.json 工件 + 前端/模板/mock 三副本由
 *   check-triway-consistency 轴 G 构建期断言同源，篡改任意一份即构建失败。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-17 donttemo M12 W1（OBS-03）码表单一来源登记 + W2（OBS-09）ErrorBody 增 requestId
 * @modified 2026-10-19 donttemo M13（PRD-013）：增 4029 配额超限 / 4030 非法生命周期迁移 / 4031 租户冻结（ADR-0030/0031）
 * @module core
 * @since v0.1.0
 */

/** 业务错误码（0 表示成功） */
export const ErrorCode = {
  /** 成功 */
  OK: 0,
  /** 参数错误（400） */
  BAD_REQUEST: 1001,
  /** 资源不存在（404） */
  NOT_FOUND: 1002,
  /** 唯一约束冲突（409） */
  CONFLICT: 1003,
  /** 状态不允许该操作（400） */
  STATE_NOT_ALLOWED: 1004,
  /** 业务校验失败（400，细分预留） */
  BIZ_FAILED: 2001,
  /** 未登录或令牌无效（401） */
  UNAUTHORIZED: 3001,
  /** 无权限（403） */
  FORBIDDEN: 3002,
  /** 令牌已过期（401） */
  TOKEN_EXPIRED: 3003,
  /** 账号已锁定（403） */
  ACCOUNT_LOCKED: 3004,
  /** 租户无效或已过期（403，M8） */
  TENANT_INVALID: 4001,
  /** 配额硬限额超限（429，M13/ADR-0030：details 带 metricKey、窗口用量与升级指引） */
  QUOTA_EXCEEDED: 4029,
  /** 非法生命周期迁移（409，M13/ADR-0031：details 含 from/action/to） */
  LIFECYCLE_TRANSITION_INVALID: 4030,
  /** 租户已冻结/终止，业务访问被拒（403，M13/ADR-0031） */
  TENANT_SUSPENDED: 4031,
  /** 该配置键不可热更新（400，M9/PRD-009：boot 键或不在白名单） */
  CONFIG_NOT_HOT: 5001,
  /** 配置新值非法（400，M9/PRD-009：zod 校验失败，details 带原因） */
  CONFIG_INVALID_VALUE: 5002,
  /** 配置键不存在（404，M9/PRD-009） */
  CONFIG_NOT_FOUND: 5003,
  /** 系统内部错误（500） */
  INTERNAL: 9001,
  /** 依赖不可用，已进入降级（503） */
  DEPENDENCY_UNAVAILABLE: 9002,
  /** 触发限流（429） */
  RATE_LIMITED: 9003,
} as const;

/** 错误码类型 */
export type BizErrorCode = Exclude<(typeof ErrorCode)[keyof typeof ErrorCode], 0>;

/** 单个错误码的元信息 */
export interface ErrorCodeMeta {
  /** 对应 HTTP 状态码 */
  http: number;
  /** 默认中文文案 */
  message: string;
}

/** 错误码 → 元信息映射（与 API 文档逐条对齐） */
export const ERROR_CODE_META: Record<BizErrorCode, ErrorCodeMeta> = {
  [ErrorCode.BAD_REQUEST]: { http: 400, message: '参数错误' },
  [ErrorCode.NOT_FOUND]: { http: 404, message: '资源不存在' },
  [ErrorCode.CONFLICT]: { http: 409, message: '唯一约束冲突' },
  [ErrorCode.STATE_NOT_ALLOWED]: { http: 400, message: '状态不允许该操作' },
  [ErrorCode.BIZ_FAILED]: { http: 400, message: '业务校验失败' },
  [ErrorCode.UNAUTHORIZED]: { http: 401, message: '未登录或令牌无效' },
  [ErrorCode.FORBIDDEN]: { http: 403, message: '无操作权限' },
  [ErrorCode.TOKEN_EXPIRED]: { http: 401, message: '令牌已过期' },
  [ErrorCode.ACCOUNT_LOCKED]: { http: 403, message: '账号已锁定' },
  [ErrorCode.TENANT_INVALID]: { http: 403, message: '租户无效或已过期' },
  [ErrorCode.QUOTA_EXCEEDED]: { http: 429, message: '配额已达上限' },
  [ErrorCode.LIFECYCLE_TRANSITION_INVALID]: { http: 409, message: '生命周期状态不允许该操作' },
  [ErrorCode.TENANT_SUSPENDED]: { http: 403, message: '租户已冻结或终止' },
  [ErrorCode.CONFIG_NOT_HOT]: { http: 400, message: '该配置键不可热更新' },
  [ErrorCode.CONFIG_INVALID_VALUE]: { http: 400, message: '配置新值非法' },
  [ErrorCode.CONFIG_NOT_FOUND]: { http: 404, message: '配置键不存在' },
  [ErrorCode.INTERNAL]: { http: 500, message: '系统内部错误' },
  [ErrorCode.DEPENDENCY_UNAVAILABLE]: { http: 503, message: '依赖不可用' },
  [ErrorCode.RATE_LIMITED]: { http: 429, message: '请求过于频繁' },
};

/** HTTP 状态码到业务错误码的兜底映射（用于把三方异常归一化） */
export const HTTP_TO_ERROR_CODE: Record<number, BizErrorCode> = {
  400: ErrorCode.BAD_REQUEST,
  401: ErrorCode.UNAUTHORIZED,
  403: ErrorCode.FORBIDDEN,
  404: ErrorCode.NOT_FOUND,
  409: ErrorCode.CONFLICT,
  429: ErrorCode.RATE_LIMITED,
  500: ErrorCode.INTERNAL,
  503: ErrorCode.DEPENDENCY_UNAVAILABLE,
};

/** 统一响应体（失败形态，字段级校验错误放 details；requestId 为 W2 additive 字段） */
export interface ErrorBody {
  code: BizErrorCode;
  message: string;
  data: null;
  traceId: string;
  /** 单次请求 ID（M12 W2 OBS-09；仅在请求上下文存在时输出，additive） */
  requestId?: string;
  details?: Array<{ field: string; message: string }>;
}
