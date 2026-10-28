/*
 * @file fw verify 命令入口
 * @description 把 CLI 参数归一为 VerifyOptions 并调用黄金链路；失败时只打印「原因 + 下一步」，
 *   完整阶段明细在 verify-report.json。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/verify
 * @since v0.8.0
 */

import { runVerify, type VerifyOptions } from '../verify/verify.js';

/** 命令选项（args.ts 解析后透传） */
export interface VerifyCommandOptions {
  /** --target=ci|real */
  target?: string;
  /** --name=<项目名> */
  name?: string;
  /** --model=<模型名> */
  model?: string;
  /** --skip-browser */
  skipBrowser?: boolean;
  /** --keep：保留生成的验收项目 */
  keep?: boolean;
  /** --url=<应用地址>（real 目标） */
  baseUrl?: string;
  /** --user=<账号> */
  username?: string;
  /** --pass=<口令> */
  password?: string;
}

/**
 * 执行 fw verify
 * @param options 命令选项
 */
export async function runVerifyCommand(options: VerifyCommandOptions): Promise<void> {
  const verifyOptions: VerifyOptions = {
    projectRoot: process.cwd(),
    target: options.target === 'real' ? 'real' : 'ci',
    name: options.name,
    model: options.model,
    skipBrowser: options.skipBrowser,
    keep: options.keep,
    baseUrl: options.baseUrl,
    username: options.username,
    password: options.password,
  };

  try {
    await runVerify(verifyOptions);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[verify] 失败：${message}`);
    process.exit(1);
  }
}
