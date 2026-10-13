/*
 * @file 配置加载器
 * @description 多环境加载顺序：.env → .env.{APP_ENV} → 进程环境变量（优先级最高，容器友好）；随后用 zod 校验合并结果，失败抛 ConfigValidationError。
 * @author donttemo
 * @created 2026-10-09
 * @module config
 * @since v0.1.0
 */
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseEnv } from 'dotenv';
import { envSchema, type Env } from './env-schema.js';
import { ConfigValidationError, translateIssues } from './config-error.js';

/** 加载选项 */
export interface LoadOptions {
  /** .env 文件所在目录，默认当前工作目录 */
  cwd?: string;
  /** 额外覆盖项（测试注入用），优先级最高 */
  overrides?: Record<string, string>;
}

/** 读取单个 env 文件内容（不存在返回空对象，不报错） */
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  return parseEnv(fs.readFileSync(file, 'utf8'));
}

/**
 * 推断运行环境：进程变量 → .env 文件 → .env.default → 抛错提示必填
 * @param cwd 工作目录
 * @returns APP_ENV 取值
 */
function resolveAppEnv(cwd: string): string | undefined {
  if (process.env.APP_ENV) return process.env.APP_ENV;
  const fromFile = readEnvFile(path.join(cwd, '.env'));
  return fromFile.APP_ENV;
}

/**
 * 加载并校验全部配置
 * @param options 加载选项
 * @returns 校验通过的 Env 对象
 * @throws ConfigValidationError 配置缺失或非法时抛出，message 已含逐项中文说明
 */
export function loadEnv(options: LoadOptions = {}): Env {
  const cwd = options.cwd ?? process.cwd();

  const appEnv = resolveAppEnv(cwd);
  if (!appEnv) {
    throw new ConfigValidationError([
      { key: 'APP_ENV', message: '缺少必填项（请检查 .env / .env.example）' },
    ]);
  }

  // 覆盖顺序：.env → .env.{env} → process.env → overrides
  const merged: Record<string, string> = {
    ...readEnvFile(path.join(cwd, '.env')),
    ...readEnvFile(path.join(cwd, `.env.${appEnv}`)),
    ...pickKnownKeys(process.env),
    ...(options.overrides ?? {}),
  };

  const result = envSchema.safeParse(merged);
  if (!result.success) {
    throw new ConfigValidationError(translateIssues(result.error.issues));
  }
  return result.data;
}

/** 从进程环境变量中挑出 schema 定义的键，避免注入无关变量 */
function pickKnownKeys(source: NodeJS.ProcessEnv): Record<string, string> {
  const keys = Object.keys(envSchema.shape);
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const value = source[key];
    if (value !== undefined && value !== '') picked[key] = value;
  }
  return picked;
}
