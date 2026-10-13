/*
 * @file 应用启动入口
 * @description 动态 import 根模块：让 FwCoreModule.forRoot() 的配置校验错误能被本文件的 catch 捕获并打印人话提示，而不是堆栈崩溃。
 * @author donttemo
 * @created 2026-10-09
 * @module example-api
 * @since v0.1.0
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { bootstrap } from '@fw/core';

/** 启动失败时的退出码 */
const EXIT_FAILURE = 1;

/** PID 文件路径（用于 M1 验收中的优雅停机信号发送） */
const PID_FILE = process.env.FW_PID_FILE ?? '';

async function main(): Promise<void> {
  const { AppModule } = await import('./app.module.js');
  const { server } = await bootstrap(AppModule);
  // 暴露 PID 供外部信号脚本（默认关闭，避免污染生产部署）
  if (PID_FILE) {
    writeFileSync(PID_FILE, String(process.pid));
    server.on('close', () => {
      try { unlinkSync(PID_FILE); } catch { /* 静默 */ }
    });
  }
}

main().catch((error: unknown) => {
  // 配置错误：打印逐项说明，不带堆栈（TC-CORE-001/002）
  if (error instanceof Error && error.name === 'ConfigValidationError') {
    console.error(error.message);
  } else {
    console.error(error);
  }
  process.exit(EXIT_FAILURE);
});
