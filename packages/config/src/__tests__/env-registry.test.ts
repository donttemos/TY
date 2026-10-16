/*
 * @file env-schema 键注册表完整性测试
 * @description M9/PRD-009 防键集漂移护栏：新增配置键未登记 ENV_KEY_PATHS / ENV_HOT_KEYS 时本文件单测即失败。
 *   ENV_KEY_PATHS 必须覆盖 envSchema.shape 全部键；ENV_HOT_KEYS 的每条映射必须与 ENV_KEY_PATHS 一致。
 * @author donttemo
 * @created 2026-10-15
 * @module config
 */
import { describe, expect, it } from 'vitest';
import { ENV_HOT_KEYS, ENV_KEY_PATHS, envSchema } from '../env-schema.js';

describe('ENV_KEY_PATHS（配置中心键注册表）完整性', () => {
  it('覆盖 envSchema 的全部键：新增配置键必须同步登记点路径映射', () => {
    const schemaKeys = Object.keys(envSchema.shape).sort();
    const registryKeys = Object.keys(ENV_KEY_PATHS).sort();
    expect(registryKeys).toEqual(schemaKeys);
  });

  it('点路径唯一（不存在两个 Env 键映射到同一路径）', () => {
    const paths = Object.values(ENV_KEY_PATHS);
    expect(new Set(paths).size).toBe(paths.length);
  });
});

describe('ENV_HOT_KEYS（热更新白名单）一致性', () => {
  it('每条白名单映射的 Env 键必须存在，且其注册点路径必须与白名单键一致', () => {
    for (const [path, envKey] of Object.entries(ENV_HOT_KEYS)) {
      expect(ENV_KEY_PATHS, `白名单键 ${path} 的 Env 键 ${envKey} 未登记 ENV_KEY_PATHS`).toHaveProperty(envKey);
      expect(ENV_KEY_PATHS[envKey as keyof typeof ENV_KEY_PATHS], `白名单键 ${path} 与注册表路径 ${ENV_KEY_PATHS[envKey as keyof typeof ENV_KEY_PATHS]} 不一致`).toBe(path);
    }
  });

  it('白名单是 ENV_KEY_PATHS 的真子集（boot 键一律不可热更）', () => {
    expect(Object.keys(ENV_HOT_KEYS).length).toBeLessThan(Object.keys(ENV_KEY_PATHS).length);
  });

  it('热更白名单范围固定（12 键：PRD-009 FR-03 首版 11 键 + PRD-010 E-16 评审扩范围 web.keepAliveMax）', () => {
    expect(Object.keys(ENV_HOT_KEYS).sort()).toEqual(
      [
        'log.level',
        'log.maxBytes',
        'cache.ttl',
        'cache.nullTtl',
        'cache.ttlJitter',
        'cache.slowMs',
        'cache.lockTtl',
        'mq.rateLimit',
        'mq.concurrency',
        'otel.sampleRatio',
        'tenant.cacheTtl',
        'web.keepAliveMax',
      ].sort(),
    );
  });

  it('boot 键与安全基线键不可进入白名单', () => {
    const hotEnvKeys = new Set(Object.values(ENV_HOT_KEYS));
    for (const bootKey of [
      'APP_PORT',
      'DB_DRIVER',
      'DB_URL',
      'CACHE_DRIVER',
      'CACHE_URL',
      'MQ_DRIVER',
      'MQ_URL',
      'AUTH_STRATEGY',
      'JWT_SECRET',
      'JWT_SECRET_PREV',
      'TENANT_ENABLED',
      'OTEL_ENABLED',
      'CONFIG_CENTER_ENABLED',
      'CONFIG_CENTER_DRIVER',
      'AUTH_MAX_FAILED',
      'AUTH_LOCK_MINUTES',
    ]) {
      expect(hotEnvKeys.has(bootKey as never), `${bootKey} 属 boot 键 / 安全基线，不可热更`).toBe(false);
    }
  });
});
