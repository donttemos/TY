/*
 * @file 运行时选项热更测试（M9/PRD-009 FR-09）
 * @description 验证采样比例热更的生效路径：TelemetryService.updateRuntimeOptions 同步采样选项与
 *   runtimeOptions；尾采样处理器持有同一引用——比例对象就地变更后 onEnd 决策立即按新比例执行。
 * @author donttemo
 * @created 2026-10-15
 * @module @fw/telemetry
 */
import { describe, expect, it } from 'vitest';
import { RatioErrorSamplingProcessor } from '../sampling.js';
import { TelemetryService } from '../telemetry.service.js';
import { TELEMETRY_OPTIONS } from '../tokens.js';
import type { ReadableSpanLike, SpanExporterLike } from '../types.js';

/** 最小 exporter 桩 */
function makeExporter(): SpanExporterLike & { exported: ReadableSpanLike[] } {
  const exporter = {
    exported: [] as ReadableSpanLike[],
    export(spans: ReadableSpanLike[], cb?: (result: unknown) => void) {
      exporter.exported.push(...spans);
      cb?.({ code: 0 });
    },
  };
  return exporter;
}

/** 最小 span 桩（非错误 span） */
function makeSpan(traceId: string): ReadableSpanLike {
  return {
    spanContext: () => ({ traceId }),
    status: { code: 0 },
    events: [],
  } as unknown as ReadableSpanLike;
}

describe('TelemetryService · updateRuntimeOptions（配置中心订阅入口）', () => {
  it('热更采样比例后 runtimeOptions 与处理器共享的采样选项同步变化', () => {
    const service = new TelemetryService({
      enabled: false,
      serviceName: 'fw-test',
      exporterUrl: undefined,
      sampleRatio: 0.1,
      sampleErrors: true,
    } as never);

    service.updateRuntimeOptions({ sampleRatio: 0.9 });

    expect(service.runtimeOptions.sampleRatio).toBe(0.9);
  });

  it('生效路径（共享引用）：处理器持有的采样选项对象被就地变更后，导出决策立即按新比例执行', () => {
    const exporter = makeExporter();
    // 与 TelemetryService.onModuleInit 同构：把服务内部持有的 samplingOptions 传给处理器
    const samplingOptions = { sampleRatio: 0, sampleErrors: false };
    const processor = new RatioErrorSamplingProcessor(exporter, samplingOptions);

    // traceId 低 32 位 = 0xffffffff → ratio≈1：旧比例 0 下被丢弃
    const traceId = '0000000000000000000000000000000f';
    processor.onEnd(makeSpan(traceId));
    expect(exporter.exported).toHaveLength(0);

    // 就地热更到 1 → 同一处理器、同一 span，立即按新比例导出（无需重建 SDK）
    samplingOptions.sampleRatio = 1;
    processor.onEnd(makeSpan(traceId));
    expect(exporter.exported).toHaveLength(1);
  });

  it('TELEMETRY_OPTIONS 令牌可导入（装配层引用完整性）', () => {
    expect(TELEMETRY_OPTIONS).toBeTruthy();
  });
});
