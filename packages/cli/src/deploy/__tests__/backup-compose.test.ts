/*
 * @file 备份与 Compose 执行器单测（PRD-016 FR-16-12 / FR-16-10 / FR-16-13）
 * @description 备份侧锁死「魔数 + 体积」双校验与保留份数清理；Compose 侧锁死命令形状、
 *   三类预检失败的提示、健康检查的三种结局（通过 / HTTP 非 2xx / 无响应超时）。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupDatabase, backupFileName, pruneBackups, verifyDump } from '../backup.js';
import { composeArgs, composeBuild, composeMigrate, composePreflight, composeUp, waitForHealth } from '../compose.js';
import type { Exec, Shell } from '../exec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-deploy-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写一个合法备份文件（PGDMP 头 + 足够体积） */
function writeValidDump(file: string): void {
  fs.writeFileSync(file, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(2048)]));
}

describe('verifyDump', () => {
  it('合法文件返回 null', () => {
    const file = path.join(tmpDir, 'ok.dump');
    writeValidDump(file);
    expect(verifyDump(file)).toBeNull();
  });

  it('文件不存在给出原因', () => {
    expect(verifyDump(path.join(tmpDir, 'none.dump'))).toBe('备份文件未生成');
  });

  it('体积过小判定为失败输出', () => {
    const file = path.join(tmpDir, 'small.dump');
    fs.writeFileSync(file, 'pg_dump: error: connection refused');
    expect(verifyDump(file)).toContain('过小');
  });

  it('魔数不对判定为非自定义格式', () => {
    const file = path.join(tmpDir, 'wrong.dump');
    fs.writeFileSync(file, Buffer.concat([Buffer.from('XXXXX'), Buffer.alloc(2048)]));
    expect(verifyDump(file)).toContain('PGDMP');
  });
});

describe('pruneBackups', () => {
  it('按份数保留最新的，旧的删除', () => {
    for (const name of ['fw-20260101-000000.dump', 'fw-20260102-000000.dump', 'fw-20260103-000000.dump']) {
      writeValidDump(path.join(tmpDir, name));
    }
    expect(pruneBackups(tmpDir, 2)).toEqual(['fw-20260101-000000.dump']);
    expect(fs.readdirSync(tmpDir).sort()).toEqual(['fw-20260102-000000.dump', 'fw-20260103-000000.dump']);
  });

  it('目录不存在时安全返回', () => {
    expect(pruneBackups(path.join(tmpDir, 'nope'), 3)).toEqual([]);
  });
});

describe('backupFileName', () => {
  it('按本地时间生成可排序名', () => {
    expect(backupFileName(new Date('2026-10-22T09:08:07'))).toBe('fw-20261022-090807.dump');
  });
});

describe('backupDatabase', () => {
  const base = () => ({
    projectRoot: tmpDir,
    backupDir: path.join(tmpDir, 'backups'),
    composeFile: 'deploy/docker-compose.prod.yml',
    envFile: '.env.prod',
    service: 'postgres',
    dbUser: 'fw',
    dbName: 'fw',
    keep: 2,
    now: new Date('2026-10-22T09:08:07'),
  });

  it('命令含 env-file / compose / pg_dump -Fc，并在成功后校验落盘', async () => {
    const calls: string[] = [];
    const shell: Shell = async (commandLine) => {
      calls.push(commandLine);
      writeValidDump(path.join(tmpDir, 'backups', 'fw-20261022-090807.dump'));
      return { stdout: '', stderr: '' };
    };
    const result = await backupDatabase({ ...base(), shell });
    expect(calls[0]).toContain('--env-file .env.prod');
    expect(calls[0]).toContain('-f deploy/docker-compose.prod.yml');
    expect(calls[0]).toContain('pg_dump -U fw -Fc fw');
    expect(result.bytes).toBeGreaterThan(1024);
  });

  it('命令失败时抛出带下一步的短错误', async () => {
    const shell: Shell = async () => {
      throw new Error('service "postgres" is not running');
    };
    await expect(backupDatabase({ ...base(), shell })).rejects.toThrow(/备份失败.*service "postgres" is not running/);
  });

  it('备份不可读时中止（不允许空备份继续迁移）', async () => {
    const shell: Shell = async () => ({ stdout: '', stderr: '' });
    await expect(backupDatabase({ ...base(), shell })).rejects.toThrow(/备份不可用/);
  });

  it('成功后按份数清理旧备份', async () => {
    fs.mkdirSync(path.join(tmpDir, 'backups'), { recursive: true });
    for (const name of ['fw-20260101-000000.dump', 'fw-20260102-000000.dump']) {
      writeValidDump(path.join(tmpDir, 'backups', name));
    }
    const shell: Shell = async () => {
      writeValidDump(path.join(tmpDir, 'backups', 'fw-20261022-090807.dump'));
      return { stdout: '', stderr: '' };
    };
    const result = await backupDatabase({ ...base(), shell });
    expect(result.pruned).toEqual(['fw-20260101-000000.dump']);
  });
});

describe('composeArgs', () => {
  it('全局选项顺序固定（env-file 在前，-f 在各子命令前）', () => {
    const args = composeArgs(
      { projectRoot: tmpDir, composeFile: 'deploy/docker-compose.prod.yml', envFile: '.env.prod', exec: (async () => ({ stdout: '', stderr: '' })) as Exec },
      ['up', '-d'],
    );
    expect(args).toEqual(['compose', '--env-file', '.env.prod', '-f', 'deploy/docker-compose.prod.yml', 'up', '-d']);
  });
});

describe('composePreflight', () => {
  const context = (exec: Exec) => ({
    projectRoot: tmpDir,
    composeFile: 'deploy/docker-compose.prod.yml',
    envFile: '.env.prod',
    exec,
  });

  it('三者都通过时输出预检成功', async () => {
    const logs: string[] = [];
    const exec: Exec = async () => ({ stdout: '24.0.0', stderr: '' });
    await composePreflight(context(exec), { log: (m) => logs.push(m) });
    expect(logs.join('\n')).toContain('预检通过');
  });

  it('docker 不可用时提示安装', async () => {
    const exec: Exec = async () => {
      throw new Error('command not found: docker');
    };
    await expect(composePreflight(context(exec))).rejects.toThrow(/未检测到可用的 Docker/);
  });

  it('缺 compose 插件时单独提示（docker 可用）', async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args[0] === 'compose') throw new Error('docker: unknown command: compose');
      return { stdout: '24.0.0', stderr: '' };
    };
    await expect(composePreflight(context(exec))).rejects.toThrow(/未检测到 docker compose 插件/);
  });

  it('编排文件缺变量时提示检查 env 文件', async () => {
    const exec: Exec = async (_cmd, args) => {
      if (args.includes('config')) throw new Error('required variable JWT_SECRET is missing');
      return { stdout: 'ok', stderr: '' };
    };
    await expect(composePreflight(context(exec))).rejects.toThrow(/编排文件校验失败.*JWT_SECRET/);
  });
});

describe('compose 动作错误映射', () => {
  const context = (exec: Exec) => ({
    projectRoot: tmpDir,
    composeFile: 'deploy/docker-compose.prod.yml',
    envFile: '.env.prod',
    exec,
  });
  const io = { log: () => undefined };

  it('构建失败提示查看完整日志', async () => {
    const exec: Exec = async () => {
      throw new Error('bind source path does not exist');
    };
    await expect(composeBuild(context(exec), io)).rejects.toThrow(/镜像构建失败.*docker compose build app/);
  });

  it('启动失败提示 ps / logs', async () => {
    const exec: Exec = async () => {
      throw new Error('port is already allocated');
    };
    await expect(composeUp(context(exec), io)).rejects.toThrow(/启动失败.*docker compose ps/);
  });

  it('迁移失败提示已备份可重跑', async () => {
    const exec: Exec = async () => {
      throw new Error('P3009 migrate found failed migrations');
    };
    await expect(composeMigrate(context(exec), io)).rejects.toThrow(/迁移执行失败.*重跑 fw deploy/);
  });
});

describe('waitForHealth', () => {
  const noSleep = async () => undefined;

  it('首个 2xx 即通过', async () => {
    const result = await waitForHealth('http://x/health', {
      fetchImpl: (async () => new Response('ok', { status: 200 })) as typeof fetch,
      sleep: noSleep,
    });
    expect(result).toEqual({ ok: true, attempts: 1, lastStatus: 200 });
  });

  it('非 2xx 一直重试到超时，并记录最后状态', async () => {
    const result = await waitForHealth('http://x/health', {
      timeoutMs: 30,
      intervalMs: 10,
      fetchImpl: (async () => new Response('bad', { status: 503 })) as typeof fetch,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.lastStatus).toBe(503);
    expect(result.attempts).toBeGreaterThan(1);
  });

  it('连接失败记为无响应并保留原因', async () => {
    const result = await waitForHealth('http://x/health', {
      timeoutMs: 20,
      intervalMs: 10,
      fetchImpl: (async () => {
        throw new Error('ECONNREFUSED 127.0.0.1:3000');
      }) as typeof fetch,
      sleep: noSleep,
    });
    expect(result.ok).toBe(false);
    expect(result.lastStatus).toBeNull();
    expect(result.lastError).toContain('ECONNREFUSED');
  });
});
