/*
 * @file SaaS 领域业务异常
 * @description 4029/4030/4031 三码的领域抛错面（ADR-0030/0031）；全部继承 BizError，
 *   全局异常过滤器统一转响应体。错误码语义登记见 packages/core/src/errors/error-codes.ts（码表单一来源）。
 * @author donttemo
 * @created 2026-10-19
 * @module @fw/saas
 */
import { BizError, ErrorCode } from '@fw/core';
import type { LifecycleAction, LifecycleStatus } from './types.js';

/** 配额硬限额超限（4029）：details 携带 metricKey 与当前窗口用量，供前端出升级指引 */
export class QuotaExceededError extends BizError {
  readonly metricKey: string;
  readonly used: string;
  readonly limit: string;

  constructor(metricKey: string, used: bigint, limit: bigint) {
    super(ErrorCode.QUOTA_EXCEEDED, `配额已达上限（${metricKey}）`, [
      { field: 'metricKey', message: metricKey },
      { field: 'used', message: used.toString() },
      { field: 'limit', message: limit.toString() },
    ]);
    this.name = 'QuotaExceededError';
    this.metricKey = metricKey;
    this.used = used.toString();
    this.limit = limit.toString();
  }
}

/** 非法生命周期迁移（4030）：details 含 from/action/to，定位具体被拒路径 */
export class LifecycleTransitionInvalidError extends BizError {
  readonly from: LifecycleStatus;
  readonly action: LifecycleAction;

  constructor(from: LifecycleStatus, action: LifecycleAction, to?: LifecycleStatus) {
    super(ErrorCode.LIFECYCLE_TRANSITION_INVALID, `生命周期状态不允许该操作（${from} -[${action}]-> ${to ?? '?'}）`, [
      { field: 'from', message: from },
      { field: 'action', message: action },
      ...(to ? [{ field: 'to', message: to }] : []),
    ]);
    this.name = 'LifecycleTransitionInvalidError';
    this.from = from;
    this.action = action;
  }
}

/** 租户已冻结/终止（4031）：业务入口 Guard 的抛错面 */
export class TenantSuspendedError extends BizError {
  readonly tenantId: string;
  readonly status: LifecycleStatus;

  constructor(tenantId: string, status: LifecycleStatus) {
    super(ErrorCode.TENANT_SUSPENDED, `租户已${status === 'terminated' ? '终止' : '冻结'}，业务访问被拒绝`);
    this.name = 'TenantSuspendedError';
    this.tenantId = tenantId;
    this.status = status;
  }
}
