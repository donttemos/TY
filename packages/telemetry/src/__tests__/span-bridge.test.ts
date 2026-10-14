/*
 * @file span 桥接单测（真实 SDK 在场）
 * @description 覆盖活跃 span 读取、桥接注册后 logger 取数、span 之外的回退。
 *   注意：本文件注册了全局 tracer provider，故 tracer 产出记录态 span（真实 ID）。
 *   未注册 SDK 的 noop 场景见 span-bridge-noop.test.ts（vitest 按文件隔离模块注册表）。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { trace } from '@opentelemetry/api';
// 0.223 起 NodeTracerProvider 位于 sdk-node 的 node 命名空间（顶层无该命名导出）
import * as sdk from '@opentelemetry/sdk-node';
import { getSpanId, getTraceId, runWithRequestContext } from '@fw/logger';
import { readActiveSpanIds, registerLoggerSpanBridge } from '../span-bridge.js';

describe('readActiveSpanIds（SDK 已注册）', () => {
  const provider = new sdk.node.NodeTracerProvider();

  beforeAll(() => {
    provider.register();
    registerLoggerSpanBridge();
  });

  afterAll(async () => {
    await provider.shutdown();
  });

  it('活跃 span 内返回 span 的 traceId/spanId', () => {
    const tracer = trace.getTracer('bridge-test');
    tracer.startActiveSpan('outer', (span) => {
      const ids = readActiveSpanIds();
      expect(ids?.traceId).toBe(span.spanContext().traceId);
      expect(ids?.spanId).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it('span 之外返回 undefined', () => {
    expect(readActiveSpanIds()).toBeUndefined();
  });

  it('桥接注册后 logger 的 traceId/spanId 取自活跃 span', () => {
    const tracer = trace.getTracer('bridge-test');
    tracer.startActiveSpan('logged', (span) => {
      expect(getTraceId()).toBe(span.spanContext().traceId);
      expect(getSpanId()).toBe(span.spanContext().spanId);
      span.end();
    });
  });

  it('span 之外回退请求上下文（ALS 里的 traceId）', () => {
    runWithRequestContext({ traceId: 'a'.repeat(32), spanId: '' }, () => {
      expect(getTraceId()).toBe('a'.repeat(32));
      expect(getSpanId()).toBe('');
    });
    // 无 ALS 无 span：空串（未启用追踪时的既有行为）
    expect(getTraceId()).toBe('');
  });
});
