/*
 * @file 链路追踪错误族
 * @description SDK / 导出器未安装（optional peer 缺失）或配置不合法时抛出，均为可操作文案。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */

/** 链路追踪不可用：SDK 未安装或导出端点缺失（可操作错误，附修复命令） */
export class TelemetryUnavailableError extends Error {
  /**
   * @param message 人话文案（含修复命令）
   * @param cause 原始错误（可选）
   */
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = 'TelemetryUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 链路追踪配置错误：启用后缺导出端点等（启动即失败） */
export class TelemetryConfigError extends Error {
  /**
   * @param message 人话文案
   */
  constructor(message: string) {
    super(message);
    this.name = 'TelemetryConfigError';
  }
}
