/*
 * @file 框架核心模块（Nest 动态模块）
 * @description forRoot() 在模块加载期完成配置校验与日志初始化（配置缺失时启动即失败），并向全局容器注入 ConfigService 与就绪探针集合。
 * @author donttemo
 * @created 2026-10-09
 * @module core
 * @since v0.1.0
 */
import { DynamicModule, Global, Module } from '@nestjs/common';
import { ConfigService, loadEnv, type LoadOptions } from '@fw/config';
import { configureLogger } from '@fw/logger';
import { HealthController, READINESS_PROBES, type ReadinessProbe } from './health/health.controller.js';

/** forRoot 选项 */
export interface FwCoreModuleOptions extends LoadOptions {
  /** 就绪探针列表（M2 起 DB 探针由 @fw/orm 注册，M4 起 Redis 探针由 @fw/cache 注册） */
  readinessProbes?: ReadinessProbe[];
}

/**
 * 框架核心全局模块：应用 AppModule 直接 import FwCoreModule.forRoot()
 */
@Global()
@Module({})
export class FwCoreModule {
  /**
   * 初始化框架核心：加载校验配置 → 配置日志 → 注入全局 provider
   * @param options 初始化选项（cwd / env 覆盖 / 就绪探针）
   * @returns 动态模块定义
   * @throws ConfigValidationError 配置缺失或非法（进程应在启动入口捕获并友好打印）
   */
  static forRoot(options: FwCoreModuleOptions = {}): DynamicModule {
    const env = loadEnv(options);
    const config = new ConfigService(env);
    configureLogger({ level: env.LOG_LEVEL, maxBytes: env.LOG_MAX_BYTES });

    return {
      module: FwCoreModule,
      providers: [
        { provide: ConfigService, useValue: config },
        { provide: READINESS_PROBES, useValue: options.readinessProbes ?? [] },
      ],
      controllers: [HealthController],
      exports: [ConfigService],
    };
  }
}
