/*
 * @file span 桥接单测（未注册 SDK 的 noop 场景）
 * @description 本文件不注册全局 tracer provider：tracer 产出 noop span（全零上下文），
 *   桥接必须将其过滤，使日志回退请求上下文而非写入全零 ID。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
import { getTraceId, runWithRequestContext } from '@fw/logger';
import { readActiveSpanIds, registerLoggerSpanBridge } from '../span-bridge.js';

describe('readActiveSpanIds（未注册 SDK）', () => {
  it('noop span 的全零上下文被过滤', () => {
    const tracer = trace.getTracer('noop-probe');
    tracer.startActiveSpan('noop', (span) => {
      // 未注册 provider：span 为非记录态，上下文全零
      expect(span.isRecording()).toBe(false);
      expect(readActiveSpanIds()).toBeUndefined();
      span.end();
    });
  });

  it('注册桥接后 logger 仍取请求上下文 traceId（不被全零污染）', () => {
    registerLoggerSpanBridge();
    runWithRequestContext({ traceId: 'b'.repeat(32), spanId: '' }, () => {
      trace.getTracer('noop-probe').startActiveSpan('noop', (span) => {
        expect(getTraceId()).toBe('b'.repeat(32));
        span.end();
      });
    });
  });
});
