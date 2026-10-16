/*
 * @file 应用启动入口（admin 模板）
 * @description 动态 import 根模块：让 FwCoreModule.forRoot() 的配置校验错误能被本文件的 catch
 *   捕获并打印人话提示，而不是堆栈崩溃。admin 模板不接多租户 / OTel，保持骨架最小可跑。
 * @author donttemo
 * @created 2026-10-15
 * @module __APP_NAME__
 * @since v0.1.0
 */
import { bootstrap } from '@fw/core';

/** 启动失败时的退出码 */
const EXIT_FAILURE = 1;

async function main(): Promise<void> {
  const { AppModule } = await import('./app.module.js');
  await bootstrap(AppModule);
}

main().catch((error: unknown) => {
  if (error instanceof Error && error.name === 'ConfigValidationError') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(EXIT_FAILURE);
});
