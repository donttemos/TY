/*
 * @file 链路追踪错误族
 * @description SDK / 导出器未安装（optional peer 缺失）或配置不合法时抛出，均为可操作文案。
 *   M12 W1（PRD-012 OBS-01，ADR-0025 ①/③类治理）：错误族收敛到 @fw/core BizError 唯一基类——
 *   TelemetryUnavailableError 继承 BizError（默认码 9002 依赖不可用）；TelemetryConfigError 继承
 *   BizError（默认码 5002 配置非法）。两者均为启动期 fail-fast（保留独立类名与可操作文案，
 *   instanceof 断言不破坏；额外获得统一错误码语义，若经 HTTP 面上浮即按码表输出信封）。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-17 donttemo M12 W1（PRD-012 OBS-01）：错误族继承 BizError（ADR-0025 三类治理）
 * @module @fw/telemetry
 */

import { BizError, ErrorCode } from '@fw/core';

/** 链路追踪不可用：SDK 未安装或导出端点缺失（可操作错误，附修复命令；默认码 9002 / HTTP 503） */
export class TelemetryUnavailableError extends BizError {
  /**
   * @param message 人话文案（含修复命令）
   * @param cause 原始错误（可选）
   */
  constructor(message: string, cause?: unknown) {
    super(ErrorCode.DEPENDENCY_UNAVAILABLE, message);
    this.name = 'TelemetryUnavailableError';
    if (cause !== undefined) (this as { cause?: unknown }).cause = cause;
  }
}

/** 链路追踪配置错误：启用后缺导出端点等（启动即失败；默认码 5002 / HTTP 400） */
export class TelemetryConfigError extends BizError {
  /**
   * @param message 人话文案
   */
  constructor(message: string) {
    super(ErrorCode.CONFIG_INVALID_VALUE, message);
    this.name = 'TelemetryConfigError';
  }
}
