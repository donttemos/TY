/*
 * @file M12 W1 日志错误码一等字段单测（PRD-012 OBS-05，ADR-0025）
 * @description 验证 LogOptions.code 升为 LogRecord 顶层字段：传入即输出、缺省不出现（形状不漂移）、
 *   与 ctx 并存互不干扰。
 * @author donttemo
 * @created 2026-10-17
 * @module @fw/logger
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { Logger, configureLogger, setModuleLevel } from '../index.js';

function captureLogs(): { lines: string[] } {
  const lines: string[] = [];
  configureLogger({ sink: (line) => lines.push(line) });
  return { lines };
}

function parse(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

describe('@fw/logger · 错误码一等字段（PRD-012 OBS-05）', () => {
  beforeEach(() => {
    configureLogger({ level: 'trace', maxBytes: 8192 });
    setModuleLevel('obs-code', 'trace');
  });

  it('LogOptions.code 输出为顶层字段（非 ctx 内嵌）', () => {
    const { lines } = captureLogs();
    Logger.for('obs-code').error('请求异常', { message: 'x' }, { code: 3001 });
    const record = parse(lines[lines.length - 1]!);
    expect(record.code).toBe(3001);
    expect((record.ctx as Record<string, unknown>).message).toBe('x');
  });

  it('不传 options 时无 code 字段（既有调用零回归）', () => {
    const { lines } = captureLogs();
    Logger.for('obs-code').info('plain');
    const record = parse(lines[lines.length - 1]!);
    expect('code' in record).toBe(false);
  });

  it('ctx 内同名 code 不被顶层字段吞掉（两层互不干扰）', () => {
    const { lines } = captureLogs();
    Logger.for('obs-code').warn('both', { code: 'ctx-value' }, { code: 1001 });
    const record = parse(lines[lines.length - 1]!);
    expect(record.code).toBe(1001);
    expect((record.ctx as Record<string, unknown>).code).toBe('ctx-value');
  });
});
