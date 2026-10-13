/*
 * @file fw new 命令单测
 * @description 覆盖项目名 kebab-case 校验、未知模板、未交付模板（admin / cms）的里程碑提示、
 *   目标目录占用，以及成功路径：模板复制、__APP_NAME__ 占位符替换、.env 由 .env.example 生成。
 * @author donttemo
 * @created 2026-10-13
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

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

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

  it('未交付的 admin / cms 模板给出里程碑提示而非静默降级', async () => {
    await expect(runNew('my-app', 'admin')).rejects.toThrow('M5');
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
});
