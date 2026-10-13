/*
 * @file 优雅停机
 * @description 收到 SIGTERM/SIGINT 后：停止接受新连接 → 关闭空闲连接并等待在途请求完成（超时强制退出）→ 执行应用关闭钩子释放连接池 → 记录 shutdown complete。
 * @author donttemo
 * @created 2026-10-09
 * @module core
 * @since v0.1.0
 */
import type { INestApplication } from '@nestjs/common';
import type { Server } from 'node:http';
import { Logger } from '@fw/logger';

/** 停机参数 */
export interface GracefulShutdownOptions {
  /** Nest 应用实例（用于触发关闭钩子） */
  app: INestApplication;
  /** HTTP server（用于停止接受新连接） */
  server: Server;
  /** 在途请求等待上限（秒），超时强制退出 */
  timeoutSeconds: number;
  /** 日志器（默认 core 模块日志器） */
  logger?: Logger;
  /** 进程退出函数（默认 process.exit；测试可注入 mock） */
  exit?: (code: number) => void;
}

/**
 * 执行一次优雅停机流程（不分发信号）
 * @param options 停机参数
 * @param signal 触发信号名（仅用于日志）
 */
export async function runGracefulShutdown(options: GracefulShutdownOptions, signal: string): Promise<void> {
  const { app, server, timeoutSeconds } = options;
  const logger = options.logger ?? Logger.for('shutdown');
  const exit = options.exit ?? ((code: number) => process.exit(code));
  logger.info(`收到 ${signal}，开始优雅停机`);

  // 超时兜底：在途请求超时未完成则强制退出，避免容器 SIGKILL 撕断
  const forceTimer = setTimeout(() => {
    logger.error('优雅停机超时，强制退出');
    exit(1);
  }, timeoutSeconds * 1000);
  forceTimer.unref();

  // 停止接受新连接；只关空闲连接，在途请求继续处理
  server.close();
  server.closeIdleConnections?.();
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });

  try {
    // 触发 onModuleDestroy / beforeApplicationShutdown，释放连接池
    await app.close();
  } catch (error) {
    logger.error('关闭钩子执行失败', { error: String(error) });
  }
  clearTimeout(forceTimer);
  logger.info('shutdown complete');
  // Node 上 stdout 写入与 process.exit 之间的竞态：等到 drain 后再退出
  await new Promise<void>((resolve) => {
    if (process.stdout.writableLength === 0) resolve();
    else process.stdout.once('drain', () => resolve());
  });
  exit(0);
}

/**
 * 注册优雅停机信号处理（bootstrap 内调用，进程只注册一次）
 * @param options 停机参数
 */
export function setupGracefulShutdown(options: GracefulShutdownOptions): void {
  const { app, server, timeoutSeconds, logger, exit } = options;
  let shuttingDown = false;

  const shutdown = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    void runGracefulShutdown({ app, server, timeoutSeconds, logger, exit }, signal);
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
}
