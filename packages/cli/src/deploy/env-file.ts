/*
 * @file 部署环境文件与首次向导（PRD-016 FR-16-09）
 * @description `fw deploy` 的配置来源：
 *   - 首次部署只问三项（对外域名、PostgreSQL 密码、Redis 密码），后两项留空即自动生成；
 *     单机 Compose 下数据库/缓存连接串是编排内部派生的，问用户没有意义，故不提问；
 *   - 之后每次部署读 `.env.prod` 即可，零输入（AC-16-04）；
 *   - 密钥只写文件不回显，文件权限收敛到 600；已有密钥一律不重写（避免二次部署把库密码改掉）。
 *   解析器刻意保持极简：只支持 KEY=VALUE、# 注释与包裹引号，不引入第三方 dotenv。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/deploy
 * @since v0.8.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** 部署环境文件名（项目根） */
export const DEPLOY_ENV_FILE = '.env.prod';

/** 必需键（缺任一即视为未配置，触发向导） */
export const REQUIRED_KEYS = ['APP_DOMAIN', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET'] as const;

/** 键值表 */
export type EnvEntries = Record<string, string>;

/**
 * 解析 .env 文本
 * @param text 文件内容
 * @returns 键值表（同键后者覆盖前者，与 shell 语义一致）
 */
export function parseEnv(text: string): EnvEntries {
  const entries: EnvEntries = {};
  for (const rawLine of text.replace(/\r\n/g, '\n').split('\n')) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    let value = line.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"') && value.length >= 2) ||
      (value.startsWith("'") && value.endsWith("'") && value.length >= 2)
    ) {
      value = value.slice(1, -1);
    }
    if (key !== '') entries[key] = value;
  }
  return entries;
}

/**
 * 序列化为 .env 文本（键按传入顺序，末尾带换行）
 * @param entries 键值表
 * @param header 顶部注释行（不含 #，自动加）
 */
export function serializeEnv(entries: EnvEntries, header: string[] = []): string {
  const lines = [...header.map((line) => `# ${line}`), ''];
  for (const [key, value] of Object.entries(entries)) {
    lines.push(`${key}=${value}`);
  }
  return `${lines.join('\n').replace(/\n{3,}/g, '\n\n')}\n`;
}

/**
 * 读取部署环境文件（不存在返回空表）
 * @param projectRoot 项目根
 */
export function readDeployEnv(projectRoot: string): { file: string; entries: EnvEntries; exists: boolean } {
  const file = path.join(projectRoot, DEPLOY_ENV_FILE);
  if (!fs.existsSync(file)) return { file, entries: {}, exists: false };
  return { file, entries: parseEnv(fs.readFileSync(file, 'utf8')), exists: true };
}

/**
 * 判断是否已配置完整（缺键列表）
 * @param entries 键值表
 * @returns 缺失的键；空数组表示已就绪
 */
export function missingKeys(entries: EnvEntries): string[] {
  return REQUIRED_KEYS.filter((key) => (entries[key] ?? '').trim() === '');
}

/**
 * 写入部署环境文件并把权限收敛到 600
 * @param file 绝对路径
 * @param entries 键值表
 */
export function writeDeployEnv(file: string, entries: EnvEntries): void {
  const header = [
    '由 fw deploy 生成，请勿提交到版本库',
    `生成时间：${new Date().toISOString()}`,
    '修改后需重新执行 fw deploy 生效；密钥改动会影响已签发令牌',
  ];
  fs.writeFileSync(file, serializeEnv(entries, header), { encoding: 'utf8', mode: 0o600 });
  // Windows 上 mode 不生效，显式 chmod 在 POSIX 才有效果；失败不阻断（不影响部署）
  try {
    fs.chmodSync(file, 0o600);
  } catch {
    // 忽略：部分文件系统（FAT/网络盘）不支持权限位
  }
}

/** 生成 URL 安全随机密钥（32 字节 ≈ 43 字符） */
export function generateSecret(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** 交互提问函数（可注入，单测不读真实 stdin） */
export type Asker = (question: string, placeholder?: string) => Promise<string>;

/** 向导结果 */
export interface WizardResult {
  entries: EnvEntries;
  /** 本次自动生成的键（输出时只报键名，不回显值） */
  generated: string[];
}

/** 向导选项 */
export interface WizardOptions {
  /** 交互提问 */
  ask: Asker;
  /** 已有配置（用于保留旧值） */
  existing?: EnvEntries;
  /** 镜像标签默认值 */
  imageTag?: string;
}

/**
 * 首次部署向导：三项必答（后两项可留空自动生成）
 * @param options 选项
 */
export async function runWizard(options: WizardOptions): Promise<WizardResult> {
  const existing = options.existing ?? {};
  const generated: string[] = [];

  const domain = (await options.ask('对外域名', existing.APP_DOMAIN || 'example.com')).trim();
  const pgInput = (await options.ask('PostgreSQL 密码（留空自动生成）', '')).trim();
  const redisInput = (await options.ask('Redis 密码（留空自动生成）', '')).trim();

  const postgresPassword = pgInput || generateSecret();
  const redisPassword = redisInput || generateSecret();
  if (!pgInput) generated.push('POSTGRES_PASSWORD');
  if (!redisInput) generated.push('REDIS_PASSWORD');

  const jwtSecret = existing.JWT_SECRET?.trim() || generateSecret();
  if (!existing.JWT_SECRET?.trim()) generated.push('JWT_SECRET');

  const entries: EnvEntries = {
    APP_ENV: 'prod',
    APP_DOMAIN: domain || existing.APP_DOMAIN || 'example.com',
    POSTGRES_PASSWORD: postgresPassword,
    REDIS_PASSWORD: redisPassword,
    JWT_SECRET: jwtSecret,
    APP_IMAGE: existing.APP_IMAGE || options.imageTag || 'fw-app:local',
    APP_REPLICAS: existing.APP_REPLICAS || '1',
    WORKER_REPLICAS: existing.WORKER_REPLICAS || '1',
  };
  return { entries, generated };
}

/**
 * 非交互补齐（`--yes` 或 CI 场景）：缺什么补什么，已有一律保留
 * @param existing 已有配置
 * @param imageTag 镜像标签默认值
 */
export function fillNonInteractive(existing: EnvEntries, imageTag?: string): WizardResult {
  const generated: string[] = [];
  const entries: EnvEntries = { ...existing };
  if (!entries.APP_ENV) entries.APP_ENV = 'prod';
  if (!entries.APP_DOMAIN) entries.APP_DOMAIN = 'example.com';
  for (const key of ['POSTGRES_PASSWORD', 'REDIS_PASSWORD', 'JWT_SECRET'] as const) {
    if (!(entries[key] ?? '').trim()) {
      entries[key] = generateSecret();
      generated.push(key);
    }
  }
  if (!entries.APP_IMAGE) entries.APP_IMAGE = imageTag || 'fw-app:local';
  if (!entries.APP_REPLICAS) entries.APP_REPLICAS = '1';
  if (!entries.WORKER_REPLICAS) entries.WORKER_REPLICAS = '1';
  return { entries, generated };
}
