/*
 * @file logger 自动身份字段契约（PRD-012 OBS-11，ADR-0026）
 * @description ① 身份字段（userId/requestId/familyId/jti）由 ALS 自动读取进 LogRecord 顶层（调用方零成本）；
 *   ② 反向验证：调用方手塞同名 ctx 不覆盖顶层自动字段（身份以鉴权事实为准）；
 *   ③ LOG_IDENTITY_FIELDS 门控输出集（默认 userId,requestId；空串关闭全部）；
 *   ④ 无上下文时字段缺席（启动期日志零回归，additive 不破坏既有断言）。
 * @author donttemo
 * @created 2026-10-17
 * @module logger
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  Logger,
  configureLogger,
  generateRequestId,
  resetIdentityFieldsCache,
  runWithRequestContext,
  type LogRecord,
} from '../index.js';

/** 捕获 sink */
function capture(): { lines: string[] } {
  const lines: string[] = [];
  configureLogger({ sink: (line) => lines.push(line) });
  return { lines };
}

function parse(lines: string[], keyword: string): LogRecord {
  const line = lines.find((l) => l.includes(keyword));
  expect(line, `应存在包含 ${keyword} 的日志行`).toBeDefined();
  return JSON.parse(line!) as LogRecord;
}

describe('M12 W2 · logger 自动身份（OBS-11）', () => {
  afterEach(() => {
    delete process.env.LOG_IDENTITY_FIELDS;
    resetIdentityFieldsCache();
  });

  it('ALS 身份字段自动进顶层（调用方零成本；默认集 = userId,requestId）', () => {
    const { lines } = capture();
    const requestId = generateRequestId();
    runWithRequestContext(
      { traceId: 't-identity-1', spanId: '', requestId, userId: 'u-1', familyId: 'fam-1', jti: 'j-1' },
      () => Logger.for('identity-test').info('身份日志'),
    );
    const record = parse(lines, '身份日志');
    expect(record.requestId).toBe(requestId);
    expect(record.userId).toBe('u-1');
    // 默认集不含 familyId / jti（低开销默认集），不落顶层
    expect(record.familyId).toBeUndefined();
    expect(record.jti).toBeUndefined();
    // traceId 既有行为不变
    expect(record.traceId).toBe('t-identity-1');
  });

  it('LOG_IDENTITY_FIELDS 全集开启 familyId/jti', () => {
    process.env.LOG_IDENTITY_FIELDS = 'userId,requestId,familyId,jti';
    resetIdentityFieldsCache();
    const { lines } = capture();
    runWithRequestContext(
      { traceId: 't', spanId: '', requestId: generateRequestId(), userId: 'u-2', familyId: 'fam-2', jti: 'j-2' },
      () => Logger.for('identity-test').info('全集日志'),
    );
    const record = parse(lines, '全集日志');
    expect(record.familyId).toBe('fam-2');
    expect(record.jti).toBe('j-2');
  });

  it('反向验证：调用方手塞同名 ctx 不覆盖顶层自动字段', () => {
    const { lines } = capture();
    // ctx 里塞伪造身份——顶层自动字段必须仍是 ALS 事实值（身份以鉴权事实为准）
    runWithRequestContext(
      { traceId: 't', spanId: '', requestId: generateRequestId(), userId: 'real-user' },
      () => Logger.for('identity-test').info('伪造身份日志', { userId: 'fake-user', requestId: 'fake-rid' }),
    );
    const record = parse(lines, '伪造身份日志');
    expect(record.userId).toBe('real-user');
    expect(record.userId).not.toBe('fake-user');
    expect(record.requestId).not.toBe('fake-rid');
    // 伪造值只留在 ctx 内（经脱敏管道）
    expect(JSON.stringify(record.ctx ?? {})).toContain('fake-user');
  });

  it('LOG_IDENTITY_FIELDS=空串关闭全部自动身份字段', () => {
    process.env.LOG_IDENTITY_FIELDS = '';
    resetIdentityFieldsCache();
    const { lines } = capture();
    runWithRequestContext(
      { traceId: 't', spanId: '', requestId: generateRequestId(), userId: 'u-3' },
      () => Logger.for('identity-test').info('关闭身份日志'),
    );
    const record = parse(lines, '关闭身份日志');
    expect(record.userId).toBeUndefined();
    expect(record.requestId).toBeUndefined();
  });

  it('无上下文时身份字段缺席（启动期日志零回归）', () => {
    const { lines } = capture();
    Logger.for('identity-test').info('无上下文日志');
    const record = parse(lines, '无上下文日志');
    expect(record.userId).toBeUndefined();
    expect(record.requestId).toBeUndefined();
    expect(record.traceId).toBe('');
  });
});
