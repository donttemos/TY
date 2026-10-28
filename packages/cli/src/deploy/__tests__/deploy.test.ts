/*
 * @file fw deploy 编排单测（PRD-016 FR-16-10/11/13/14）
 * @description 用假执行器覆盖：首次向导与二次零输入、--plan 不落任何变更、破坏性迁移闸门
 *   （首次跳过 / 二次阻断 / 放行）、健康失败回退、--rollback、bare-metal 透传、报告与清单落盘。
 *   docker / 网络 / stdin 全部替身，测试不依赖真实环境。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEPLOY_MANIFEST_FILE,
  DEPLOY_REPORT_FILE,
  assessNewMigrations,
  nextImageTag,
  readManifest,
  runDeploy,
  type DeployDeps,
  type DeployManifest,
} from '../deploy.js';
import type { Exec, Shell } from '../exec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-deploy-run-'));
  fs.mkdirSync(path.join(tmpDir, 'prisma', 'migrations'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'prisma', 'schema.prisma'), 'model A { id String @id }\n', 'utf8');
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 写入一个迁移目录 */
function addMigration(name: string, sql: string): void {
  const dir = path.join(tmpDir, 'prisma', 'migrations', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'migration.sql'), sql, 'utf8');
}

/** 假 docker 执行器（记录命令，全部成功） */
function makeExec(options: { failOn?: string } = {}): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (command, args) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    if (options.failOn && line.includes(options.failOn)) throw new Error(`模拟失败：${options.failOn}`);
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

/** 假备份执行器：把 dump 写到命令里的重定向目标 */
const okShell: Shell = async (commandLine) => {
  const matched = commandLine.match(/> '(.+)'$/);
  if (matched) {
    fs.mkdirSync(path.dirname(matched[1]), { recursive: true });
    fs.writeFileSync(matched[1], Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(2048)]));
  }
  return { stdout: '', stderr: '' };
};

/** 健康检查替身 */
const okFetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;
const deadFetch = (async () => {
  throw new Error('ECONNREFUSED');
}) as unknown as typeof fetch;

/** 基础依赖 */
function makeDeps(overrides: Partial<DeployDeps> = {}): DeployDeps {
  return {
    exec: makeExec().exec,
    shell: okShell,
    fetchImpl: okFetch,
    sleep: async () => undefined,
    now: () => new Date('2026-10-22T09:08:07'),
    io: { log: () => undefined, error: () => undefined },
    ask: async (_question, placeholder) => (placeholder === 'example.com' ? 'fw.example.com' : ''),
    ...overrides,
  };
}

/** 预置完整 env 文件（模拟二次部署） */
function writeEnv(): void {
  fs.writeFileSync(
    path.join(tmpDir, '.env.prod'),
    'APP_ENV=prod\nAPP_DOMAIN=fw.example.com\nPOSTGRES_PASSWORD=p\nREDIS_PASSWORD=r\nJWT_SECRET=j\nAPP_IMAGE=fw-app:old\nAPP_REPLICAS=1\nWORKER_REPLICAS=1\n',
    'utf8',
  );
}

/** 预置清单 */
function writeManifestFile(manifest: DeployManifest): void {
  fs.writeFileSync(path.join(tmpDir, DEPLOY_MANIFEST_FILE), JSON.stringify(manifest), 'utf8');
}

describe('runDeploy 首次部署', () => {
  it('向导生成配置，全阶段通过，清单与报告落盘', async () => {
    const { exec, calls } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, healthTimeoutMs: 50 }, makeDeps({ exec }));

    expect(report.result).toBe('success');
    expect(report.stages.map((stage) => stage.name)).toEqual(['env', 'preflight', 'plan', 'build', 'backup', 'migrate', 'up', 'health']);
    expect(fs.existsSync(path.join(tmpDir, '.env.prod'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, '.env.prod'), 'utf8')).toContain('APP_DOMAIN=fw.example.com');
    expect(calls.some((line) => line.includes('build app'))).toBe(true);
    expect(calls.some((line) => line.includes('run --rm migrate'))).toBe(true);
    expect(calls.some((line) => line.includes('up -d'))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, DEPLOY_MANIFEST_FILE))).toBe(true);
    expect(fs.existsSync(path.join(tmpDir, DEPLOY_REPORT_FILE))).toBe(true);
    expect(readManifest(tmpDir).current?.image).toMatch(/^fw-app:/);
  });

  it('二次部署零提问（已有 .env.prod 直接沿用）', async () => {
    writeEnv();
    const ask = vi.fn(async () => 'never');
    const { exec } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, healthTimeoutMs: 50 }, makeDeps({ exec, ask }));
    expect(ask).not.toHaveBeenCalled();
    expect(report.stages.find((stage) => stage.name === 'env')?.status).toBe('skipped');
  });

  it('--yes 非交互：缺配置自动生成密钥且不回显', async () => {
    const { exec } = makeExec();
    const ask = vi.fn(async () => 'never');
    const logs: string[] = [];
    await runDeploy(
      { projectRoot: tmpDir, yes: true, healthTimeoutMs: 50 },
      makeDeps({ exec, ask, io: { log: (m) => logs.push(m), error: () => undefined } }),
    );
    expect(ask).not.toHaveBeenCalled();
    const env = fs.readFileSync(path.join(tmpDir, '.env.prod'), 'utf8');
    expect(env).toContain('POSTGRES_PASSWORD=');
    expect(logs.join('\n')).toContain('自动生成');
    // 日志不得出现密钥值本身
    const secret = env.match(/JWT_SECRET=(.+)/)?.[1] ?? '';
    expect(secret.length).toBeGreaterThan(20);
    expect(logs.join('\n')).not.toContain(secret);
  });
});

describe('runDeploy --plan', () => {
  it('只输出计划：不构建、不备份、不迁移、不启动', async () => {
    writeEnv();
    const { exec, calls } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, plan: true }, makeDeps({ exec }));
    expect(report.result).toBe('planned');
    expect(calls.some((line) => line.includes('build'))).toBe(false);
    expect(calls.some((line) => line.includes('migrate'))).toBe(false);
    expect(calls.some((line) => line.includes('up -d'))).toBe(false);
    expect(report.stages.map((stage) => stage.name)).toEqual(['env', 'preflight', 'plan']);
  });

  it('--plan 无副作用：不提问、不写 .env.prod', async () => {
    const ask = vi.fn(async () => 'never');
    const { exec } = makeExec();
    await runDeploy({ projectRoot: tmpDir, plan: true }, makeDeps({ exec, ask }));
    expect(ask).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tmpDir, '.env.prod'))).toBe(false);
  });
});

describe('runDeploy 迁移风险闸门', () => {
  it('首次部署遇到破坏性历史迁移时跳过闸门（否则存量项目首上永远卡住）', async () => {
    addMigration('20260101_init', 'DROP TABLE "Old";');
    const { exec } = makeExec();
    const logs: string[] = [];
    const report = await runDeploy(
      { projectRoot: tmpDir, healthTimeoutMs: 50 },
      makeDeps({ exec, io: { log: (m) => logs.push(m), error: () => undefined } }),
    );
    expect(report.result).toBe('success');
    expect(logs.join('\n')).toContain('跳过迁移风险闸门');
  });

  it('二次部署遇到破坏性迁移默认阻断，且不构建不迁移', async () => {
    writeEnv();
    writeManifestFile({ version: 1, current: { image: 'fw-app:old', deployedAt: '2026-10-21' }, appliedMigrations: [] });
    addMigration('20260101_drop', 'ALTER TABLE "Order" DROP COLUMN "remark";');
    const { exec, calls } = makeExec();
    await expect(runDeploy({ projectRoot: tmpDir }, makeDeps({ exec, confirmDestructive: async () => false }))).rejects.toThrow(
      /迁移被阻断.*--allow-destructive/s,
    );
    expect(calls.some((line) => line.includes('build'))).toBe(false);
  });

  it('--allow-destructive 放行后继续执行', async () => {
    writeEnv();
    writeManifestFile({ version: 1, current: { image: 'fw-app:old', deployedAt: '2026-10-21' }, appliedMigrations: [] });
    addMigration('20260101_drop', 'DROP TABLE "Old";');
    const { exec, calls } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, allowDestructive: true, healthTimeoutMs: 50 }, makeDeps({ exec }));
    expect(report.result).toBe('success');
    expect(calls.some((line) => line.includes('migrate deploy') || line.includes('run --rm migrate'))).toBe(true);
    expect(report.migration?.risk).toBe('blocked');
  });

  it('已应用过的迁移不再计入风险（只评估新增）', async () => {
    writeEnv();
    addMigration('20260101_drop', 'DROP TABLE "Old";');
    writeManifestFile({
      version: 1,
      current: { image: 'fw-app:old', deployedAt: '2026-10-21' },
      appliedMigrations: ['20260101_drop'],
    });
    const result = assessNewMigrations(tmpDir, ['20260101_drop']);
    expect(result.names).toEqual([]);
    expect(result.assessment).toBeNull();
  });
});

describe('runDeploy 健康检查与回退', () => {
  it('健康失败且无历史版本时报告 failed 并指明阶段', async () => {
    writeEnv();
    const { exec } = makeExec();
    await expect(
      runDeploy({ projectRoot: tmpDir, healthTimeoutMs: 10 }, makeDeps({ exec, fetchImpl: deadFetch })),
    ).rejects.toThrow(/健康检查未通过/);
    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, DEPLOY_REPORT_FILE), 'utf8'));
    expect(report.result).toBe('failed');
    expect(report.error.stage).toBe('health');
    expect(report.error.next).toContain('数据库未回滚');
  });

  it('健康失败但有历史版本时自动回退并重启', async () => {
    writeEnv();
    writeManifestFile({ version: 1, current: { image: 'fw-app:prev', deployedAt: '2026-10-21' }, appliedMigrations: [] });
    const { exec, calls } = makeExec();
    const errors: string[] = [];
    await expect(
      runDeploy(
        { projectRoot: tmpDir, healthTimeoutMs: 10 },
        makeDeps({ exec, fetchImpl: deadFetch, io: { log: () => undefined, error: (m) => errors.push(m) } }),
      ),
    ).rejects.toThrow(/已回退到上一镜像/);
    expect(errors.join('\n')).toContain('回退到 fw-app:prev');
    // 首次 up + 回退 up
    expect(calls.filter((line) => line.includes('up -d')).length).toBeGreaterThanOrEqual(2);
    expect(fs.readFileSync(path.join(tmpDir, '.env.prod'), 'utf8')).toContain('APP_IMAGE=fw-app:prev');
  });

  it('--rollback 换回上一镜像并完成健康检查', async () => {
    writeEnv();
    writeManifestFile({
      version: 1,
      current: { image: 'fw-app:new', deployedAt: '2026-10-22' },
      previous: { image: 'fw-app:prev', deployedAt: '2026-10-21' },
      appliedMigrations: [],
    });
    const { exec, calls } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, rollback: true, healthTimeoutMs: 50 }, makeDeps({ exec }));
    expect(report.result).toBe('success');
    expect(report.image).toBe('fw-app:prev');
    expect(calls.some((line) => line.includes('up -d'))).toBe(true);
    const manifest = readManifest(tmpDir);
    expect(manifest.current?.image).toBe('fw-app:prev');
    expect(manifest.previous?.image).toBe('fw-app:new');
  });

  it('--rollback 无历史版本时给出明确报错', async () => {
    writeEnv();
    const { exec } = makeExec();
    await expect(runDeploy({ projectRoot: tmpDir, rollback: true }, makeDeps({ exec }))).rejects.toThrow(
      /没有可回退的上一版本/,
    );
  });
});

describe('runDeploy 其它分支', () => {
  it('--target=bare-metal 透传既有脚本且不改动编排', async () => {
    const { exec, calls } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, target: 'bare-metal' }, makeDeps({ exec }));
    expect(report.result).toBe('success');
    expect(calls.some((line) => line.includes('bare-metal-deploy.sh'))).toBe(true);
    expect(calls.some((line) => line.includes('compose'))).toBe(false);
  });

  it('--skip-backup 跳过备份阶段', async () => {
    writeEnv();
    const { exec } = makeExec();
    const report = await runDeploy({ projectRoot: tmpDir, skipBackup: true, healthTimeoutMs: 50 }, makeDeps({ exec }));
    expect(report.stages.find((stage) => stage.name === 'backup')?.status).toBe('skipped');
  });

  it('构建失败时报告 build 阶段且不再往下走', async () => {
    writeEnv();
    const { exec, calls } = makeExec({ failOn: 'build app' });
    await expect(runDeploy({ projectRoot: tmpDir }, makeDeps({ exec }))).rejects.toThrow(/镜像构建失败/);
    expect(calls.some((line) => line.includes('run --rm migrate'))).toBe(false);
  });

  it('--seed 才执行种子容器（默认绝不自动 seed，避免清场）', async () => {
    writeEnv();
    const withoutSeed = makeExec();
    await runDeploy({ projectRoot: tmpDir, healthTimeoutMs: 50 }, makeDeps({ exec: withoutSeed.exec }));
    expect(withoutSeed.calls.some((line) => line.includes('tsx prisma/seed.ts'))).toBe(false);

    const withSeed = makeExec();
    const report = await runDeploy(
      { projectRoot: tmpDir, seed: true, healthTimeoutMs: 50 },
      makeDeps({ exec: withSeed.exec }),
    );
    expect(withSeed.calls.some((line) => line.includes('tsx prisma/seed.ts'))).toBe(true);
    expect(report.stages.some((stage) => stage.name === 'seed' && stage.status === 'ok')).toBe(true);
  });

  it('首次部署计划里提示 --seed（否则首装没有账号可登录）', async () => {
    const { exec } = makeExec();
    const logs: string[] = [];
    await runDeploy(
      { projectRoot: tmpDir, plan: true },
      makeDeps({ exec, io: { log: (m) => logs.push(m), error: () => undefined } }),
    );
    expect(logs.join('\n')).toContain('--seed');
  });

  it('nextImageTag 时间戳 + 短后缀，同一秒内也不同', () => {
    const now = new Date('2026-10-22T09:08:07');
    expect(nextImageTag(now, 'abcd')).toBe('fw-app:20261022090807-abcd');
    expect(nextImageTag(now, 'abcd')).not.toBe(nextImageTag(now, 'efgh'));
  });
});
