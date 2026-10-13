/*
 * @file 结构化日志器
 * @description 输出字段固定为 time/level/traceId/spanId/module/msg/ctx 的单行 JSON（stdout，容器友好）；支持全局与按 module 级别、单条字节截断；ctx 与 msg 输出前强制脱敏。
 * @author donttemo
 * @created 2026-10-09
 * @module logger
 * @since v0.1.0
 */
import { getSpanId, getTraceId } from './context.js';
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
  module: string;
  msg: string;
  ctx?: unknown;
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
  trace(msg: string, ctx?: unknown): void {
    this.write('trace', msg, ctx);
  }

  /** 输出 debug 级日志 */
  debug(msg: string, ctx?: unknown): void {
    this.write('debug', msg, ctx);
  }

  /** 输出 info 级日志 */
  info(msg: string, ctx?: unknown): void {
    this.write('info', msg, ctx);
  }

  /** 输出 warn 级日志 */
  warn(msg: string, ctx?: unknown): void {
    this.write('warn', msg, ctx);
  }

  /** 输出 error 级日志（ctx 传 Error 时输出 name/message，不含堆栈避免噪声） */
  error(msg: string, ctx?: unknown): void {
    this.write('error', msg, ctx);
  }

  /** 输出 fatal 级日志 */
  fatal(msg: string, ctx?: unknown): void {
    this.write('fatal', msg, ctx);
  }

  /** 按级别权重决定是否输出并写出单行 JSON */
  private write(level: LogLevel, msg: string, ctx?: unknown): void {
    const threshold = moduleLevels.get(this.moduleName) ?? defaults.level;
    if (LEVEL_WEIGHT[level] < LEVEL_WEIGHT[threshold]) return;

    const record: LogRecord = {
      time: new Date().toISOString(),
      level,
      traceId: getTraceId(),
      spanId: getSpanId(),
      module: this.moduleName,
      msg: redactText(msg),
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
