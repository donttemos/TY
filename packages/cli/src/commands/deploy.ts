/*
 * @file fw deploy 命令入口
 * @description 把 CLI 参数归一为 DeployOptions 并调用编排；失败时只打印编排给出的
 *   「原因 + 下一步」两段，不把堆栈抛给用户（PRD-016 精简原则 4）。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/deploy
 * @since v0.8.0
 */

import { runDeploy, type DeployOptions } from '../deploy/deploy.js';

/** 命令选项（args.ts 解析后透传） */
export interface DeployCommandOptions {
  /** --plan：只输出计划 */
  plan?: boolean;
  /** --rollback：回退到上一镜像 */
  rollback?: boolean;
  /** --target=compose|bare-metal */
  target?: string;
  /** --yes：非交互（缺配置自动生成密钥） */
  yes?: boolean;
  /** --skip-backup */
  skipBackup?: boolean;
  /** --seed */
  seed?: boolean;
  /** --allow-destructive */
  allowDestructive?: boolean;
  /** --keep-backups=N */
  keepBackups?: number;
  /** --compose=<路径> */
  composeFile?: string;
  /** --env-file=<路径> */
  envFile?: string;
}

/**
 * 执行 fw deploy
 * @param options 命令选项
 */
export async function runDeployCommand(options: DeployCommandOptions): Promise<void> {
  const target = options.target === 'bare-metal' ? 'bare-metal' : 'compose';
  const deployOptions: DeployOptions = {
    projectRoot: process.cwd(),
    target,
    plan: options.plan,
    rollback: options.rollback,
    yes: options.yes,
    skipBackup: options.skipBackup,
    seed: options.seed,
    allowDestructive: options.allowDestructive,
    keepBackups: options.keepBackups,
    composeFile: options.composeFile,
    envFile: options.envFile,
  };

  try {
    await runDeploy(deployOptions);
  } catch (error) {
    // 编排已经把「阶段 + 原因 + 下一步」拼进 message；这里只补一个前缀并退出
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[deploy] 失败：${message}`);
    process.exit(1);
  }
}
