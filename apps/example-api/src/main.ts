/*
 * @file 应用启动入口
 * @description 动态 import 根模块：让 FwCoreModule.forRoot() 的配置校验错误能被本文件的 catch 捕获并打印人话提示，而不是堆栈崩溃。
 *   M8：多租户与链路追踪中间件经 bootstrap beforeListen 钩子以 app.use 注册（顺序 trace → otel → tenant → 路由）。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo M8 接入 TenantModule（beforeListen 注册租户中间件）
 * @modified 2026-10-14 donttemo M8 T-M8-06 接入 TelemetryModule（beforeListen 注册 OTel 中间件；未启用时为直通桩）
 * @module example-api
 * @since v0.1.0
 */
import { writeFileSync, unlinkSync } from 'node:fs';
import { bootstrap } from '@fw/core';
import { OTEL_MIDDLEWARE } from '@fw/telemetry';
import { TENANT_MIDDLEWARE } from '@fw/tenant';

/** 启动失败时的退出码 */
const EXIT_FAILURE = 1;

/** PID 文件路径（用于 M1 验收中的优雅停机信号发送） */
const PID_FILE = process.env.FW_PID_FILE ?? '';

async function main(): Promise<void> {
  const { AppModule } = await import('./app.module.js');
  const { server } = await bootstrap(AppModule, {
    // 中间件顺序（M8）：trace（bootstrap 内置）→ otel → tenant → 路由。
    // otelMiddleware 在 trace 中间件之后取 X-Trace-Id 上游值作父上下文，tenant 在其后解析租户
    beforeListen: (app) => {
      // 链路追踪（T-M8-06）：OTEL_ENABLED=false 时工厂返回直通桩，HTTP 层零开销
      app.use(app.get(OTEL_MIDDLEWARE));
      // 多租户（T-M8-01）：TENANT_ENABLED=false 时中间件零开销短路；启用时未携带有效租户标识的请求直接 403
      app.use(app.get(TENANT_MIDDLEWARE));
    },
  });
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
