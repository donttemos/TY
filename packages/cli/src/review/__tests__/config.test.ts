/*
 * @file AI 审查配置解析单测（PRD-017 FR-17-23）
 * @description 锁死「缺什么就报什么」：没有 key / model 必须失败并指名环境变量，
 *   默认地址、末尾斜杠、命令行覆盖都要可预期；密钥永不进入错误文案。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { AI_ENV, hasAiConfig, resolveAiConfig } from '../config.js';

describe('resolveAiConfig', () => {
  it('缺少密钥时报错并指名 FW_AI_API_KEY', () => {
    expect(() => resolveAiConfig({ env: { [AI_ENV.model]: 'deepseek-chat' } })).toThrow(/FW_AI_API_KEY/);
  });

  it('接受 OPENAI_API_KEY 作为回退', () => {
    const config = resolveAiConfig({ env: { OPENAI_API_KEY: 'sk-x', [AI_ENV.model]: 'gpt-4o-mini' } });
    expect(config.apiKey).toBe('sk-x');
    expect(config.baseUrl).toBe('https://api.openai.com/v1');
  });

  it('缺少模型时报错并给出两种设置方式', () => {
    expect(() => resolveAiConfig({ env: { [AI_ENV.apiKey]: 'sk-x' } })).toThrow(/FW_AI_MODEL.*--ai-model/);
  });

  it('去掉 baseURL 末尾斜杠，命令行覆盖环境变量', () => {
    const config = resolveAiConfig({
      env: { [AI_ENV.apiKey]: 'sk-x', [AI_ENV.model]: 'env-model', [AI_ENV.baseUrl]: 'https://env.local/v1/' },
      baseUrl: 'https://cli.local/v1/',
      model: 'cli-model',
    });
    expect(config).toEqual({ baseUrl: 'https://cli.local/v1', apiKey: 'sk-x', model: 'cli-model' });
  });

  it('FW_AI_TIMEOUT_MS 合法时生效，非法时拒绝', () => {
    const ok = resolveAiConfig({
      env: { [AI_ENV.apiKey]: 'k', [AI_ENV.model]: 'm', [AI_ENV.timeoutMs]: '180000' },
    });
    expect(ok.timeoutMs).toBe(180000);
    expect(() =>
      resolveAiConfig({ env: { [AI_ENV.apiKey]: 'k', [AI_ENV.model]: 'm', [AI_ENV.timeoutMs]: '99' } }),
    ).toThrow(/超时配置不合法/);
  });

  it('地址不是 http(s) 时拒绝', () => {
    expect(() =>
      resolveAiConfig({ env: { [AI_ENV.apiKey]: 'sk-x', [AI_ENV.model]: 'm', [AI_ENV.baseUrl]: 'ftp://ai.local' } }),
    ).toThrow(/接口地址不合法/);
  });

  it('错误信息里不出现密钥内容', () => {
    try {
      resolveAiConfig({
        env: { [AI_ENV.apiKey]: 'sk-secret', [AI_ENV.model]: 'm', [AI_ENV.baseUrl]: 'ftp://ai.local' },
      });
      throw new Error('应当抛错');
    } catch (error) {
      expect(String(error)).not.toContain('sk-secret');
    }
  });
});

describe('hasAiConfig', () => {
  it('密钥与模型都齐才算可用', () => {
    expect(hasAiConfig({ [AI_ENV.apiKey]: 'sk-x' })).toBe(false);
    expect(hasAiConfig({ [AI_ENV.model]: 'm' })).toBe(false);
    expect(hasAiConfig({ [AI_ENV.apiKey]: 'sk-x', [AI_ENV.model]: 'm' })).toBe(true);
  });
});
