/*
 * @file 部署执行器（可注入）
 * @description `fw deploy` 的所有外部命令都经过这里，单测可整体替换为假执行器，不依赖真实 docker。
 *   两套签名并存是刻意的：数组形式用于普通命令（不经 shell，无注入面）；
 *   整行形式只用于必须重定向的场景（如 pg_dump 落盘），且调用方必须自行加引号。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/deploy
 * @since v0.8.0
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

/** 命令结果 */
export interface ExecResult {
  stdout: string;
  stderr: string;
}

/** 数组形式执行器（失败抛错） */
export type Exec = (command: string, args: string[], cwd: string) => Promise<ExecResult>;

/** 整行形式执行器（经 sh -c，失败抛错） */
export type Shell = (commandLine: string, cwd: string) => Promise<ExecResult>;

/** 输出上限：docker 构建日志可能很长，给到 32MB */
const MAX_BUFFER = 32 * 1024 * 1024;

/** 默认数组执行器 */
export const defaultExec: Exec = async (command, args, cwd) => {
  // Windows 下 .cmd/.bat 无法被 execFile 直接执行（EINVAL），必须经 shell；
  // 其余命令（node / docker / bash）保持无 shell，避免参数里的空格被重新切分。
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  try {
    const { stdout, stderr } = await execFileAsync(command, args, {
      cwd,
      shell: needsShell,
      encoding: 'utf8',
      maxBuffer: MAX_BUFFER,
    });
    return { stdout, stderr };
  } catch (error) {
    // 默认的 "Command failed: xxx" 完全无法定位问题；优先用 stderr 里**第一条真正的错误**。
    // Prisma 等工具会在真正报错前先打若干 warn（如配置弃用），照抄会把用户引到无关信息上。
    const detail = error as { stderr?: string; stdout?: string; message?: string };
    const text = (detail.stderr || detail.stdout || detail.message || '').trim();
    const lines = text
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line !== '');
    // 噪声行：工具的告警/进度/环境提示，全部跳过
    const isNoise = (line: string): boolean =>
      /^warn\b/i.test(line) ||
      /^for more information/i.test(line) ||
      /^environment variables loaded/i.test(line) ||
      /^prisma schema loaded/i.test(line) ||
      /^datasource\b/i.test(line) ||
      /^the schema at\b/i.test(line);
    const candidates = lines.filter((line) => !isNoise(line));
    // 真正的错误通常带 Error / P1xxx 码：优先取它，否则取第一条非噪声行
    const meaningful = candidates.find((line) => /\berror\b/i.test(line) || /\bP\d{4}\b/.test(line)) ?? candidates[0];
    throw new Error(meaningful ?? lines[0] ?? '命令执行失败');
  }
};

/** 默认整行执行器（sh -c；Windows 下同样走 Git Bash 的 sh） */
export const defaultShell: Shell = async (commandLine, cwd) => {
  const { stdout, stderr } = await execFileAsync('sh', ['-c', commandLine], {
    cwd,
    encoding: 'utf8',
    maxBuffer: MAX_BUFFER,
  });
  return { stdout, stderr };
};

/**
 * 取错误信息首行（对外输出保持简短，PRD-016 精简原则 4）
 * @param error 异常
 */
export function firstLineOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  const line = raw
    .split('\n')
    .map((item) => item.trim())
    .find((item) => item !== '');
  return line ?? '未知错误';
}

/** 单引号包裹（整行命令里拼接路径用） */
export function quote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * pnpm 可执行名：Windows 上是 pnpm.cmd，直接 execFile('pnpm') 会 ENOENT
 * （默认执行器不加 shell，避免路径含空格时的拼接问题）
 */
export function pnpmBin(): string {
  return process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
}
