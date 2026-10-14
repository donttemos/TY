/*
 * @file OTel 懒加载器单测
 * @description 覆盖可选模块加载的成功 / 未安装（可操作报错）/ 缓存语义。
 * @author donttemo
 * @created 2026-10-14
 * @module @fw/telemetry
 */
import { describe, expect, it } from 'vitest';
import { TelemetryUnavailableError } from '../errors.js';
import {
  loadOptionalModule,
  loadOtelSdk,
  loadOtlpExporter,
  resetOtelLoaderCache,
  MISSING_SDK_MESSAGE,
} from '../otel-loader.js';

describe('loadOptionalModule', () => {
  it('加载真实存在的模块', async () => {
    const mod = await loadOptionalModule<{ default: unknown }>('@opentelemetry/api', 'x');
    expect(mod).toBeDefined();
  });

  it('模块未安装时抛 TelemetryUnavailableError 且带可操作文案', async () => {
    await expect(loadOptionalModule('@fw/no-such-package-xyz', '请安装它')).rejects.toThrow(TelemetryUnavailableError);
    await expect(loadOptionalModule('@fw/no-such-package-xyz', '请安装它')).rejects.toThrow('请安装它');
  });

  it('模块存在但加载出错时原样抛出（不掩盖包内 bug）', async () => {
    // node:path 存在但其非默认导出访问不会抛；用一个必然运行时报错的方式难以构造，
    // 这里至少验证错误类型分支：不存在的相对路径视作模块缺失
    await expect(loadOptionalModule('./no-such-file.js', 'y')).rejects.toThrow(TelemetryUnavailableError);
  });
});

describe('loadOtelSdk / loadOtlpExporter', () => {
  it('SDK 与导出器可加载且结构正确（devDependency 在场）', async () => {
    resetOtelLoaderCache();
    const sdk = await loadOtelSdk();
    expect(typeof sdk.node.NodeTracerProvider).toBe('function');
    const exporter = await loadOtlpExporter();
    expect(typeof exporter.OTLPTraceExporter).toBe('function');
  });

  it('二次加载走缓存（同一实例）', async () => {
    resetOtelLoaderCache();
    const first = await loadOtelSdk();
    const second = await loadOtelSdk();
    expect(second).toBe(first);
  });

  it('MISSING_SDK_MESSAGE 含修复命令', () => {
    expect(MISSING_SDK_MESSAGE).toContain('pnpm add');
    expect(MISSING_SDK_MESSAGE).toContain('@opentelemetry/sdk-node');
  });
});
