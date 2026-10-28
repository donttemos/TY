/*
 * @file 部署环境文件与向导单测（PRD-016 FR-16-09）
 * @description 覆盖解析/序列化往返、引号与注释、缺键判定、首次向导（留空自动生成）、
 *   非交互补齐（已有值必须保留）、以及 600 权限（仅 POSIX 断言）。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  DEPLOY_ENV_FILE,
  fillNonInteractive,
  generateSecret,
  missingKeys,
  parseEnv,
  readDeployEnv,
  runWizard,
  serializeEnv,
  writeDeployEnv,
  type EnvEntries,
} from '../env-file.js';

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-cli-deploy-env-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('parseEnv / serializeEnv', () => {
  it('解析键值、忽略注释与空行', () => {
    const entries = parseEnv('# 注释\n\nAPP_ENV=prod\nAPP_DOMAIN=fw.example.com\n');
    expect(entries).toEqual({ APP_ENV: 'prod', APP_DOMAIN: 'fw.example.com' });
  });

  it('剥离包裹引号，保留内部空格', () => {
    const entries = parseEnv('A="hello world"\nB=\'single\'\nC=plain value\n');
    expect(entries.A).toBe('hello world');
    expect(entries.B).toBe('single');
    expect(entries.C).toBe('plain value');
  });

  it('同键后者覆盖（与 shell 语义一致）', () => {
    expect(parseEnv('A=1\nA=2').A).toBe('2');
  });

  it('序列化后能被解析回同一份内容', () => {
    const source: EnvEntries = { APP_ENV: 'prod', POSTGRES_PASSWORD: 'p@ss=word', JWT_SECRET: 'abc' };
    const text = serializeEnv(source, ['头部注释']);
    expect(text.startsWith('# 头部注释')).toBe(true);
    expect(parseEnv(text)).toEqual(source);
  });

  it('无值行与非法行被忽略', () => {
    expect(parseEnv('NOEQUALS\n=empty\nOK=1')).toEqual({ OK: '1' });
  });
});

describe('readDeployEnv / missingKeys', () => {
  it('文件不存在时返回空表且 exists=false', () => {
    const result = readDeployEnv(tmpDir);
    expect(result.exists).toBe(false);
    expect(result.entries).toEqual({});
    expect(result.file.endsWith(DEPLOY_ENV_FILE)).toBe(true);
  });

  it('缺键判定只认必需的四项', () => {
    expect(missingKeys({}).sort()).toEqual(['APP_DOMAIN', 'JWT_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD']);
    expect(
      missingKeys({
        APP_DOMAIN: 'a.com',
        POSTGRES_PASSWORD: 'p',
        REDIS_PASSWORD: 'r',
        JWT_SECRET: 'j',
        EXTRA: '',
      }),
    ).toEqual([]);
  });

  it('空白字符串视为缺失', () => {
    expect(missingKeys({ APP_DOMAIN: '  ', POSTGRES_PASSWORD: 'p', REDIS_PASSWORD: 'r', JWT_SECRET: 'j' })).toEqual([
      'APP_DOMAIN',
    ]);
  });
});

describe('writeDeployEnv', () => {
  it('写入后权限为 600（POSIX）', () => {
    const file = path.join(tmpDir, DEPLOY_ENV_FILE);
    writeDeployEnv(file, { APP_ENV: 'prod' });
    if (process.platform !== 'win32') {
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    }
    expect(fs.readFileSync(file, 'utf8')).toContain('APP_ENV=prod');
  });
});

describe('runWizard', () => {
  it('后两项留空自动生成，域名取输入值', async () => {
    const answers = ['fw.example.com', '', ''];
    const result = await runWizard({ ask: async () => answers.shift() ?? '' });
    expect(result.entries.APP_DOMAIN).toBe('fw.example.com');
    expect(result.entries.POSTGRES_PASSWORD.length).toBeGreaterThan(20);
    expect(result.entries.REDIS_PASSWORD.length).toBeGreaterThan(20);
    expect(result.generated.sort()).toEqual(['JWT_SECRET', 'POSTGRES_PASSWORD', 'REDIS_PASSWORD']);
    expect(result.entries.APP_REPLICAS).toBe('1');
  });

  it('用户填写的密码原样使用，不计入自动生成', async () => {
    const answers = ['fw.example.com', 'pgpass', 'redispass'];
    const result = await runWizard({ ask: async () => answers.shift() ?? '' });
    expect(result.entries.POSTGRES_PASSWORD).toBe('pgpass');
    expect(result.entries.REDIS_PASSWORD).toBe('redispass');
    expect(result.generated).toEqual(['JWT_SECRET']);
  });

  it('域名留空时回退到已有值，再回退到 example.com', async () => {
    const withExisting = await runWizard({ ask: async () => '', existing: { APP_DOMAIN: 'old.example.com' } });
    expect(withExisting.entries.APP_DOMAIN).toBe('old.example.com');
    const fresh = await runWizard({ ask: async () => '' });
    expect(fresh.entries.APP_DOMAIN).toBe('example.com');
  });

  it('已有 JWT_SECRET 必须保留（二次部署不能把已签发令牌全废掉）', async () => {
    const result = await runWizard({ ask: async () => '', existing: { JWT_SECRET: 'keep-me' } });
    expect(result.entries.JWT_SECRET).toBe('keep-me');
    expect(result.generated).not.toContain('JWT_SECRET');
  });
});

describe('fillNonInteractive', () => {
  it('缺什么补什么，已有值一律保留', () => {
    const result = fillNonInteractive({ APP_DOMAIN: 'a.com', JWT_SECRET: 'keep' }, 'fw-app:test');
    expect(result.entries.JWT_SECRET).toBe('keep');
    expect(result.entries.APP_IMAGE).toBe('fw-app:test');
    expect(result.generated.sort()).toEqual(['POSTGRES_PASSWORD', 'REDIS_PASSWORD']);
  });

  it('已完整时不做任何生成', () => {
    const result = fillNonInteractive({
      APP_DOMAIN: 'a.com',
      POSTGRES_PASSWORD: 'p',
      REDIS_PASSWORD: 'r',
      JWT_SECRET: 'j',
      APP_IMAGE: 'img',
      APP_REPLICAS: '2',
      WORKER_REPLICAS: '1',
    });
    expect(result.generated).toEqual([]);
  });
});

describe('generateSecret', () => {
  it('长度足够且两次不重复', () => {
    const first = generateSecret();
    expect(first.length).toBeGreaterThanOrEqual(40);
    expect(first).not.toBe(generateSecret());
  });
});
