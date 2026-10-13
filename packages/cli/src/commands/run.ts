/*
 * @file fw dev / fw build 命令
 * @description 在当前项目目录透传执行对应的 pnpm 脚本；退出码透传，便于 CI 使用。
 * @author donttemo
 * @created 2026-10-09
 * @module cli
 * @since v0.1.0
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/**
 * 在当前目录执行 pnpm run <script>
 * @param script 脚本名（dev / build）
 */
export async function runPnpmScript(script: string): Promise<void> {
  if (!fs.existsSync(path.join(process.cwd(), 'package.json'))) {
    throw new Error('当前目录没有 package.json：请在项目目录内运行 fw dev / fw build');
  }
  // Windows 下 pnpm 是 .cmd，必须走 shell
  const result = spawnSync('pnpm', ['run', script], {
    stdio: 'inherit',
    shell: process.platform === 'win32',
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}
