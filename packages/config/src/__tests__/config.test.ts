/*
 * @file @fw/config 单元测试
 * @description 覆盖 loader 多环境合并、ConfigService 类型安全取值、ConfigValidationError 错误信息翻译（TC-CORE-001/002）
 * @author donttemo
 * @created 2026-10-12
 * @modified 2026-10-13 donttemo 补 M3 鉴权配置键用例；allowRegister 默认断言改 false
 * @since v0.1.0
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadEnv, ConfigService, ConfigValidationError } from '../index.js';

/** 在临时目录创建指定 .env 文件并切换到该目录 */
function withCwd(files: Record<string, string>, fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-config-'));
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  const prevCwd = process.cwd();
  // 同步 loadEnv 的进程环境变量引用：在测试期间覆盖 process.env 中可能被 .env 干扰的键
  const envBackup = { ...process.env };
  process.chdir(dir);
  try {
    fn();
  } finally {
    process.chdir(prevCwd);
    for (const k of Object.keys(process.env)) delete process.env[k];
    Object.assign(process.env, envBackup);
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

describe('@fw/config · loadEnv', () => {
  beforeEach(() => {
    // 清掉父测试可能残留的 APP_ENV
    delete process.env.APP_ENV;
  });

  afterEach(() => {
    delete process.env.APP_ENV;
  });

  it('缺少 APP_ENV 必填项时启动失败并打印人话', () => {
    withCwd({}, () => {
      try {
        loadEnv();
        expect.fail('应抛出');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        const err = e as ConfigValidationError;
        expect(err.message).toContain('APP_ENV');
        expect(err.message).toContain('缺少必填项');
      }
    });
  });

  it('CACHE_DRIVER 取值非法时启动失败并提示可选值', () => {
    withCwd({ '.env': 'APP_ENV=dev\nCACHE_DRIVER=memcached' }, () => {
      try {
        loadEnv();
        expect.fail('应抛出');
      } catch (e) {
        expect(e).toBeInstanceOf(ConfigValidationError);
        const err = e as ConfigValidationError;
        expect(err.issues.find((i) => i.key === 'CACHE_DRIVER')?.message).toContain('memory / redis / redis-cluster');
      }
    });
  });

  it('空字符串 DB_URL 等价于未设置（.env 留空通过校验）', () => {
    withCwd({ '.env': 'APP_ENV=dev\nDB_URL=\nCACHE_URL=' }, () => {
      const env = loadEnv();
      expect(env.DB_URL).toBeUndefined();
      expect(env.CACHE_URL).toBeUndefined();
    });
  });

  it('多环境覆盖：.env 基础 + .env.prod 叠加，prod 取值生效', () => {
    withCwd({ '.env': 'APP_ENV=prod\nLOG_LEVEL=info', '.env.prod': 'LOG_LEVEL=warn\nAPP_PORT=8080' }, () => {
      const env = loadEnv();
      expect(env.APP_ENV).toBe('prod');
      expect(env.LOG_LEVEL).toBe('warn');
      expect(env.APP_PORT).toBe(8080);
    });
  });

  it('overrides 用于测试注入，优先级最高', () => {
    withCwd({ '.env': 'APP_ENV=dev\nAPP_PORT=3000' }, () => {
      const env = loadEnv({ overrides: { APP_PORT: '9999' } });
      expect(env.APP_PORT).toBe(9999);
    });
  });
});

describe('@fw/config · ConfigService 类型安全取值', () => {
  it('get 路径与值类型正确推导', () => {
    withCwd({ '.env': 'APP_ENV=prod\nLOG_LEVEL=debug' }, () => {
      const env = loadEnv();
      const config = new ConfigService(env);
      // 类型断言：编译期已锁定；运行时值正确
      expect(config.get('app.env')).toBe('prod');
      expect(config.get('app.port')).toBe(3000);
      expect(config.get('log.level')).toBe('debug');
      expect(config.get('db.driver')).toBe('sqlite');
      expect(config.get('cache.driver')).toBe('memory');
      expect(config.get('auth.strategy')).toBe('jwt');
      expect(config.get('mq.driver')).toBe('memory');
      expect(config.get('shutdown.timeoutSeconds')).toBe(10);
    });
  });

  it('缺失 URL 字段返回 undefined', () => {
    withCwd({ '.env': 'APP_ENV=dev' }, () => {
      const config = new ConfigService(loadEnv());
      expect(config.get('db.url')).toBeUndefined();
      expect(config.get('cache.url')).toBeUndefined();
    });
  });
});

describe('@fw/config · M3 鉴权配置键', () => {
  it('未配置时取安全默认值（密钥类无默认，TTL/阈值有默认）', () => {
    withCwd({ '.env': 'APP_ENV=dev' }, () => {
      const config = new ConfigService(loadEnv());
      expect(config.get('auth.strategy')).toBe('jwt');
      expect(config.get('auth.accessTtl')).toBe('2h');
      expect(config.get('auth.refreshTtl')).toBe('7d');
      expect(config.get('auth.maxFailed')).toBe(5);
      expect(config.get('auth.lockMinutes')).toBe(15);
      expect(config.get('auth.passwordPolicy')).toBe('medium');
      // 注册默认关闭：框架「默认安全」，开放注册须显式 AUTH_ALLOW_REGISTER=true
      expect(config.get('auth.allowRegister')).toBe(false);
      // 密钥无默认值：缺失即 undefined，由 @fw/auth 在模块初始化时拒绝启动
      expect(config.raw.JWT_SECRET).toBeUndefined();
      expect(config.raw.JWT_SECRET_PREV).toBeUndefined();
      expect(config.raw.AUTH_API_KEYS).toBe('');
    });
  });

  it('AUTH_ALLOW_REGISTER 显式 false 不会被当作真值（拒绝 z.coerce.boolean 陷阱）', () => {
    withCwd({ '.env': 'APP_ENV=dev\nAUTH_ALLOW_REGISTER=false' }, () => {
      expect(loadEnv().AUTH_ALLOW_REGISTER).toBe(false);
    });
    withCwd({ '.env': 'APP_ENV=dev\nAUTH_ALLOW_REGISTER=0' }, () => {
      expect(loadEnv().AUTH_ALLOW_REGISTER).toBe(false);
    });
  });

  it('AUTH_PASSWORD_POLICY 取值非法时启动失败并提示可选值', () => {
    withCwd({ '.env': 'APP_ENV=dev\nAUTH_PASSWORD_POLICY=insane' }, () => {
      try {
        loadEnv();
        expect.fail('应抛出');
      } catch (e) {
        const err = e as ConfigValidationError;
        expect(err.issues.find((i) => i.key === 'AUTH_PASSWORD_POLICY')?.message).toContain('low / medium / high');
      }
    });
  });
});
