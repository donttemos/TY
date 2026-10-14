/*
 * @file TelemetryModule 单测
 * @description 装配层：forRoot 的提供者注册、选项注入、disabled 短路与配置守卫。
 *   生命周期（SDK 装配/导出/停机）由 telemetry.service.test.ts 覆盖，此处不重复注册全局 provider。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import 'reflect-metadata';
import { describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { buildTelemetryOptions } from '../options.js';
import { TelemetryModule } from '../telemetry.module.js';
import { TelemetryService } from '../telemetry.service.js';
import { TelemetryConfigError } from '../errors.js';
import { OTEL_MIDDLEWARE, TELEMETRY_OPTIONS, TELEMETRY_SERVICE } from '../tokens.js';

describe('TelemetryModule.forRoot', () => {
  it('disabled（默认）：注册提供者但运行时零动作', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelemetryModule.forRoot({ env: { APP_ENV: 'test' } })],
    }).compile();

    const options = moduleRef.get(TELEMETRY_OPTIONS);
    expect(options.enabled).toBe(false);
    expect(options.serviceName).toBe('fw-test');

    const service = moduleRef.get(TelemetryService);
    expect(service).toBeInstanceOf(TelemetryService);
    // TELEMETRY_SERVICE 令牌与直接注入同一实例
    expect(moduleRef.get(TELEMETRY_SERVICE)).toBe(service);

    await moduleRef.init();
    expect(service.enabled).toBe(false);

    // disabled 时中间件工厂返回直通桩（函数存在但不建 span）
    const middleware = moduleRef.get(OTEL_MIDDLEWARE);
    expect(typeof middleware).toBe('function');
    await moduleRef.close();
  });

  it('overrides 覆盖环境来源，优先级最高', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        TelemetryModule.forRoot({
          env: { APP_ENV: 'dev', OTEL_ENABLED: false, OTEL_SAMPLE_RATIO: 0.9 },
          overrides: { enabled: true, sampleRatio: 0.25, exporterUrl: 'http://localhost:4318/v1/traces' },
        }),
      ],
    }).compile();

    const options = moduleRef.get(TELEMETRY_OPTIONS);
    expect(options).toEqual(buildTelemetryOptions({ APP_ENV: 'dev' }, {
      enabled: true,
      sampleRatio: 0.25,
      exporterUrl: 'http://localhost:4318/v1/traces',
    }));
    await moduleRef.close();
  });

  it('启用但缺导出端点：模块初始化即失败（不静默丢 span）', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [TelemetryModule.forRoot({ env: {}, overrides: { enabled: true } })],
    }).compile();

    const service = moduleRef.get(TelemetryService);
    // 注意：init 失败后 Nest 的 initializationPromise 处于拒绝态，close() 会复抛同一错误，
    // 故失败路径不调用 close（失败模块由进程回收，符合「启动即失败」语义）
    await expect(moduleRef.init()).rejects.toThrow(TelemetryConfigError);
    expect(service.enabled).toBe(false);
  });

  it('不传 env 时回退进程环境（loadEnv 链路）', () => {
    // loadEnv 要求 APP_ENV 必填且限定枚举：stub 进程环境变量模拟真实部署的最小环境
    vi.stubEnv('APP_ENV', 'test');
    try {
      const dynamicModule = TelemetryModule.forRoot();
      expect(dynamicModule.module).toBe(TelemetryModule);
      expect(dynamicModule.providers).toHaveLength(4);
      expect(dynamicModule.exports).toContain(TELEMETRY_SERVICE);
      expect(dynamicModule.exports).toContain(OTEL_MIDDLEWARE);
      const options = (dynamicModule.providers?.[0] as { useValue: { serviceName: string } }).useValue;
      expect(options.serviceName).toBe('fw-test');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
