/*
 * @file 尾采样处理器单测
 * @description 覆盖 traceIdRatio 确定性与边界、错误全采、比例采样、丢弃回调与 flush/shutdown 委派。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { describe, expect, it, vi } from 'vitest';
import { RatioErrorSamplingProcessor, traceIdRatio } from '../sampling.js';
import type { ReadableSpanLike, SpanExporterLike } from '../types.js';

/** 构造只读 span 桩 */
function makeSpan(overrides: Partial<ReadableSpanLike> & { traceId: string }): ReadableSpanLike {
  return {
    name: 'test-span',
    spanContext: () => ({ traceId: overrides.traceId, spanId: 'a'.repeat(16), traceFlags: 1 }),
    status: { code: 0 },
    events: [],
    kind: 1,
    attributes: {},
    ...overrides,
  };
}

/** 记录导出调用的假导出器 */
function makeExporter(): SpanExporterLike & { exported: unknown[][]; flushes: number; shutdowns: number } {
  const exported: unknown[][] = [];
  return {
    exported,
    flushes: 0,
    shutdowns: 0,
    export(spans, callback) {
      exported.push(spans);
      callback({});
    },
    async forceFlush() {
      this.flushes += 1;
    },
    async shutdown() {
      this.shutdowns += 1;
    },
  };
}

describe('traceIdRatio', () => {
  it('同一 traceId 结果恒定（跨服务一致性基础）', () => {
    const traceId = '4dfac34ee5bad41cb229703437e8fcc0';
    expect(traceIdRatio(traceId)).toBe(traceIdRatio(traceId));
  });

  it('取值落在 [0,1) 且由低 8 位决定', () => {
    const ratio = traceIdRatio('000000000000000000000000000000ff');
    expect(ratio).toBeCloseTo(255 / 2 ** 32, 10);
    expect(traceIdRatio('00000000000000000000000000000000')).toBe(0);
    expect(traceIdRatio('ffffffffffffffffffffffffffffffff')).toBeLessThan(1);
  });

  it('非法 traceId 返回 0', () => {
    expect(traceIdRatio('')).toBe(0);
    expect(traceIdRatio('xyz')).toBe(0);
    expect(traceIdRatio('4dfac34ee5bad41cb229703437e8fcc')).toBe(0); // 31 位
  });
});

describe('RatioErrorSamplingProcessor', () => {
  it('错误 span 全采：ratio=0 也导出', () => {
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 0, sampleErrors: true });
    processor.onEnd(makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff', status: { code: 2 } }));
    expect(exporter.exported).toHaveLength(1);
  });

  it('exception 事件同样触发全采', () => {
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 0, sampleErrors: true });
    processor.onEnd(makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff', events: [{ name: 'exception' }] }));
    expect(exporter.exported).toHaveLength(1);
  });

  it('sampleErrors=false 时错误 span 也按比例', () => {
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 0, sampleErrors: false });
    processor.onEnd(makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff', status: { code: 2 } }));
    expect(exporter.exported).toHaveLength(0);
  });

  it('非错误 span 按 traceId 比例决策', () => {
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 0.5, sampleErrors: true });
    processor.onEnd(makeSpan({ traceId: '00000000000000000000000000000001' })); // ratio≈0 → 导出
    processor.onEnd(makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff' })); // ratio≈1 → 丢弃
    expect(exporter.exported).toHaveLength(1);
  });

  it('ratio=1 全采；ratio=0 且无错误全丢', () => {
    const all = makeExporter();
    const allProcessor = new RatioErrorSamplingProcessor(all, { sampleRatio: 1, sampleErrors: true });
    allProcessor.onEnd(makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff' }));
    expect(all.exported).toHaveLength(1);

    const none = makeExporter();
    const noneProcessor = new RatioErrorSamplingProcessor(none, { sampleRatio: 0, sampleErrors: true });
    noneProcessor.onEnd(makeSpan({ traceId: '00000000000000000000000000000001' }));
    expect(none.exported).toHaveLength(0);
  });

  it('丢弃 span 触发 onDropped 回调', () => {
    const onDropped = vi.fn();
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, {
      sampleRatio: 0,
      sampleErrors: true,
      onDropped,
    });
    processor.onEnd(makeSpan({ traceId: 'ffffffffffffffffffffffffffffffff' }));
    expect(onDropped).toHaveBeenCalledTimes(1);
  });

  it('forceFlush / shutdown 委派导出器', async () => {
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 0.1, sampleErrors: true });
    await processor.forceFlush();
    await processor.shutdown();
    expect(exporter.flushes).toBe(1);
    expect(exporter.shutdowns).toBe(1);
  });

  it('导出器缺 forceFlush/shutdown 时不报错', async () => {
    const exported: unknown[][] = [];
    const exporter: SpanExporterLike = {
      export(spans, callback) {
        exported.push(spans);
        callback({});
      },
    };
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 1, sampleErrors: true });
    processor.onEnd(makeSpan({ traceId: '00000000000000000000000000000001' }));
    await expect(processor.forceFlush()).resolves.toBeUndefined();
    await expect(processor.shutdown()).resolves.toBeUndefined();
    expect(exported).toHaveLength(1);
  });

  it('onStart 为无动作（记录决策全部后置 onEnd）', () => {
    const exporter = makeExporter();
    const processor = new RatioErrorSamplingProcessor(exporter, { sampleRatio: 0, sampleErrors: true });
    expect(() => processor.onStart()).not.toThrow();
    expect(exporter.exported).toHaveLength(0);
  });
});
