/*
 * @file TelemetryModule：链路追踪能力装配
 * @description `TelemetryModule.forRoot()` 按 `OTEL_ENABLED` 决定是否装配：
 *   - false（默认）：模块注册但全部动作短路，不装 SDK、不桥接日志，插桩点退化为非记录 span，
 *     单体 / 不接追踪的项目零外部依赖（SDK 为 optional peer，未启用时不必安装）；
 *   - true：注册日志 span 桥接 → 校验 OTEL_EXPORTER_URL（缺省启动即失败）→
 *     懒加载 SDK 与 OTLP 导出器 → 装配尾采样处理器（错误全采 + 比例采样）。
 *   插桩点（db / cache / queue / transport）只依赖 @opentelemetry/api 的全局 no-op 语义，
 *   不依赖本包——两者经全局 tracer provider 解耦。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { Module, type DynamicModule, type Provider } from '@nestjs/common';
import { loadEnv } from '@fw/config';
import { createOtelExpressMiddleware } from './otel.middleware.js';
import { buildTelemetryOptions, type TelemetryEnvLike } from './options.js';
import { TelemetryService } from './telemetry.service.js';
import { OTEL_MIDDLEWARE, TELEMETRY_OPTIONS, TELEMETRY_SERVICE } from './tokens.js';
import type { TelemetryRuntimeOptions } from './types.js';

/** forRoot 入参 */
export interface TelemetryModuleOptions {
  /** 环境变量来源，缺省读进程环境（.env 文件由 loadEnv 加载） */
  env?: TelemetryEnvLike;
  /** 直接覆盖运行时配置（测试 / 编程式装配用） */
  overrides?: Partial<TelemetryRuntimeOptions>;
}

/**
 * 链路追踪模块：应用 AppModule 直接 import TelemetryModule.forRoot()
 */
@Module({})
export class TelemetryModule {
  /**
   * 装配链路追踪能力
   * @param options 环境来源与覆盖项
   * @returns 动态模块定义
   */
  static forRoot(options: TelemetryModuleOptions = {}): DynamicModule {
    const env = options.env ?? loadEnv();
    const runtime = buildTelemetryOptions(env, options.overrides);
    const providers: Provider[] = [
      { provide: TELEMETRY_OPTIONS, useValue: runtime },
      // useExisting 而非 useClass：令牌与类提供者共享同一实例（否则 DI 会造出两个对象）
      { provide: TELEMETRY_SERVICE, useExisting: TelemetryService },
      TelemetryService,
      // express 中间件（beforeListen 钩子注册）：disabled 时工厂返回直通 next 的桩，零开销
      {
        provide: OTEL_MIDDLEWARE,
        useFactory: (telemetryOptions: TelemetryRuntimeOptions) => createOtelExpressMiddleware(telemetryOptions),
        inject: [TELEMETRY_OPTIONS],
      },
    ];
    return {
      module: TelemetryModule,
      providers,
      exports: [TELEMETRY_OPTIONS, TELEMETRY_SERVICE, TelemetryService, OTEL_MIDDLEWARE],
    };
  }
}
