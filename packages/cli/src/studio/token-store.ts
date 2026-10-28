/*
 * @file Studio 本地令牌持久化（PRD-017 FR-17-26）
 * @description 令牌原本每次启动重新生成，导致「页面还开着、服务重启一次，保存就 401」。
 *   改为按项目持久化到用户目录 `~/.fw/studio-token.json`（0600，按项目路径哈希分桶）：
 *   - 仍是随机强令牌（24 字节 base64url），只是不再随重启变化；
 *   - `--new-token` 或 `FW_STUDIO_TOKEN` 可显式覆盖/轮换；
 *   - 文件损坏不阻断启动：重建即可，绝不因为令牌文件坏了起不来。
 *   安全边界不变：只监听 127.0.0.1、token 只经 URL 交给本机页面、API 一律校验。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/studio
 * @since v0.8.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** 默认令牌文件（可用 FW_STUDIO_TOKEN_FILE 覆盖，测试用） */
export function tokenFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.FW_STUDIO_TOKEN_FILE ?? '').trim();
  if (override !== '') return path.resolve(override);
  return path.join(os.homedir(), '.fw', 'studio-token.json');
}

/** 项目分桶键：不把绝对路径写进文件 */
function projectKey(projectRoot: string): string {
  const normalized = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
  return crypto.createHash('sha256').update(normalized, 'utf8').digest('hex').slice(0, 16);
}

/** 文件结构 */
interface TokenFile {
  version: 1;
  /** 项目键 → 令牌 */
  tokens: Record<string, string>;
}

/** 读取令牌文件（损坏时返回空表，不抛错） */
function readTokenFile(file: string): TokenFile {
  if (!fs.existsSync(file)) return { version: 1, tokens: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<TokenFile>;
    if (parsed.version !== 1 || typeof parsed.tokens !== 'object' || parsed.tokens === null) {
      return { version: 1, tokens: {} };
    }
    return { version: 1, tokens: parsed.tokens as Record<string, string> };
  } catch {
    return { version: 1, tokens: {} };
  }
}

/** 写入令牌文件（0700 目录 / 0600 文件） */
function writeTokenFile(file: string, data: TokenFile): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // Windows 上只影响只读位，尽力而为
  }
}

/** 解析入参 */
export interface ResolveTokenOptions {
  /** 项目根（按项目分桶） */
  projectRoot: string;
  /** 显式令牌（测试或调用方指定），优先级最高 */
  explicit?: string;
  /** 是否强制轮换（--new-token） */
  rotate?: boolean;
  /** 环境变量（FW_STUDIO_TOKEN / FW_STUDIO_TOKEN_FILE） */
  env?: NodeJS.ProcessEnv;
}

/** 解析结果 */
export interface ResolvedToken {
  token: string;
  /** 令牌文件路径 */
  file: string;
  /** 本次是否新生成（用于启动提示） */
  created: boolean;
}

/**
 * 解析本次启动使用的令牌
 * @description 优先级：显式 > 环境变量 > 已持久化 > 新生成并写入。
 * @param options 入参
 */
export function resolveStudioToken(options: ResolveTokenOptions): ResolvedToken {
  const env = options.env ?? process.env;
  const file = tokenFilePath(env);
  const explicit = options.explicit?.trim() ?? '';
  if (explicit !== '') return { token: explicit, file, created: false };

  const fromEnv = (env.FW_STUDIO_TOKEN ?? '').trim();
  if (fromEnv !== '') return { token: fromEnv, file, created: false };

  const data = readTokenFile(file);
  const key = projectKey(options.projectRoot);
  const existing = data.tokens[key];
  if (!options.rotate && typeof existing === 'string' && existing.trim() !== '') {
    return { token: existing, file, created: false };
  }

  const token = crypto.randomBytes(24).toString('base64url');
  data.tokens[key] = token;
  writeTokenFile(file, data);
  return { token, file, created: true };
}
