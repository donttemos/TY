/*
 * @file fw verify 单测（PRD-016 FR-16-15/16）
 * @description 用假执行器 / 假后台进程 / 假浏览器覆盖：ci 全链路顺序（基线 seed 必须在生成之前）、
 *   生成失败即停、模型已存在时跳过、浏览器失败与跳过、real 目标只验健康与 CRUD、
 *   以及收尾清理（目录 + pnpm-workspace 两行）。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { VERIFY_REPORT_FILE, cleanupWorkspace, resolveBrowserCwd, runVerify, type BackgroundProcess, type VerifyDeps } from '../verify.js';
import type { Exec } from '../../deploy/exec.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-verify-'));
  fs.mkdirSync(path.join(tmpDir, 'apps'), { recursive: true });
  fs.writeFileSync(
    path.join(tmpDir, 'pnpm-workspace.yaml'),
    'packages:\n  - "packages/*"\n  - "apps/*"\n',
    'utf8',
  );
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** 假后台进程 */
const fakeBg = (): BackgroundProcess => ({ stop: async () => undefined, tail: () => 'boot log' });

/** 假执行器：`new` 时把验收项目脚本化建出来，其余命令记录即可 */
function makeExec(options: { failOn?: string } = {}): { exec: Exec; calls: string[] } {
  const calls: string[] = [];
  const exec: Exec = async (command, args, cwd) => {
    const line = `${command} ${args.join(' ')}`;
    calls.push(line);
    if (options.failOn && line.includes(options.failOn)) throw new Error(`模拟失败：${options.failOn}`);
    if (args.includes('new')) {
      const name = args[args.indexOf('new') + 1];
      const server = path.join(cwd, name, 'server');
      fs.mkdirSync(path.join(server, 'prisma'), { recursive: true });
      fs.writeFileSync(path.join(server, 'prisma', 'schema.prisma'), 'model DemoItem { id String @id }\n', 'utf8');
      fs.mkdirSync(path.join(cwd, name, 'admin-web', 'src', 'components', 'CrudTable'), { recursive: true });
      // 模拟 fw new 注册工作区成员
      fs.appendFileSync(
        path.join(tmpDir, 'pnpm-workspace.yaml'),
        `  # ↓ 由 fw new ${name} --template=admin 注册\n  - "apps/${name}/server"\n  - "apps/${name}/admin-web"\n`,
        'utf8',
      );
    }
    return { stdout: '', stderr: '' };
  };
  return { exec, calls };
}

const okFetch = (async () => new Response('ok', { status: 200 })) as unknown as typeof fetch;

function makeDeps(overrides: Partial<VerifyDeps> = {}): VerifyDeps {
  return {
    exec: makeExec().exec,
    spawn: () => fakeBg(),
    fetchImpl: okFetch,
    sleep: async () => undefined,
    now: () => new Date('2026-10-22T09:00:00'),
    io: { log: () => undefined, error: () => undefined },
    browser: async () => ({ status: 'passed', detail: '浏览器用例通过' }),
    ...overrides,
  };
}

describe('runVerify target=ci', () => {
  it('全链路通过，且基线 seed 排在生成之前', async () => {
    const { exec, calls } = makeExec();
    const report = await runVerify({ projectRoot: tmpDir }, makeDeps({ exec }));

    expect(report.result).toBe('success');
    expect(report.stages.map((stage) => stage.name)).toEqual([
      'workspace',
      'install',
      'model',
      'migrate',
      'seed',
      'generate',
      'build',
      'boot',
      'browser',
    ]);
    const seedIndex = calls.findIndex((line) => line.includes('tsx prisma/seed.ts'));
    const genIndex = calls.findIndex((line) => line.includes('gen crud Product'));
    expect(seedIndex).toBeGreaterThanOrEqual(0);
    expect(genIndex).toBeGreaterThan(seedIndex);
    expect(fs.existsSync(path.join(tmpDir, VERIFY_REPORT_FILE))).toBe(true);
  });

  it('清理生效：默认删除验收项目与 workspace 两行', async () => {
    const { exec } = makeExec();
    await runVerify({ projectRoot: tmpDir }, makeDeps({ exec }));
    expect(fs.existsSync(path.join(tmpDir, 'apps', 'auto-verify'))).toBe(false);
    const workspace = fs.readFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), 'utf8');
    expect(workspace).not.toContain('auto-verify');
  });

  it('--keep 保留项目便于排查', async () => {
    const { exec } = makeExec();
    await runVerify({ projectRoot: tmpDir, keep: true }, makeDeps({ exec }));
    expect(fs.existsSync(path.join(tmpDir, 'apps', 'auto-verify', 'server'))).toBe(true);
  });

  it('生成失败即停在 generate 阶段，并给出下一步', async () => {
    const { exec } = makeExec({ failOn: 'gen crud' });
    await expect(runVerify({ projectRoot: tmpDir }, makeDeps({ exec }))).rejects.toThrow(/生成失败/);
    const report = JSON.parse(fs.readFileSync(path.join(tmpDir, VERIFY_REPORT_FILE), 'utf8'));
    expect(report.result).toBe('failed');
    expect(report.error.stage).toBe('generate');
    expect(report.error.next).toContain('fw gen crud');
  });

  it('模型已存在时跳过写入（断点重跑幂等）', async () => {
    const { exec } = makeExec();
    // 先跑一次并保留项目
    await runVerify({ projectRoot: tmpDir, keep: true }, makeDeps({ exec }));
    const second = await runVerify({ projectRoot: tmpDir, keep: true }, makeDeps({ exec }));
    const model = second.stages.find((stage) => stage.name === 'model');
    expect(model?.status).toBe('skipped');
  });

  it('--skip-browser 时浏览器阶段标记 skipped 且不调用用例', async () => {
    let called = 0;
    const { exec } = makeExec();
    const report = await runVerify(
      { projectRoot: tmpDir, skipBrowser: true },
      makeDeps({ exec, browser: async () => {
        called += 1;
        return { status: 'passed', detail: '' };
      } }),
    );
    expect(called).toBe(0);
    expect(report.stages.find((stage) => stage.name === 'browser')?.status).toBe('skipped');
  });

  it('浏览器用例失败则整体失败（不放过）', async () => {
    const { exec } = makeExec();
    await expect(
      runVerify(
        { projectRoot: tmpDir },
        makeDeps({ exec, browser: async () => ({ status: 'failed', detail: '未找到新增按钮' }) }),
      ),
    ).rejects.toThrow(/浏览器 CRUD 未通过.*未找到新增按钮/);
  });

  it('失败时保留生成项目（.verify-process.log 就是 500 的堆栈现场）', async () => {
    const { exec } = makeExec();
    await expect(
      runVerify(
        { projectRoot: tmpDir },
        makeDeps({ exec, browser: async () => ({ status: 'failed', detail: '弹窗未关闭' }) }),
      ),
    ).rejects.toThrow();
    expect(fs.existsSync(path.join(tmpDir, 'apps', 'auto-verify', 'server'))).toBe(true);
  });

  it('浏览器缺失时记为 skipped 而不是伪通过（默认执行器路径）', async () => {
    const { exec } = makeExec();
    const report = await runVerify(
      { projectRoot: tmpDir },
      makeDeps({ exec, browser: async () => ({ status: 'skipped', detail: '未安装 Playwright' }) }),
    );
    expect(report.result).toBe('success');
    expect(report.stages.find((stage) => stage.name === 'browser')?.status).toBe('skipped');
  });

  it('服务未就绪时报 boot 阶段并附日志尾部', async () => {
    const { exec } = makeExec();
    const deadFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      runVerify({ projectRoot: tmpDir, healthTimeoutMs: 5 }, makeDeps({ exec, fetchImpl: deadFetch })),
    ).rejects.toThrow(/服务未就绪/);
  });

  it('生成项目没装 Playwright 时回落到仓库 admin-web 的用例（不让浏览器阶段静默跳过）', async () => {
    const { exec } = makeExec();
    // 仓库 admin-web 装好 Playwright：生成项目里没有，回落必须生效
    fs.mkdirSync(path.join(tmpDir, 'apps', 'admin-web', 'node_modules', '@playwright', 'test'), { recursive: true });
    let usedCwd = '';
    const report = await runVerify(
      { projectRoot: tmpDir, keep: true },
      makeDeps({
        exec,
        browser: async (options) => {
          usedCwd = options.cwd;
          return { status: 'passed', detail: '浏览器用例通过' };
        },
      }),
    );
    expect(report.result).toBe('success');
    expect(usedCwd).toBe(path.join(tmpDir, 'apps', 'admin-web'));
    expect(report.stages.find((stage) => stage.name === 'browser')?.status).toBe('ok');
  });
});

describe('resolveBrowserCwd', () => {  it('生成项目自带用例时优先用它自己的目录', () => {
    const webDir = path.join(tmpDir, 'apps', 'auto-verify', 'admin-web');
    fs.mkdirSync(path.join(webDir, 'node_modules', '@playwright', 'test'), { recursive: true });
    expect(resolveBrowserCwd(tmpDir, webDir)).toEqual({ cwd: webDir, fallback: false });
  });

  it('生成项目与仓库都没有 Playwright 时保持生成项目目录（由执行器给 skipped 与安装提示）', () => {
    const webDir = path.join(tmpDir, 'apps', 'auto-verify', 'admin-web');
    fs.mkdirSync(webDir, { recursive: true });
    expect(resolveBrowserCwd(tmpDir, webDir)).toEqual({ cwd: webDir, fallback: false });
  });

  it('项目名恰为 admin-web 时不自我回落', () => {
    const webDir = path.join(tmpDir, 'apps', 'admin-web');
    fs.mkdirSync(path.join(webDir, 'node_modules', '@playwright', 'test'), { recursive: true });
    expect(resolveBrowserCwd(tmpDir, webDir)).toEqual({ cwd: webDir, fallback: false });
  });
});

describe('runVerify target=real', () => {
  it('健康通过 + 浏览器通过', async () => {
    const report = await runVerify({ projectRoot: tmpDir, target: 'real', baseUrl: 'http://demo.local' }, makeDeps());
    expect(report.result).toBe('success');
    expect(report.baseUrl).toBe('http://demo.local');
    expect(report.stages.map((stage) => stage.name)).toEqual(['deploy', 'health', 'browser']);
  });

  it('健康未通过即停（不再跑浏览器）', async () => {
    let browserCalled = false;
    const deadFetch = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    await expect(
      runVerify(
        { projectRoot: tmpDir, target: 'real', baseUrl: 'http://demo.local', healthTimeoutMs: 5 },
        makeDeps({
          fetchImpl: deadFetch,
          browser: async () => {
            browserCalled = true;
            return { status: 'passed', detail: '' };
          },
        }),
      ),
    ).rejects.toThrow(/健康检查未通过/);
    expect(browserCalled).toBe(false);
  });
});

describe('cleanupWorkspace', () => {
  it('目录不存在时安全执行，且只删本项目的 glob 行', () => {
    fs.appendFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), '  - "apps/other/server"\n', 'utf8');
    expect(() => cleanupWorkspace(tmpDir, 'auto-verify')).not.toThrow();
    expect(fs.readFileSync(path.join(tmpDir, 'pnpm-workspace.yaml'), 'utf8')).toContain('apps/other/server');
  });
});

describe('ensureSqliteFile', () => {
  const setupServer = (env: string): string => {
    const server = path.join(tmpDir, 'apps', 'sqlite-case', 'server');
    fs.mkdirSync(path.join(server, 'prisma'), { recursive: true });
    fs.writeFileSync(path.join(server, '.env'), env, 'utf8');
    return server;
  };

  it('sqlite 时按 schema 目录预创建库文件（引擎无法自建）', async () => {
    const { ensureSqliteFile } = await import('../verify.js');
    const server = setupServer('DB_DRIVER=sqlite\nDB_URL=file:./dev.db\n');
    ensureSqliteFile(server);
    expect(fs.existsSync(path.join(server, 'prisma', 'dev.db'))).toBe(true);
  });

  it('已存在时不重复创建（保留数据）', async () => {
    const { ensureSqliteFile } = await import('../verify.js');
    const server = setupServer('DB_DRIVER=sqlite\nDB_URL=file:./dev.db\n');
    const dbFile = path.join(server, 'prisma', 'dev.db');
    fs.writeFileSync(dbFile, 'keep-me', 'utf8');
    ensureSqliteFile(server);
    expect(fs.readFileSync(dbFile, 'utf8')).toBe('keep-me');
  });

  it('非 sqlite 或内存库时什么都不做', async () => {
    const { ensureSqliteFile } = await import('../verify.js');
    const pg = setupServer('DB_DRIVER=postgres\nDB_URL=postgresql://x/y\n');
    ensureSqliteFile(pg);
    expect(fs.readdirSync(path.join(pg, 'prisma'))).toEqual([]);
    const mem = setupServer('DB_DRIVER=sqlite\nDB_URL=file::memory:/n');
    ensureSqliteFile(mem);
    expect(fs.readdirSync(path.join(mem, 'prisma'))).toEqual([]);
  });
});
