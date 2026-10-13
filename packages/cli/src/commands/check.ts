/*
 * @file fw check 命令
 * @description 配置自检：用 @fw/config 的 zod schema 校验当前目录 .env；通过则打印配置摘要，失败逐项打印问题（与启动时同一套校验逻辑）。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo 校验失败分支补 return：process.exit 被拦截或行为差异时不再继续执行到 throw，避免重复抛错
 * @module cli
 * @since v0.1.0
 */
import { loadEnv } from '@fw/config';

/**
 * 执行配置自检
 */
export async function runCheck(): Promise<void> {
  try {
    const env = loadEnv();
    console.log('配置校验通过。当前配置：');
    console.log(`  APP_ENV=${env.APP_ENV}  APP_PORT=${env.APP_PORT}  LOG_LEVEL=${env.LOG_LEVEL}`);
    console.log(`  DB_DRIVER=${env.DB_DRIVER}  CACHE_DRIVER=${env.CACHE_DRIVER}  AUTH_STRATEGY=${env.AUTH_STRATEGY}  MQ_DRIVER=${env.MQ_DRIVER}`);
    console.log(`  SHUTDOWN_TIMEOUT=${env.SHUTDOWN_TIMEOUT}s`);
  } catch (error) {
    if (error instanceof Error && error.name === 'ConfigValidationError') {
      console.error(error.message);
      process.exit(1);
      return;
    }
    throw error;
  }
}
