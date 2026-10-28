/*
 * @file 部署前数据库备份（PRD-016 FR-16-12）
 * @description 迁移前必须留下一份可读备份，否则破坏性迁移一旦执行就没有退路：
 *   - 用 `pg_dump -Fc` 自定义格式（可用 pg_restore 选择性恢复），经 shell 重定向直接落盘，避免二进制过 JS；
 *   - 备份后校验「文件头 PGDMP + 体积下限」，不通过即中止部署（AC-16-09 要求备份成功才可继续）；
 *   - 按份数保留，旧的自动清理。
 *   所有命令经 Shell 注入，单测用假执行器在临时目录写出伪备份文件。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/deploy
 * @since v0.8.0
 */

import fs from 'node:fs';
import path from 'node:path';
import { firstLineOf, quote, type Shell } from './exec.js';

/** PostgreSQL 自定义格式备份的文件头魔数 */
const DUMP_MAGIC = 'PGDMP';
/** 备份体积下限（小于这个值几乎肯定是失败输出而非真实备份） */
const MIN_BYTES = 1024;
/** 备份文件名前缀 */
const BACKUP_PREFIX = 'fw-';

/** 备份选项 */
export interface BackupOptions {
  /** 项目根（命令工作目录） */
  projectRoot: string;
  /** 备份目录（绝对路径） */
  backupDir: string;
  /** compose 文件相对路径（如 deploy/docker-compose.prod.yml） */
  composeFile: string;
  /** 环境文件相对路径（如 .env.prod） */
  envFile: string;
  /** postgres 服务名 */
  service: string;
  /** 数据库用户名 */
  dbUser: string;
  /** 数据库名 */
  dbName: string;
  /** 保留份数（含本次） */
  keep: number;
  /** 整行执行器 */
  shell: Shell;
  /** 时间戳（测试固定） */
  now?: Date;
}

/** 备份结果 */
export interface BackupResult {
  /** 备份文件绝对路径 */
  file: string;
  /** 字节数 */
  bytes: number;
  /** 因超出保留份数被删除的文件 */
  pruned: string[];
}

/** 生成备份文件名（本地时间到秒，可直接排序） */
export function backupFileName(now: Date = new Date()): string {
  const pad = (value: number): string => String(value).padStart(2, '0');
  const stamp = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
  return `${BACKUP_PREFIX}${stamp}.dump`;
}

/**
 * 校验备份文件是否可信（魔数 + 体积）
 * @param file 绝对路径
 * @returns 通过返回 null，否则返回原因
 */
export function verifyDump(file: string): string | null {
  if (!fs.existsSync(file)) return '备份文件未生成';
  const { size } = fs.statSync(file);
  if (size < MIN_BYTES) return `备份文件过小（${size} 字节，疑似失败输出）`;
  const head = Buffer.alloc(DUMP_MAGIC.length);
  const fd = fs.openSync(file, 'r');
  try {
    fs.readSync(fd, head, 0, head.length, 0);
  } finally {
    fs.closeSync(fd);
  }
  if (head.toString('latin1') !== DUMP_MAGIC) return '备份文件头不是 PostgreSQL 自定义格式（PGDMP）';
  return null;
}

/**
 * 清理超出保留份数的旧备份
 * @param backupDir 备份目录
 * @param keep 保留份数
 * @returns 被删除的文件名（升序）
 */
export function pruneBackups(backupDir: string, keep: number): string[] {
  if (!fs.existsSync(backupDir)) return [];
  const files = fs
    .readdirSync(backupDir)
    .filter((name) => name.startsWith(BACKUP_PREFIX) && name.endsWith('.dump'))
    .sort();
  const excess = files.slice(0, Math.max(0, files.length - Math.max(1, keep)));
  for (const name of excess) {
    try {
      fs.rmSync(path.join(backupDir, name), { force: true });
    } catch {
      // 清理失败不影响部署结果（磁盘告警级别）
    }
  }
  return excess;
}

/**
 * 执行备份
 * @param options 选项
 */
export async function backupDatabase(options: BackupOptions): Promise<BackupResult> {
  fs.mkdirSync(options.backupDir, { recursive: true });
  const file = path.join(options.backupDir, backupFileName(options.now));
  const compose = [
    'docker',
    'compose',
    '--env-file',
    options.envFile,
    '-f',
    options.composeFile,
    'exec',
    '-T',
    options.service,
    'pg_dump',
    '-U',
    options.dbUser,
    '-Fc',
    options.dbName,
  ].join(' ');
  const commandLine = `${compose} > ${quote(file)}`;

  try {
    await options.shell(commandLine, options.projectRoot);
  } catch (error) {
    throw new Error(
      `备份失败：${firstLineOf(error)}。迁移未执行；请确认 postgres 服务已启动（docker compose up -d postgres）`,
    );
  }

  const problem = verifyDump(file);
  if (problem) {
    throw new Error(`备份不可用（${problem}）：已中止部署，未执行任何迁移`);
  }
  const bytes = fs.statSync(file).size;
  const pruned = pruneBackups(options.backupDir, options.keep);
  return { file, bytes, pruned };
}
