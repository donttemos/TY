/*
 * @file buildTelemetryOptions 单测
 * @description 覆盖默认值、环境变量来源、overrides 优先与服务名兜底。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { describe, expect, it } from 'vitest';
import { buildTelemetryOptions, TELEMETRY_DEFAULTS } from '../options.js';

describe('buildTelemetryOptions', () => {
  it('空环境取默认值：disabled / 比例 0.1 / 错误全采', () => {
    const options = buildTelemetryOptions({});
    expect(options.enabled).toBe(false);
    expect(options.sampleRatio).toBe(0.1);
    expect(options.sampleErrors).toBe(true);
    expect(options.exporterUrl).toBeUndefined();
  });

  it('服务名缺省取 fw-<APP_ENV>', () => {
    expect(buildTelemetryOptions({ APP_ENV: 'prod' }).serviceName).toBe('fw-prod');
    expect(buildTelemetryOptions({}).serviceName).toBe('fw-default');
  });

  it('环境变量全量来源', () => {
    const options = buildTelemetryOptions({
      APP_ENV: 'dev',
      OTEL_ENABLED: true,
      OTEL_SERVICE_NAME: 'order-svc',
      OTEL_EXPORTER_URL: 'http://collector:4318/v1/traces',
      OTEL_SAMPLE_RATIO: 0.5,
      OTEL_SAMPLE_ERRORS: false,
    });
    expect(options).toEqual({
      enabled: true,
      serviceName: 'order-svc',
      exporterUrl: 'http://collector:4318/v1/traces',
      sampleRatio: 0.5,
      sampleErrors: false,
    });
  });

  it('空串服务名/端点按未配置处理', () => {
    const options = buildTelemetryOptions({ APP_ENV: 'test', OTEL_SERVICE_NAME: '', OTEL_EXPORTER_URL: '' });
    expect(options.serviceName).toBe('fw-test');
    expect(options.exporterUrl).toBeUndefined();
  });

  it('overrides 优先级最高', () => {
    const options = buildTelemetryOptions(
      { APP_ENV: 'dev', OTEL_ENABLED: false, OTEL_SAMPLE_RATIO: 0.9 },
      { enabled: true, sampleRatio: 0.25, exporterUrl: 'http://localhost:4318/v1/traces' },
    );
    expect(options.enabled).toBe(true);
    expect(options.sampleRatio).toBe(0.25);
    expect(options.exporterUrl).toBe('http://localhost:4318/v1/traces');
  });

  it('TELEMETRY_DEFAULTS 与 env-schema 默认值一致', () => {
    expect(TELEMETRY_DEFAULTS.enabled).toBe(false);
    expect(TELEMETRY_DEFAULTS.sampleRatio).toBe(0.1);
    expect(TELEMETRY_DEFAULTS.sampleErrors).toBe(true);
  });
});
