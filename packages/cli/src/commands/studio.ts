/*
 * @file fw studio 命令入口
 * @description 启动本地服务并（默认）打开浏览器；Ctrl+C 或关终端即停止。
 *   不做常驻/开机自启——它就是一条前台命令，和 fw dev 同级。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { DEFAULT_STUDIO_PORT, startStudioServer } from '../studio/server.js';

const execFileAsync = promisify(execFile);

/** 命令选项 */
export interface StudioCommandOptions {
  /** --port=<n>（0 表示随机端口） */
  port?: number;
  /** --no-open：只起服务不打开浏览器 */
  noOpen?: boolean;
  /** --new-token：轮换本地令牌（其他已打开的页面会失效） */
  rotateToken?: boolean;
}

/**
 * 用系统默认浏览器打开地址（失败只告警，不影响服务）
 * @param url 访问地址
 */
async function openBrowser(url: string): Promise<void> {
  try {
    if (process.platform === 'win32') {
      // start 是 cmd 内建命令，必须经 cmd.exe 执行；第一个空参数占位是标题位
      await execFileAsync('cmd', ['/c', 'start', '', url]);
      return;
    }
    await execFileAsync(process.platform === 'darwin' ? 'open' : 'xdg-open', [url]);
  } catch {
    console.warn(`[studio] 无法自动打开浏览器，请手动访问：${url}`);
  }
}

/**
 * 执行 fw studio
 * @param options 选项
 */
export async function runStudioCommand(options: StudioCommandOptions = {}): Promise<void> {
  const projectRoot = process.cwd();
  const handle = await startStudioServer({
    projectRoot,
    port: options.port ?? DEFAULT_STUDIO_PORT,
    rotateToken: options.rotateToken === true,
    log: (message) => console.log(message),
  });

  console.log('[studio] 只读工作台：项目体检与模型浏览；关闭终端即停止');
  if (!options.noOpen) await openBrowser(handle.url);

  // 前台常驻：收到中断信号时优雅关闭
  await new Promise<void>((resolve) => {
    const stop = (): void => {
      void handle.close().then(() => resolve());
    };
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
  console.log('[studio] 已停止');
}
