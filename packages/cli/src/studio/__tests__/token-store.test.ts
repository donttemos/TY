/*
 * @file Studio 令牌持久化单测（PRD-017 FR-17-26）
 * @description 锁死「重启不换 token」：同项目复用、跨项目隔离、--new-token 才轮换、
 *   显式令牌不落盘、文件损坏也能启动。这些直接决定用户会不会在保存时突然 401。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolveStudioToken } from '../token-store.js';

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-studio-token-'));
  file = path.join(tmpDir, 'token.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const resolve = (projectRoot: string, extra: { explicit?: string; rotate?: boolean } = {}) =>
  resolveStudioToken({ projectRoot, env: { FW_STUDIO_TOKEN_FILE: file }, ...extra });

describe('resolveStudioToken', () => {
  it('首次生成并写入文件，第二次同项目复用', () => {
    const first = resolve('/work/project-a');
    expect(first.token.length).toBeGreaterThan(20);
    expect(first.created).toBe(true);
    expect(fs.existsSync(file)).toBe(true);

    const second = resolve('/work/project-a');
    expect(second.created).toBe(false);
    expect(second.token).toBe(first.token);
  });

  it('不同项目使用不同令牌（互不打断）', () => {
    const a = resolve('/work/a');
    const b = resolve('/work/b');
    expect(a.token).not.toBe(b.token);
  });

  it('--new-token 才轮换，并覆盖文件里的旧值', () => {
    const first = resolve('/work/a');
    const rotated = resolve('/work/a', { rotate: true });
    expect(rotated.created).toBe(true);
    expect(rotated.token).not.toBe(first.token);
    expect(resolve('/work/a').token).toBe(rotated.token);
  });

  it('显式令牌优先且不写文件（测试与 CI 不污染用户目录）', () => {
    const result = resolve('/work/a', { explicit: 'fixed-token' });
    expect(result.token).toBe('fixed-token');
    expect(fs.existsSync(file)).toBe(false);
  });

  it('文件损坏时重建，不阻断启动', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken', 'utf8');
    const result = resolve('/work/a');
    expect(result.token.length).toBeGreaterThan(20);
    expect(() => JSON.parse(fs.readFileSync(file, 'utf8'))).not.toThrow();
  });

  it('令牌文件按项目哈希分桶，不写入绝对路径', () => {
    resolve('C:/work/secret-project');
    const raw = fs.readFileSync(file, 'utf8');
    expect(raw).not.toContain('secret-project');
    expect(raw).not.toContain('C:/work');
  });
});
