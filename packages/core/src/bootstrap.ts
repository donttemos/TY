/*
 * @file 启动引导
 * @description bootstrap() 是应用的唯一入口：注册 traceId 中间件、统一响应拦截器、全局异常过滤器、优雅停机；配置校验在模块加载期完成，本函数只负责组装与监听。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo NestFactory.create 传 abortOnError:false，避免装配失败被静默终止（无日志）
 * @module core
 * @since v0.1.0
 */
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { INestApplication, Type } from '@nestjs/common';
import type { Server } from 'node:http';
import { ConfigService, loadEnv } from '@fw/config';
import { Logger } from '@fw/logger';
import { GlobalExceptionFilter } from './exception/global-exception.filter.js';
import { ResponseInterceptor } from './response/response.interceptor.js';
import { traceMiddleware } from './trace/trace.middleware.js';
import { setupGracefulShutdown } from './lifecycle/graceful-shutdown.js';

/** bootstrap 选项 */
export interface BootstrapOptions {
  /** .env 查找目录（默认 process.cwd()） */
  cwd?: string;
  /** 就绪探针（透传给 FwCoreModule，应用侧也可在自己的模块里提供） */
  readinessProbes?: Array<{ name: string; check: () => Promise<boolean> }>;
  /** 覆盖监听端口（默认取 APP_PORT） */
  port?: number;
}

/** bootstrap 返回值 */
export interface BootstrapResult {
  /** Nest 应用实例 */
  app: INestApplication;
  /** HTTP server */
  server: Server;
  /** 配置服务 */
  config: ConfigService;
  /** 实际监听端口 */
  port: number;
}

/**
 * 启动应用骨架：一行调用完成全部横切关注点装配
 *
 * 用法：
 * ```ts
 * const { AppModule } = await import('./app.module.js');
 * await bootstrap(AppModule);
 * ```
 * @param rootModule 应用根模块（需 import FwCoreModule.forRoot()）
 * @param options 启动选项
 * @returns 应用实例、server 与配置服务
 */
export async function bootstrap(rootModule: Type, options: BootstrapOptions = {}): Promise<BootstrapResult> {
  // 模块加载期已校验过一次；这里再取一次以获得本函数作用域内的配置（loadEnv 幂等且开销极小）
  const env = loadEnv({ cwd: options.cwd });
  const config = new ConfigService(env);
  const logger = Logger.for('bootstrap');

  // abortOnError: false —— 默认 true 时 Nest 会在模块/依赖装配失败后自行终止进程，
  // 而本项目以 `logger: false` 关闭了 Nest 内置日志，导致「启动即静默退出、无任何错误输出」。
  // 关掉它让异常正常抛出，由 main.ts 的 catch 打印（配置错误为可读文案，其余为堆栈）。
  const app = await NestFactory.create(rootModule, { logger: false, abortOnError: false });
  // traceId 中间件必须在最外层（先于拦截器与过滤器）
  app.use(traceMiddleware);
  app.useGlobalInterceptors(new ResponseInterceptor());
  app.useGlobalFilters(new GlobalExceptionFilter());
  // 注意：不调用 app.enableShutdownHooks()，避免与 setupGracefulShutdown 的 SIGTERM 处理器竞速——
  // 我们的处理器会通过 app.close() 触发 onModuleDestroy / beforeApplicationShutdown 钩子

  const port = options.port ?? env.APP_PORT;
  const server = (await app.listen(port)) as Server;
  setupGracefulShutdown({ app, server, timeoutSeconds: env.SHUTDOWN_TIMEOUT, logger });

  logger.info('服务启动完成', { port, env: env.APP_ENV });
  return { app, server, config, port };
}
