/*
 * @file Compose 编排执行与健康检查（PRD-016 FR-16-10 / FR-16-13）
 * @description 只做「把命令拼对 + 把结果判对」，不做业务编排（编排在 deploy.ts）：
 *   - 所有 docker 调用统一带 `--env-file <file> -f <composeFile>`，避免用户在错误目录执行时读错配置；
 *   - 预检同时验证 docker、compose 插件、编排文件语法三者可用（缺一即给出可操作提示）；
 *   - 健康检查按间隔轮询 /health，超时返回最后一次状态而不是抛裸错，便于上层写进报告。
 *   exec / fetch / sleep 均可注入，单测不依赖真实 docker 与网络。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/deploy
 * @since v0.8.0
 */

import { firstLineOf, type Exec } from './exec.js';

/** 编排上下文 */
export interface ComposeContext {
  /** 项目根（命令工作目录） */
  projectRoot: string;
  /** compose 文件（相对项目根） */
  composeFile: string;
  /** 环境文件（相对项目根） */
  envFile: string;
  /** 数组执行器 */
  exec: Exec;
}

/** 健康检查结果 */
export interface HealthResult {
  /** 是否在超时前通过 */
  ok: boolean;
  /** 尝试次数 */
  attempts: number;
  /** 最后一次的 HTTP 状态（无响应时为 null） */
  lastStatus: number | null;
  /** 最后一次失败原因（无响应/非 2xx） */
  lastError?: string;
}

/** 拼装 compose 命令参数（含全局选项） */
export function composeArgs(context: ComposeContext, args: string[]): string[] {
  return ['compose', '--env-file', context.envFile, '-f', context.composeFile, ...args];
}

/**
 * 预检：docker / compose 插件 / 编排文件语法
 * @param context 编排上下文
 * @param io 输出（可选，用于进度提示）
 */
export async function composePreflight(context: ComposeContext, io?: { log: (message: string) => void }): Promise<void> {
  try {
    await context.exec('docker', ['version', '--format', '{{.Server.Version}}'], context.projectRoot);
  } catch (error) {
    throw new Error(`未检测到可用的 Docker：${firstLineOf(error)}。请先安装 Docker 并确认当前用户可执行 docker`);
  }
  try {
    await context.exec('docker', ['compose', 'version'], context.projectRoot);
  } catch (error) {
    throw new Error(`未检测到 docker compose 插件：${firstLineOf(error)}。Docker 20.10+ 需安装 compose 插件`);
  }
  try {
    await context.exec('docker', composeArgs(context, ['config', '-q']), context.projectRoot);
  } catch (error) {
    throw new Error(
      `编排文件校验失败：${firstLineOf(error)}。请检查 ${context.composeFile} 与 ${context.envFile} 的必填项（缺变量时 compose 会直接报错）`,
    );
  }
  io?.log('[deploy] 预检通过：docker + compose + 编排文件');
}

/**
 * 构建镜像（app / migrate / worker 共用同一镜像，构建一次）
 * @param context 编排上下文
 * @param io 输出
 */
export async function composeBuild(context: ComposeContext, io: { log: (message: string) => void }): Promise<void> {
  io.log('[deploy] 构建镜像…（首次较慢，pnpm 依赖与框架包都要编译）');
  try {
    // migrate 服务带 tools profile（不进 up 的常驻集合），构建时要显式启用 profile 才能一并构建
    await context.exec('docker', composeArgs(context, ['--profile', 'tools', 'build', 'app', 'migrate']), context.projectRoot);
  } catch (error) {
    throw new Error(`镜像构建失败：${firstLineOf(error)}。可先在本机执行 docker compose build app 查看完整日志`);
  }
}

/**
 * 启动编排（迁移服务由上层先单独 run）
 * @param context 编排上下文
 * @param io 输出
 */
export async function composeUp(context: ComposeContext, io: { log: (message: string) => void }): Promise<void> {
  try {
    await context.exec('docker', composeArgs(context, ['up', '-d', '--remove-orphans']), context.projectRoot);
  } catch (error) {
    throw new Error(`启动失败：${firstLineOf(error)}。可执行 docker compose ps 与 docker compose logs --tail=50 排查`);
  }
  io.log('[deploy] 服务已启动');
}

/**
 * 执行迁移容器（一次性，不进入 up 的常驻集合）
 * @param context 编排上下文
 * @param io 输出
 */
export async function composeMigrate(context: ComposeContext, io: { log: (message: string) => void }): Promise<void> {
  try {
    await context.exec('docker', composeArgs(context, ['--profile', 'tools', 'run', '--rm', 'migrate']), context.projectRoot);
  } catch (error) {
    throw new Error(`迁移执行失败：${firstLineOf(error)}。数据库已备份，可修正迁移后重跑 fw deploy`);
  }
  io.log('[deploy] 迁移完成');
}

/**
 * 执行种子容器（一次性；seed 脚本自带清场语义，必须由用户显式要求）
 * @param context 编排上下文
 * @param io 输出
 */
export async function composeSeed(context: ComposeContext, io: { log: (message: string) => void }): Promise<void> {
  try {
    await context.exec(
      'docker',
      composeArgs(context, ['--profile', 'tools', 'run', '--rm', 'migrate', 'sh', '-c', 'pnpm exec tsx prisma/seed.ts']),
      context.projectRoot,
    );
  } catch (error) {
    throw new Error(`种子执行失败：${firstLineOf(error)}。可稍后单独重试（容器内 pnpm exec tsx prisma/seed.ts）`);
  }
  io.log('[deploy] 种子完成');
}

/**
 * 健康检查轮询
 * @param url 健康地址
 * @param options 超时与间隔（默认 60s / 2s，覆盖首次冷启动）
 */
export async function waitForHealth(
  url: string,
  options: {
    timeoutMs?: number;
    intervalMs?: number;
    fetchImpl?: typeof fetch;
    sleep?: (ms: number) => Promise<void>;
  } = {},
): Promise<HealthResult> {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const intervalMs = options.intervalMs ?? 2_000;
  const doFetch = options.fetchImpl ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const deadline = Date.now() + timeoutMs;

  let attempts = 0;
  let lastStatus: number | null = null;
  let lastError: string | undefined;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await doFetch(url);
      lastStatus = response.status;
      if (response.ok) return { ok: true, attempts, lastStatus };
      lastError = `HTTP ${response.status}`;
    } catch (error) {
      lastStatus = null;
      lastError = firstLineOf(error);
    }
    if (Date.now() + intervalMs >= deadline) break;
    await sleep(intervalMs);
  }

  return { ok: false, attempts, lastStatus, lastError };
}
