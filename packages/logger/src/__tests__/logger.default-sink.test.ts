/*
 * @file @fw/logger 默认输出目标测试
 * @description 单独成文件的原因：configureLogger 会改写模块级 default sink，而 logger.test.ts 全程注入
 *   捕获用 sink（并在收尾时把 sink 置为 undefined），因此默认 sink 只能在「未被任何用例改写过的模块实例」
 *   中验证 —— vitest 默认按文件隔离模块注册表，独立文件可保证这一点。
 *   验证 bootstrap 未注入 sink 时日志落到 stdout（容器采集路径）。
 * @author donttemo
 * @created 2026-10-13
 * @module @fw/logger
 */
import { describe, expect, it, vi } from 'vitest';
import { Logger } from '../index.js';

describe('@fw/logger · 默认输出目标', () => {
  it('未配置 sink 时写入 process.stdout', () => {
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      Logger.for('default-sink').info('hello stdout');
      expect(write).toHaveBeenCalledTimes(1);
      const line = String(write.mock.calls[0][0]);
      expect(line.endsWith('\n')).toBe(true);
      expect(JSON.parse(line)).toMatchObject({ module: 'default-sink', msg: 'hello stdout', level: 'info' });
    } finally {
      write.mockRestore();
    }
  });
});
