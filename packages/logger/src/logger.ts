/*
 * @file 结构化日志器
 * @description 输出字段固定为 time/level/traceId/spanId/module/msg/ctx 的单行 JSON（stdout，容器友好）；支持全局与按 module 级别、单条字节截断；ctx 与 msg 输出前强制脱敏。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-05）：错误码升为 LogRecord 一等字段——
 *   级别方法增可选 LogOptions.code，与 ErrorBody.code / 审计同源，按码检索与告警规则直接消费
 * @modified 2026-10-17 donttemo M12 W2（PRD-012 OBS-11，ADR-0026）：logger 自动输出身份——
 *   LogRecord 增 userId / requestId / familyId / jti（由 ALS 自动读取，调用方零成本）；
 *   LOG_IDENTITY_FIELDS 决定输出集（默认 userId,requestId）；调用方手塞同名 ctx 不覆盖自动字段
 * @module logger
 * @since v0.1.0
 */
import { getRequestContext, getRequestId, getSpanId, getTraceId } from './context.js';
import { redactText, redactValue } from './redact.js';

/** 日志级别，数值越大优先级越高 */
export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error' | 'fatal';

/** 级别权重表 */
const LEVEL_WEIGHT: Record<LogLevel, number> = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

/** 日志输出目标（测试可注入捕获） */
export type LogSink = (line: string) => void;

/** 全局配置 */
interface GlobalOptions {
  /** 全局最低输出级别 */
  level: LogLevel;
  /** 单条日志最大字节数 */
  maxBytes: number;
  /** 输出目标，默认 stdout */
  sink: LogSink;
}

const defaults: GlobalOptions = {
  level: 'info',
  maxBytes: 8192,
  sink: (line) => process.stdout.write(line + '\n'),
};

/** 按模块覆盖的级别表 */
const moduleLevels = new Map<string, LogLevel>();

/**
 * 注入运行配置（bootstrap 时从 @fw/config 读取后调用一次）
 * @param options 部分全局选项
 */
export function configureLogger(options: Partial<Omit<GlobalOptions, 'sink'>> & { sink?: LogSink }): void {
  Object.assign(defaults, options);
}

/**
 * 设置单个模块的最低输出级别（优先于全局）
 * @param moduleName 模块名
 * @param level 级别
 */
export function setModuleLevel(moduleName: string, level: LogLevel): void {
  moduleLevels.set(moduleName, level);
}

/** 一条日志的完整结构（与 docs/20-architecture.md §5.6 对齐） */
export interface LogRecord {
  time: string;
  level: LogLevel;
  traceId: string;
  spanId: string;
  /** 单次请求 ID（M12 W2 OBS-11：ALS 自动读取，非调用方手塞） */
  requestId?: string;
  /** 当前用户 ID（opaque id，M12 W2 OBS-11：ALS 自动读取——沿 tenantId「顶层字段 + 自动取」先例） */
  userId?: string;
  /** 令牌家族 ID（M12 W2 OBS-11；LOG_IDENTITY_FIELDS 默认不含，按需开启） */
  familyId?: string;
  /** 令牌标识 jti（非令牌本体，可记录；M12 W2 OBS-11；LOG_IDENTITY_FIELDS 默认不含） */
  jti?: string;
  tenantId?: string;
  module: string;
  msg: string;
  /** 业务错误码（PRD-012 OBS-05：错误码为日志一等字段，与 ErrorBody.code / 审计同源，可按码检索） */
  code?: number;
  ctx?: unknown;
}

/** 身份字段白名单（LOG_IDENTITY_FIELDS，默认 userId,requestId——低开销默认集） */
const DEFAULT_IDENTITY_FIELDS = ['userId', 'requestId'];
let identityFields: Set<string> | null = null;

/** 解析身份字段集（懒加载一次；未配置取默认集，显式空串关闭全部自动身份字段） */
function getIdentityFields(): Set<string> {
  if (identityFields) return identityFields;
  const raw = process.env.LOG_IDENTITY_FIELDS;
  const fields = raw === undefined
    ? DEFAULT_IDENTITY_FIELDS
    : raw.trim() === ''
      ? []
      : raw.split(',').map((s) => s.trim()).filter(Boolean);
  identityFields = new Set(fields);
  return identityFields;
}

/** 重置身份字段缓存（LOG_IDENTITY_FIELDS 变更后生效；测试注入用） */
export function resetIdentityFieldsCache(): void {
  identityFields = null;
}

/** 日志附加选项（PRD-012 OBS-05） */
export interface LogOptions {
  /** 业务错误码：升为 LogRecord 顶层字段（非 ctx 内嵌），结构化检索 / 告警规则直接消费 */
  code?: number;
}

/**
 * 结构化日志器实例：通过 Logger.for('模块名') 获取
 */
export class Logger {
  private readonly moduleName: string;

  private constructor(moduleName: string) {
    this.moduleName = moduleName;
  }

  /**
   * 获取模块日志器
   * @param moduleName 模块名（出现在每条日志的 module 字段）
   */
  static for(moduleName: string): Logger {
    return new Logger(moduleName);
  }

  /** 输出 trace 级日志 */
  trace(msg: string, ctx?: unknown, options?: LogOptions): void {
    this.write('trace', msg, ctx, options);
  }

  /** 输出 debug 级日志 */
  debug(msg: string, ctx?: unknown, options?: LogOptions): void {
    this.write('debug', msg, ctx, options);
  }

  /** 输出 info 级日志 */
  info(msg: string, ctx?: unknown, options?: LogOptions): void {
    this.write('info', msg, ctx, options);
  }

  /** 输出 warn 级日志 */
  warn(msg: string, ctx?: unknown, options?: LogOptions): void {
    this.write('warn', msg, ctx, options);
  }

  /** 输出 error 级日志（ctx 传 Error 时输出 name/message，不含堆栈避免噪声） */
  error(msg: string, ctx?: unknown, options?: LogOptions): void {
    this.write('error', msg, ctx, options);
  }

  /** 输出 fatal 级日志 */
  fatal(msg: string, ctx?: unknown, options?: LogOptions): void {
    this.write('fatal', msg, ctx, options);
  }

  /** 按级别权重决定是否输出并写出单行 JSON */
  private write(level: LogLevel, msg: string, ctx?: unknown, options?: LogOptions): void {
    const threshold = moduleLevels.get(this.moduleName) ?? defaults.level;
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;

    const store = getRequestContext();
    const identity = getIdentityFields();
    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      traceId: getTraceId(),
      spanId: getSpanId(),
      ...(store?.tenantId ? { tenantId: store.tenantId } : {}),
      // M12 W2 OBS-11：身份字段由 ALS 自动读取（调用方手塞 ctx 不覆盖顶层自动字段——身份以鉴权事实为准）
      ...(identity.has('requestId') && getRequestId() ? { requestId: getRequestId() } : {}),
      ...(identity.has('userId') && store?.userId ? { userId: store.userId } : {}),
      ...(identity.has('familyId') && store?.familyId ? { familyId: store.familyId } : {}),
      ...(identity.has('jti') && store?.jti ? { jti: store.jti } : {}),
      module: this.moduleName,
      msg: redactText(msg),
      ...(options?.code !== undefined ? { code: options.code } : {}),
    };
    if (ctx !== undefined) record.ctx = redactValue(ctx);

    let line = JSON.stringify(record);
    // 超长截断：字节级控制，容器日志采集友好
    if (Buffer.byteLength(line, 'utf8') > defaults.maxBytes) {
      line = line.slice(0, defaults.maxBytes - 14) + '","trunc":1}';
    }
    defaults.sink(line);
  }
}
