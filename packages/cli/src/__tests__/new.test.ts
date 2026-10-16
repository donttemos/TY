/*
 * @file fw new 命令单测
 * @description 覆盖项目名 kebab-case 校验、未知模板、未交付模板（cms）的规划提示、
 *   目标目录占用，以及成功路径：模板复制、__APP_NAME__ 占位符替换、.env 由 .env.example 生成；
 *   admin 模板（E-08）追加：全栈结构复制、仓库外生成的未注册告警。
 * @author donttemo
 * @created 2026-10-13
 * @modified 2026-10-15 donttemo E-08：admin 模板交付——未交付断言改为 cms，新增 admin 成功路径与注册告警用例
 * @module cli
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runNew } from '../commands/new.js';

/** 每个用例独立的临时 cwd（避免污染仓库根） */
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-new-'));
  vi.spyOn(process, 'cwd').mockReturnValue(tmpDir);
  vi.spyOn(console, 'log').mockImplementation(() => undefined);
});

// 超时 30s：admin 模板复制产物的整树删除在 Windows + 低配盘上可能超 vitest 默认 10s（负载相关，与断言无关）
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}, 30_000);

describe('runNew 参数校验', () => {
  it('项目名非 kebab-case 时拒绝', async () => {
    await expect(runNew('MyApp', 'api')).rejects.toThrow('项目名不合法');
    await expect(runNew('1app', 'api')).rejects.toThrow('项目名不合法');
    await expect(runNew('my_app', 'api')).rejects.toThrow('项目名不合法');
    await expect(runNew('-app', 'api')).rejects.toThrow('项目名不合法');
  });

  it('未知模板时拒绝并列出可选模板', async () => {
    await expect(runNew('my-app', 'nope')).rejects.toThrow('未知模板');
  });

  it('未交付的 cms 模板给出规划提示而非静默降级', async () => {
    await expect(runNew('my-app', 'cms')).rejects.toThrow('尚未交付');
  });

  it('目标目录已存在时拒绝', async () => {
    fs.mkdirSync(path.join(tmpDir, 'my-app'));
    await expect(runNew('my-app', 'api')).rejects.toThrow('目录已存在');
  });
});

describe('runNew 成功路径', () => {
  it('复制 templates/api、替换占位符并生成 .env', async () => {
    await runNew('my-system', 'api');
    const target = path.join(tmpDir, 'my-system');

    // 模板文件已复制
    expect(fs.existsSync(path.join(target, 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'tsconfig.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'README.md'))).toBe(true);
    expect(fs.existsSync(path.join(target, '.env.example'))).toBe(true);

    // package.json 的 __APP_NAME__ 已替换为项目名
    const pkg = JSON.parse(fs.readFileSync(path.join(target, 'package.json'), 'utf8')) as { name: string };
    expect(pkg.name).toBe('my-system');
    expect(JSON.stringify(pkg)).not.toContain('__APP_NAME__');

    // README 的占位符已替换
    const readme = fs.readFileSync(path.join(target, 'README.md'), 'utf8');
    expect(readme).toContain('# my-system');
    expect(readme).not.toContain('__APP_NAME__');

    // .env 由 .env.example 生成，内容一致
    const envPath = path.join(target, '.env');
    expect(fs.existsSync(envPath)).toBe(true);
    expect(fs.readFileSync(envPath, 'utf8')).toBe(fs.readFileSync(path.join(target, '.env.example'), 'utf8'));
  });

  it('生成成功后打印后续步骤', async () => {
    const log = vi.spyOn(console, 'log');
    await runNew('my-system', 'api');
    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('项目已创建');
    expect(output).toContain('cd my-system');
  });

  it('admin 模板（E-08）：复制 server + admin-web 全栈结构并生成服务端 .env', async () => {
    await runNew('my-admin', 'admin');
    const target = path.join(tmpDir, 'my-admin');

    expect(fs.existsSync(path.join(target, 'server', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'server', 'prisma', 'schema.prisma'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'server', 'prisma', 'migrations'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'admin-web', 'package.json'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'admin-web', 'src', 'views', 'login', 'index.vue'))).toBe(true);

    // 占位符替换：server / admin-web 的 package.json name 均带项目名前缀
    const serverPkg = JSON.parse(fs.readFileSync(path.join(target, 'server', 'package.json'), 'utf8')) as { name: string };
    const webPkg = JSON.parse(fs.readFileSync(path.join(target, 'admin-web', 'package.json'), 'utf8')) as { name: string };
    expect(serverPkg.name).toBe('my-admin-server');
    expect(webPkg.name).toBe('my-admin-web');
    expect(JSON.stringify(serverPkg) + JSON.stringify(webPkg)).not.toContain('__APP_NAME__');

    // 服务端 .env 由 server/.env.example 生成
    expect(fs.existsSync(path.join(target, 'server', '.env'))).toBe(true);
  });

  it('admin 模板在框架仓库外生成时不自动注册工作区，输出手工注册说明', async () => {
    const log = vi.spyOn(console, 'log');
    await runNew('my-admin', 'admin');
    const output = log.mock.calls.map((call) => String(call[0])).join('\n');
    expect(output).toContain('未自动注册');
    expect(output).toContain('"my-admin/server"');
    expect(output).toContain('"my-admin/admin-web"');
  });
});
