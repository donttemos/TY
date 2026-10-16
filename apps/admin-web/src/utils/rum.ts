/*
 * @file 前端错误监控 RUM（M10/E-17）
 * @description 轻量实时用户监控：window.error（含资源加载失败，捕获阶段）、unhandledrejection、
 *   Vue errorHandler 三源采集，批量压缩后经 `navigator.sendBeacon`（不可用时 fetch keepalive 兜底）
 *   上报 `POST /telemetry/client-errors`。纪律（PRD-010 E-17）：① fire-and-forget——采集与上报全程
 *   try/catch，任何失败都不得影响业务；② 会话内同签名去重 + 每签名条数上限，防一个 bug 刷爆上报；
 *   ③ 报告携带最近一次后端 traceId（见 utils/request.ts），与后端日志同链关联；
 *   ④ `VITE_RUM_ENABLED=false` 或非浏览器环境整体关闭（零开销）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/utils
 */

import { API_BASE } from './request';
import { getLastTraceId } from './trace';

/** 单批最多携带条数（超出立即 flush，控制单请求体量与后端压力） */
export const RUM_MAX_BATCH = 10;

/** 批量窗口（毫秒）：窗口内累积的条目凑满一批或到时即发 */
export const RUM_FLUSH_INTERVAL_MS = 5000;

/** 同一签名（message+stack）单会话最多上报条数（防一个 bug 循环刷屏） */
export const RUM_MAX_PER_SIGNATURE = 5;

/** 单会话上报总条数上限（安全阀，异常风暴下丢弃超额条目） */
export const RUM_MAX_SESSION = 100;

/** 单字段最大字符数（message / stack 截断，控制载荷） */
const MAX_FIELD_CHARS = 2000;

/** 错误来源：window 未捕获异常 / 未处理 Promise 拒绝 / Vue 渲染或生命周期钩子 / 资源加载失败 */
export type RumSource = 'error' | 'rejection' | 'vue' | 'resource';

/** 单条前端错误上报 */
export interface ClientErrorReport {
  /** 来源 */
  source: RumSource;
  /** 错误消息（截断） */
  message: string;
  /** 堆栈（截断；无堆栈为 null） */
  stack: string | null;
  /** 资源 URL（资源加载失败时；其余为 null） */
  resource: string | null;
  /** 发生页面（pathname + search） */
  page: string;
  /** 完整 URL（含 hash，定位具体视图） */
  url: string;
  /** 最近一次后端响应 traceId（无则 null）——与后端日志同链关联 */
  traceId: string | null;
  /** 同签名第几次上报（1 起） */
  repeat: number;
  /** 采集时间（ISO 8601） */
  at: string;
}

/** 批量上报信封 */
export interface ClientErrorBatch {
  /** 应用标识（采集端按应用分流） */
  app: 'admin-web';
  /** 本条数 */
  reports: ClientErrorReport[];
}

/** 上报端点（与后端 /api/v1/telemetry/client-errors 对应） */
export const CLIENT_ERROR_ENDPOINT = `${API_BASE}/telemetry/client-errors`;

/** 截断字符串（保留前 MAX_FIELD_CHARS 字符） */
export function truncate(value: string, max = MAX_FIELD_CHARS): string {
  return value.length > max ? `${value.slice(0, max)}…` : value;
}

/** 当前页面标识（pathname + search；测试环境无 location 时回退空串） */
function currentPage(): string {
  if (typeof location === 'undefined') return '';
  return `${location.pathname}${location.search}`;
}

/** 当前完整 URL */
function currentUrl(): string {
  if (typeof location === 'undefined') return '';
  return location.href;
}

/**
 * 归一化错误消息：优先取 Error.message，其次 event.message，最后 String(reason)
 * @returns 截断后的消息串
 */
export function normalizeMessage(input: { message?: string | null; reason?: unknown }): string {
  if (typeof input.message === 'string' && input.message) return truncate(input.message);
  if (input.reason !== undefined) {
    if (input.reason instanceof Error) return truncate(input.reason.message || String(input.reason));
    return truncate(String(input.reason));
  }
  return 'unknown error';
}

/**
 * 归一化堆栈：Error.stack / event.error.stack；非 Error  reason 为字符串时也收作堆栈旁证
 * @returns 截断后的堆栈或 null
 */
export function normalizeStack(input: { stack?: string | null; error?: unknown; reason?: unknown }): string | null {
  if (typeof input.stack === 'string' && input.stack) return truncate(input.stack);
  if (input.error instanceof Error && input.error.stack) return truncate(input.error.stack);
  if (typeof input.reason === 'string' && input.reason) return truncate(input.reason);
  if (input.reason instanceof Error && input.reason.stack) return truncate(input.reason.stack);
  return null;
}

/**
 * 去重签名：message + stack 首行（同源同案同签名）
 * @returns 签名字符串
 */
export function signatureOf(report: Pick<ClientErrorReport, 'source' | 'message' | 'stack'>): string {
  const stackHead = (report.stack ?? '').split('\n')[0] ?? '';
  return `${report.source}:${report.message}:${stackHead}`;
}

/** 构造一条上报记录（repeat 由调用方填入） */
export function buildReport(
  source: RumSource,
  input: { message?: string | null; stack?: string | null; error?: unknown; reason?: unknown; resource?: string | null },
  traceId: string | null,
  repeat: number,
  now: () => Date = () => new Date(),
): ClientErrorReport {
  return {
    source,
    message: normalizeMessage(input),
    stack: normalizeStack(input),
    resource: input.resource ?? null,
    page: currentPage(),
    url: currentUrl(),
    traceId,
    repeat,
    at: now().toISOString(),
  };
}

/** 发送批量上报（fire-and-forget：sendBeacon 优先，fetch keepalive 兜底，全部静默失败） */
export function sendBatch(batch: ClientErrorBatch): void {
  try {
    const body = JSON.stringify(batch);
    try {
      if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
        const blob = new Blob([body], { type: 'application/json' });
        if (navigator.sendBeacon(CLIENT_ERROR_ENDPOINT, blob)) return;
      }
    } catch {
      // beacon 被禁用 / 抛错：落到 fetch 兜底（不外抛）
    }
    if (typeof fetch === 'function') {
      void fetch(CLIENT_ERROR_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        keepalive: true,
      }).catch(() => undefined);
    }
  } catch {
    // 上报失败一律静默：RUM 是旁路观测，不得反噬业务
  }
}

/** RUM 采集器 */
export interface RumCollector {
  /** 采集一条错误（内部做去重 / 上限 / 批量） */
  capture(source: RumSource, input: Parameters<typeof buildReport>[1]): void;
  /** 立即冲刷待发批次（pagehide 等场景） */
  flush(): void;
  /** 停止采集并清空待发（卸载 / 测试用） */
  stop(): void;
}

/**
 * 创建 RUM 采集器（不自动挂载监听——由 installRum 完成）
 * @param options 依赖注入（测试可替换 send / traceId 来源 / 时钟）
 */
export function createRumCollector(options: {
  send?: (batch: ClientErrorBatch) => void;
  traceId?: () => string | null;
  now?: () => Date;
  flushIntervalMs?: number;
} = {}): RumCollector {
  const send = options.send ?? sendBatch;
  const traceId = options.traceId ?? (() => getLastTraceId());
  const now = options.now ?? (() => new Date());
  const flushIntervalMs = options.flushIntervalMs ?? RUM_FLUSH_INTERVAL_MS;

  /** 待发批次 */
  let pending: ClientErrorReport[] = [];
  /** 签名 → 已上报条数 */
  const seen = new Map<string, number>();
  /** 会话累计上报条数 */
  let sessionCount = 0;
  let stopped = false;

  function flush(): void {
    if (pending.length === 0) return;
    const reports = pending;
    pending = [];
    try {
      send({ app: 'admin-web', reports });
    } catch {
      // 发送通道异常不得影响采集主链（fire-and-forget）
    }
  }

  function capture(source: RumSource, input: Parameters<typeof buildReport>[1]): void {
    if (stopped) return;
    try {
      // 先按签名去重判定（不构造完整记录也要能算签名：message/stack 归一化是签名的输入）
      const probe = buildReport(source, input, null, 1, now);
      const signature = signatureOf(probe);
      const used = seen.get(signature) ?? 0;
      if (used >= RUM_MAX_PER_SIGNATURE) return;
      if (sessionCount >= RUM_MAX_SESSION) return;
      seen.set(signature, used + 1);
      sessionCount += 1;
      const report: ClientErrorReport = { ...probe, traceId: traceId(), repeat: used + 1 };
      pending.push(report);
      if (pending.length >= RUM_MAX_BATCH) flush();
    } catch {
      // 采集失败不得影响业务（含 buildReport 内部异常）
    }
  }

  const timer = typeof setInterval === 'function' ? setInterval(flush, flushIntervalMs) : null;

  return {
    capture,
    flush,
    stop(): void {
      stopped = true;
      if (timer !== null) clearInterval(timer);
      pending = [];
    },
  };
}

/** 从 ErrorEvent 提取资源 URL（资源加载失败时 event.target 是元素） */
function resourceUrlOf(target: unknown): string | null {
  if (!target || typeof target !== 'object') return null;
  const element = target as { src?: unknown; href?: unknown };
  if (typeof element.src === 'string' && element.src) return element.src;
  if (typeof element.href === 'string' && element.href) return element.href;
  return null;
}

/**
 * 安装 RUM：window error（含资源加载失败）/ unhandledrejection / Vue errorHandler
 * @param app Vue 应用实例（挂 errorHandler）
 * @param collector 采集器（缺省自建）
 * @returns 卸载函数（测试 / HMR 用）
 */
export function installRum(app: unknown, collector: RumCollector = createRumCollector()): () => void {
  if (typeof window === 'undefined') return () => undefined;

  const onError = (event: Event): void => {
    const errorEvent = event as ErrorEvent & { target?: unknown };
    const resource = resourceUrlOf(errorEvent.target);
    if (resource) {
      collector.capture('resource', { message: `资源加载失败：${resource}`, resource });
      return;
    }
    collector.capture('error', {
      message: errorEvent.message,
      stack: errorEvent.error instanceof Error ? errorEvent.error.stack : null,
      error: errorEvent.error,
    });
  };

  const onRejection = (event: Event): void => {
    const promiseEvent = event as PromiseRejectionEvent;
    collector.capture('rejection', { reason: promiseEvent.reason });
  };

  // 页面隐藏 / 卸载时冲刷（sendBeacon 在 pagehide 后仍可送达）
  const onPageHide = (): void => collector.flush();
  const onVisibility = (): void => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') collector.flush();
  };

  window.addEventListener('error', onError, true);
  window.addEventListener('unhandledrejection', onRejection);
  window.addEventListener('pagehide', onPageHide);
  document.addEventListener('visibilitychange', onVisibility);

  // Vue 渲染 / 生命周期 / watch 回调中的未捕获异常
  const vueApp = app as { config?: { errorHandler?: (err: unknown, instance: unknown, info: string) => void } };
  const previousHandler = vueApp.config?.errorHandler;
  vueApp.config = vueApp.config ?? {};
  vueApp.config!.errorHandler = (err: unknown, _instance: unknown, info: string): void => {
    collector.capture('vue', {
      message: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : null,
      error: err,
    });
    // 保留调用方已注册的 errorHandler（不吞既有行为）
    previousHandler?.(err, _instance, info);
  };

  return () => {
    window.removeEventListener('error', onError, true);
    window.removeEventListener('unhandledrejection', onRejection);
    window.removeEventListener('pagehide', onPageHide);
    document.removeEventListener('visibilitychange', onVisibility);
    if (vueApp.config && previousHandler) vueApp.config.errorHandler = previousHandler;
    collector.stop();
  };
}
