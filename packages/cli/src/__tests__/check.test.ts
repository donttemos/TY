/*
 * @file fw check 命令单测
 * @description 覆盖配置自检的三条路径：校验通过打印摘要、ConfigValidationError 打印问题并以 1 退出、其它异常原样上抛。
 *   通过 mock @fw/config 的 loadEnv，避免单测依赖真实的 .env 文件与运行环境。
 * @author donttemo
 * @created 2026-10-13
 * @module cli
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCheck } from '../commands/check.js';

/** loadEnv 替身（提升到 import 之前，保证 mock 先生效） */
const mocks = vi.hoisted(() => ({ loadEnv: vi.fn() }));

vi.mock('@fw/config', () => ({ loadEnv: mocks.loadEnv }));

/** 一份可通过校验的配置视图 */
const validEnv = {
  APP_ENV: 'dev',
  APP_PORT: 3000,
  LOG_LEVEL: 'info',
  DB_DRIVER: 'sqlite',
  CACHE_DRIVER: 'memory',
  AUTH_STRATEGY: 'jwt',
  MQ_DRIVER: 'memory',
  SHUTDOWN_TIMEOUT: 10,
};

/** 构造配置校验失败异常（与 @fw/config 抛出的类型一致） */
function makeConfigError(message: string): Error {
  const error = new Error(message);
  error.name = 'ConfigValidationError';
  return error;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runCheck', () => {
  it('配置通过时打印配置摘要', async () => {
    mocks.loadEnv.mockReturnValue(validEnv);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);

    await runCheck();

    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('配置校验通过');
    expect(output).toContain('APP_ENV=dev');
    expect(output).toContain('CACHE_DRIVER=memory');
  });

  it('校验失败时打印问题项并以退出码 1 结束', async () => {
    mocks.loadEnv.mockImplementation(() => {
      throw makeConfigError('配置校验失败：\n  - JWT_SECRET 缺失');
    });
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => undefined) as never);

    await runCheck();

    expect(error).toHaveBeenCalledTimes(1);
    expect(String(error.mock.calls[0][0])).toContain('JWT_SECRET');
    expect(exit).toHaveBeenCalledWith(1);
  });

  it('非配置校验类异常原样上抛', async () => {
    mocks.loadEnv.mockImplementation(() => {
      throw new Error('读取 .env 时磁盘 IO 异常');
    });

    await expect(runCheck()).rejects.toThrow('磁盘 IO 异常');
  });
});
