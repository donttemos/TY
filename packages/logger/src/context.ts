/*
 * @file 请求上下文（AsyncLocalStorage）
 * @description 进程内单例的异步上下文存储：traceId / spanId / requestId / 当前用户身份；由 @fw/core 的 trace 中间件写入，日志与后续 DAO 层默认携带。M8 T-M8-06 起可经 setSpanContextProvider 注入 OTel 活跃 span 提供者，使 traceId/spanId 与链路追踪对齐（未注入时行为不变）。
 *   M12 W2（PRD-012 OBS-09/10，ADR-0026）：新增 requestId（单请求 ULID，进程内唯一，不跨服务透传——
 *   跨服务语义归 traceId）与 familyId / jti（鉴权后由 RbacGuard / RefreshTokenService 边界写入）。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-14 donttemo M8 T-M8-06：新增 setSpanContextProvider 桥接（OTel 活跃 span 优先，回退请求上下文）
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-09/10）：requestId 生成与读取 + familyId/jti 上下文字段
 * @module logger
 * @since v0.1.0
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes, randomUUID } from 'node:crypto';

/** 单次请求的上下文数据 */
export interface RequestContext {
  /** 链路 ID：透传上游 X-Trace-Id 或服务端生成 */
  traceId: string;
  /** span 标识，M8 接 OTel 前固定为空串 */
  spanId: string;
  /**
   * 单次请求 ID（M12 W2 OBS-09）：请求入口生成（ULID）或复用上游合法 X-Request-Id；
   * 生命周期 = 单次 HTTP 请求，进程内唯一，不跨服务透传（跨服务用 traceId，ADR-0026）。
   */
  requestId?: string;
  /** 当前登录用户 ID（M3 起由鉴权层写入） */
  userId?: string;
  /** 令牌家族 ID（M12 W2 OBS-10：鉴权后由 RbacGuard 写入，refresh 流程由编排边界补写） */
  familyId?: string;
  /** 令牌标识 jti（非令牌本体，可记录；M12 W2 OBS-10，ADR-0026 记录安全论证） */
  jti?: string;
  /** 当前租户 ID；仅已认证请求可将候选值用于租户化数据访问 */
  tenantId?: string;
  /** Set only after the authenticated identity is matched to tenantId. */
  tenantVerified?: boolean;
  /** 已授权的跨租户维护路由；由鉴权守卫写入 */
  ignoreTenant?: boolean;
  /**
   * 当前租户隔离级别（M8 T-M8-02）：dedicated 时 @fw/db 的 TenantDataSource
   * 按租户把查询路由到独立库 client；shared / 缺省走默认数据源。
   */
  tenantIsolation?: 'shared' | 'dedicated';
  /**
   * dedicated 租户独立库连接串（M8 T-M8-02）：租户存储解密后的运行时值，
   * 仅进程内经 AsyncLocalStorage 传递给数据源路由，禁止写入日志与审计。
   */
  tenantDbUrl?: string;
}

/** 全局异步上下文存储（进程单例） */
export const requestContextStorage = new AsyncLocalStorage<RequestContext>();

/**
 * span 上下文提供者（M8 T-M8-06 接入 OTel 时由 @fw/telemetry 注册）：
 * 返回当前活跃 span 的 ID 对；未注册时日志回退读请求上下文，行为与本接入前完全一致。
 * 设计为普通函数类型而非 OTel 依赖——@fw/logger 不感知 OpenTelemetry。
 */
type SpanContextProvider = () => { traceId: string; spanId: string } | undefined;

let spanContextProvider: SpanContextProvider | undefined;

/**
 * 注册 span 上下文提供者（@fw/telemetry 启用时调用；幂等，后注册者覆盖）
 * @param provider 提供者函数
 */
export function setSpanContextProvider(provider: SpanContextProvider): void {
  spanContextProvider = provider;
}

/** 读取活跃 span ID（提供者未注册或读取异常时返回 undefined） */
function activeSpanIds(): { traceId: string; spanId: string } | undefined {
  if (!spanContextProvider) return undefined;
  try {
    return spanContextProvider();
  } catch {
    // 桥接异常不得影响日志
    return undefined;
  }
}

/**
 * 生成 traceId：32 位十六进制
 * @returns 新 traceId
 */
export function generateTraceId(): string {
  return randomUUID().replace(/-/g, '');
}

/** ULID Crockford Base32 字母表（无 I/L/O/U，防误读） */
const ULID_ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** requestId（ULID）合法形态：26 位 Crockford Base32（大小写均接受，复用校验用） */
export const REQUEST_ID_PATTERN = /^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/;

/**
 * 生成 requestId：ULID（48 位毫秒时间 + 80 位随机，26 字符，进程内唯一且按时间有序）
 * @returns 新 requestId
 */
export function generateRequestId(): string {
  let time = Date.now();
  let timePart = '';
  for (let i = 0; i < 10; i++) {
    timePart = ULID_ENCODING[time % 32] + timePart;
    time = Math.floor(time / 32);
  }
  const bytes = randomBytes(16);
  let randomPart = '';
  for (let i = 0; i < 16; i++) {
    randomPart += ULID_ENCODING[bytes[i]! & 31];
  }
  return timePart + randomPart;
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
  // 优先取活跃 span（OTel 接入后：span 的 traceId 即链路 ID，跨服务一致）；
  // 无活跃 span 时回退请求上下文（未启用追踪或 span 之外的代码路径）
  return activeSpanIds()?.traceId || requestContextStorage.getStore()?.traceId || '';
}

/**
 * 获取当前 spanId
 * @returns spanId；无上下文时为空串
 */
export function getSpanId(): string {
  return activeSpanIds()?.spanId || requestContextStorage.getStore()?.spanId || '';
}

/**
 * 获取当前 requestId（M12 W2 OBS-09）
 * @returns requestId；无上下文或未启用时为 undefined（如启动阶段日志）
 */
export function getRequestId(): string | undefined {
  return requestContextStorage.getStore()?.requestId;
}
