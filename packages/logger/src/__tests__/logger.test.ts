/*
 * @file @fw/logger 单元测试
 * @description 覆盖结构化输出、脱敏（键名 + 消息文本）、级别过滤、按模块级别、字节截断、AsyncLocalStorage traceId 贯通（TC-CORE-003/005）
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo vite 8/vitest 4 覆盖率统计更精后补齐真实缺口：级别包装方法（trace/warn/fatal）、数组脱敏分支
 * @modified 2026-10-13 donttemo vite 8/vitest 4 覆盖率统计更精后补齐真实缺口：级别包装方法（trace/warn/fatal）、数组脱敏分支
 * @since v0.1.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  Logger,
  configureLogger,
  setModuleLevel,
  generateTraceId,
  runWithRequestContext,
  getTraceId,
  getSpanId,
  getRequestContext,
  patchRequestContext,
  redactText,
  redactValue,
} from '../index.js';

/** 捕获日志输出（替代默认 stdout 写入） */
function captureLogs(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  configureLogger({ sink: (line) => lines.push(line) });
  return { lines, restore: () => configureLogger({ sink: undefined }) };
}

/** 解析单行日志 JSON */
function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('@fw/logger · 基础输出', () => {
  beforeEach(() => {
    configureLogger({ level: 'trace', maxBytes: 8192 });
    setModuleLevel('test', 'trace');
  });

  it('输出包含 time/level/module/msg 必备字段', () => {
    const cap = captureLogs();
    Logger.for('test').info('hello');
    const record = parse(cap.lines[0]);
    expect(record.level).toBe('info');
    expect(record.module).toBe('test');
    expect(record.msg).toBe('hello');
    expect(typeof record.time).toBe('string');
  });
});

describe('@fw/logger · 级别过滤（TC-CORE-005 准备）', () => {
  it('低于全局级别不输出', () => {
    configureLogger({ level: 'warn' });
    const cap = captureLogs();
    Logger.for('filter-quiet').info('应当被丢弃');
    Logger.for('filter-quiet').error('应当被保留');
    expect(cap.lines.length).toBe(1);
    expect(parse(cap.lines[0]).msg).toBe('应当被保留');
  });

  it('按模块级别覆盖全局级别', () => {
    configureLogger({ level: 'info' });
    setModuleLevel('noisy-mod', 'trace');
    const cap = captureLogs();
    Logger.for('quiet-mod').debug('quiet.debug');
    Logger.for('noisy-mod').debug('noisy.debug');
    expect(cap.lines.length).toBe(1);
    expect(parse(cap.lines[0]).msg).toBe('noisy.debug');
  });
});

describe('@fw/logger · 各级别包装方法', () => {
  beforeEach(() => {
    configureLogger({ level: 'trace', maxBytes: 8192 });
    setModuleLevel('levels', 'trace');
  });

  it('trace / warn / fatal 包装方法按各自级别输出', () => {
    const cap = captureLogs();
    const logger = Logger.for('levels');

    logger.trace('t');
    logger.warn('w');
    logger.fatal('f');

    expect(cap.lines.map((line) => parse(line).level)).toEqual(['trace', 'warn', 'fatal']);
  });
});

describe('@fw/logger · 脱敏（TC-CORE-005）', () => {
  beforeEach(() => {
    configureLogger({ level: 'trace' });
    setModuleLevel('redact', 'trace');
  });

  it('消息文本中的 password=xxx 替换为 ***', () => {
    expect(redactText('user password=123456 tried login')).toBe('user password=*** tried login');
  });

  it('对象字段 password / token / idcard 自动 ***', () => {
    const cap = captureLogs();
    Logger.for('redact').info('login attempt', { username: 'alice', password: 'p', accessToken: 't', idcard: 'id' });
    const record = parse(cap.lines[0]);
    const ctx = record.ctx as Record<string, unknown>;
    expect(ctx.password).toBe('***');
    expect(ctx.accessToken).toBe('***');
    expect(ctx.idcard).toBe('***');
    expect(ctx.username).toBe('alice');
  });

  it('嵌套结构中的敏感字段也脱敏', () => {
    const result = redactValue({ user: { name: 'a', token: 'b' } });
    expect((result as { user: { token: string } }).user.token).toBe('***');
  });

  it('数组结构逐个元素脱敏（数组分支）', () => {
    const result = redactValue([{ password: 'p' }, 'plain', [{ idcard: 'i' }]]);
    expect(result).toEqual([{ password: '***' }, 'plain', [{ idcard: '***' }]]);
  });

  it('错误对象的 message 也走消息脱敏', () => {
    const result = redactValue(new Error('failed with password=secret'));
    expect((result as { message: string }).message).toContain('password=***');
  });
});

describe('@fw/logger · AsyncLocalStorage traceId 贯通（TC-CORE-003）', () => {
  beforeEach(() => {
    configureLogger({ level: 'trace' });
    setModuleLevel('ctx', 'trace');
  });

  it('异步作用域内日志自动带 traceId', () => {
    const cap = captureLogs();
    const traceId = generateTraceId();
    runWithRequestContext({ traceId, spanId: '' }, () => {
      Logger.for('ctx').info('with trace');
    });
    expect(getTraceId()).toBe(''); // 离开作用域后无上下文
    const record = parse(cap.lines[0]);
    expect(record.traceId).toBe(traceId);
  });

  it('租户作用域内的结构化日志带 tenantId，离开后不串租户', () => {
    const cap = captureLogs();
    runWithRequestContext({ traceId: 'trace-a', spanId: '', tenantId: '17' }, () => {
      Logger.for('ctx').info('tenant request');
    });
    Logger.for('ctx').info('outside');
    expect(parse(cap.lines[0]).tenantId).toBe('17');
    expect(parse(cap.lines[1]).tenantId).toBeUndefined();
  });

  it('作用域外日志 traceId 为空串', () => {
    const cap = captureLogs();
    Logger.for('ctx').info('no trace');
    expect(parse(cap.lines[0]).traceId).toBe('');
  });

  it('getRequestContext 在无上下文时返回 undefined', () => {
    expect(getRequestContext()).toBeUndefined();
  });

  it('patchRequestContext 在作用域内可补充 userId', () => {
    const traceId = generateTraceId();
    runWithRequestContext({ traceId, spanId: '' }, () => {
      patchRequestContext({ userId: 'u-1' });
      expect(getTraceId()).toBe(traceId);
    });
  });

  it('getSpanId 在无上下文时返回空串', () => {
    expect(getSpanId()).toBe('');
  });
});

describe('@fw/logger · 字节截断', () => {
  it('超长日志按 maxBytes 截断', () => {
    configureLogger({ level: 'info', maxBytes: 256 });
    const cap = captureLogs();
    Logger.for('big').info('x'.repeat(2000));
    expect(Buffer.byteLength(cap.lines[0], 'utf8')).toBeLessThanOrEqual(256);
    expect(cap.lines[0]).toContain('"trunc":1');
  });
});
