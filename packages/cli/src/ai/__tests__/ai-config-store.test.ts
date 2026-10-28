/*
 * @file AI 路由配置存储单测（PRD-017 FR-17-25）
 * @description 锁死三件事：密钥只写用户级文件、留空不覆盖、永不回传。
 *   同时验证损坏文件不会被静默当成「未配置」——用户需要知道自己的配置坏了。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  aiRouteStatus,
  diagnoseAi,
  effectiveAiEnv,
  listAiModels,
  readAiConfigFile,
  saveAiConfig,
  testAiConnection,
} from '../ai-config-store.js';

let tmpDir: string;
let file: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-ai-config-'));
  file = path.join(tmpDir, 'nested', 'studio-ai.json');
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('saveAiConfig / readAiConfigFile', () => {
  it('保存后能读回，目录与文件都建好', () => {
    const saved = saveAiConfig({ baseUrl: 'https://ai.local/v1/', model: 'm1', apiKey: 'sk-1' }, file);
    expect(saved.baseUrl).toBe('https://ai.local/v1');
    expect(fs.existsSync(file)).toBe(true);
    expect(readAiConfigFile(file).config).toMatchObject({ model: 'm1', apiKey: 'sk-1' });
  });

  it('密钥留空时保留原值（页面密码框留空不改）', () => {
    saveAiConfig({ baseUrl: 'https://ai.local/v1', model: 'm1', apiKey: 'sk-1' }, file);
    const saved = saveAiConfig({ model: 'm2', apiKey: '   ' }, file);
    expect(saved.apiKey).toBe('sk-1');
    expect(saved.model).toBe('m2');
  });

  it('保存超时并进入生效状态；越界拒绝', () => {
    saveAiConfig({ baseUrl: 'https://ai.local/v1', model: 'm1', timeoutMs: 180000 }, file);
    expect(aiRouteStatus({ file, env: {} }).timeoutMs).toBe(180000);
    expect(aiRouteStatus({ file, env: {} }).configured).toBe(false); // 没密钥仍不算就绪
    expect(() => saveAiConfig({ timeoutMs: 10 }, file)).toThrow(/1000~600000/);
  });

  it('clearApiKey 删除密钥', () => {
    saveAiConfig({ baseUrl: 'https://ai.local/v1', model: 'm1', apiKey: 'sk-1' }, file);
    expect(saveAiConfig({ clearApiKey: true }, file).apiKey).toBeUndefined();
  });

  it('地址非法或模型为空时拒绝，不写文件', () => {
    expect(() => saveAiConfig({ baseUrl: 'ftp://ai.local' }, file)).toThrow(/不合法/);
    expect(() => saveAiConfig({ model: '   ' }, file)).toThrow(/不能为空/);
    expect(fs.existsSync(file)).toBe(false);
  });

  it('文件损坏时给出可操作错误，而不是静默当未配置', () => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, '{broken', 'utf8');
    const state = readAiConfigFile(file);
    expect(state.config).toBeNull();
    expect(state.error).toContain('无法解析');
    expect(() => saveAiConfig({ model: 'm' }, file)).toThrow(/无法解析/);
  });

  it('状态查询不含密钥字段', () => {
    saveAiConfig({ baseUrl: 'https://ai.local/v1', model: 'm1', apiKey: 'sk-secret' }, file);
    const status = aiRouteStatus({ file, env: {} });
    expect(status.apiKeySet).toBe(true);
    expect(JSON.stringify(status)).not.toContain('sk-secret');
  });
});

describe('effectiveAiEnv', () => {
  it('页面配置覆盖环境变量', () => {
    const env = effectiveAiEnv(
      { FW_AI_BASE_URL: 'https://env.local/v1', FW_AI_MODEL: 'env-model', FW_AI_API_KEY: 'env-key' },
      { baseUrl: 'https://file.local/v1', model: 'file-model', apiKey: 'file-key' },
    );
    expect(env.FW_AI_BASE_URL).toBe('https://file.local/v1');
    expect(env.FW_AI_MODEL).toBe('file-model');
    expect(env.FW_AI_API_KEY).toBe('file-key');
  });

  it('没有文件配置时保持环境变量', () => {
    const env = effectiveAiEnv({ FW_AI_MODEL: 'env-model' }, null);
    expect(env.FW_AI_MODEL).toBe('env-model');
  });
});

describe('aiRouteStatus', () => {
  it('来源判定：文件 > 环境变量 > 未配置', () => {
    expect(aiRouteStatus({ file, env: {} }).source).toBe('none');
    expect(aiRouteStatus({ file, env: { FW_AI_API_KEY: 'k', FW_AI_MODEL: 'm' } }).source).toBe('env');
    saveAiConfig({ baseUrl: 'https://ai.local/v1', model: 'm1' }, file);
    const status = aiRouteStatus({ file, env: {} });
    expect(status.source).toBe('file');
    expect(status.configured).toBe(false); // 没密钥还不算就绪
    expect(status.file).toBe(file);
  });
});

describe('testAiConnection', () => {
  it('200 时返回可见模型数', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }] }), { status: 200 })) as unknown as typeof fetch;
    const result = await testAiConnection({ baseUrl: 'https://ai.local/v1', apiKey: 'k', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.models).toBe(2);
  });

  it('401 时提示检查密钥', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const result = await testAiConnection({ baseUrl: 'https://ai.local/v1', apiKey: 'k', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('密钥');
  });

  it('没填密钥时不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await testAiConnection({ baseUrl: 'https://ai.local/v1', apiKey: '  ', fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('地址非法时直接报错', async () => {
    const result = await testAiConnection({ baseUrl: 'ftp://x', apiKey: 'k' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('不合法');
  });

  it('网络错误转成可读说明', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const result = await testAiConnection({ baseUrl: 'https://ai.local/v1', apiKey: 'k', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('连接失败');
  });
});

describe('listAiModels', () => {
  it('返回去重并排序后的模型名', async () => {
    const fetchImpl = (async () =>
      new Response(JSON.stringify({ data: [{ id: 'm2' }, { id: 'm1' }, { id: 'm2' }, { id: '' }, { nope: 1 }] }), {
        status: 200,
      })) as unknown as typeof fetch;
    const result = await listAiModels({ baseUrl: 'https://ai.local/v1', apiKey: 'k', fetchImpl });
    expect(result.ok).toBe(true);
    expect(result.models).toEqual(['m1', 'm2']);
  });

  it('data 为空时提示可能不支持 /models（引导手填）', async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ data: [] }), { status: 200 })) as unknown as typeof fetch;
    const result = await listAiModels({ baseUrl: 'https://ai.local/v1', apiKey: 'k', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('手动填写');
  });

  it('401 时提示检查密钥', async () => {
    const fetchImpl = (async () => new Response('{}', { status: 401 })) as unknown as typeof fetch;
    const result = await listAiModels({ baseUrl: 'https://ai.local/v1', apiKey: 'k', fetchImpl });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('密钥');
  });

  it('没有密钥时不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const result = await listAiModels({ baseUrl: 'https://ai.local/v1', apiKey: ' ', fetchImpl });
    expect(result.ok).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('地址非法时直接报错', async () => {
    const result = await listAiModels({ baseUrl: 'ftp://x', apiKey: 'k' });
    expect(result.ok).toBe(false);
    expect(result.message).toContain('不合法');
  });
});

describe('diagnoseAi', () => {
  /** 同时处理 /models 与 /chat/completions 的替身 */
  const fake = (chat: { status: number; body?: unknown }): typeof fetch =>
    (async (url: string) => {
      if (String(url).endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 });
      }
      return new Response(JSON.stringify(chat.body ?? {}), { status: chat.status });
    }) as unknown as typeof fetch;

  it('两步都通过时给出完整对话地址', async () => {
    const result = await diagnoseAi({
      baseUrl: 'https://ai.local/v1/',
      apiKey: 'k',
      model: 'm1',
      fetchImpl: fake({
        status: 200,
        body: { success: true, data: { choices: [{ message: { content: 'ok' } }] } },
      }),
    });
    expect(result.ok).toBe(true);
    expect(result.chatUrl).toBe('https://ai.local/v1/chat/completions');
    expect(result.steps.map((step) => step.name)).toEqual(['models', 'chat']);
  });

  it('404 明确说「路径不存在」，而不是笼统的连接失败', async () => {
    const result = await diagnoseAi({ baseUrl: 'https://ai.local/v1', apiKey: 'k', model: 'm1', fetchImpl: fake({ status: 404 }) });
    expect(result.ok).toBe(false);
    expect(result.steps.find((step) => step.name === 'chat')?.message).toContain('路径不存在');
  });

  it('401 指向密钥与模型权限', async () => {
    const result = await diagnoseAi({ baseUrl: 'https://ai.local/v1', apiKey: 'k', model: 'm1', fetchImpl: fake({ status: 401 }) });
    expect(result.steps.find((step) => step.name === 'chat')?.message).toContain('鉴权');
  });

  it('对话超时单独标注（不是地址错）', async () => {
    const fetchImpl = ((url: string, init: RequestInit) => {
      if (String(url).endsWith('/models')) {
        return Promise.resolve(new Response(JSON.stringify({ data: [{ id: 'm1' }] }), { status: 200 }));
      }
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      });
    }) as unknown as typeof fetch;
    const result = await diagnoseAi({
      baseUrl: 'https://ai.local/v1',
      apiKey: 'k',
      model: 'm1',
      fetchImpl,
      timeoutMs: 5,
    });
    expect(result.steps.find((step) => step.name === 'chat')?.message).toContain('超时');
  });

  it('200 但只有 reasoning 时判为「没有正文」，不谎报可用', async () => {
    const result = await diagnoseAi({
      baseUrl: 'https://ai.local/v1',
      apiKey: 'k',
      model: 'm1',
      fetchImpl: fake({ status: 200, body: { success: true, data: { choices: [{ message: { content: '', reasoning: '思考中' } }] } } }),
    });
    const chatStep = result.steps.find((step) => step.name === 'chat');
    expect(chatStep?.ok).toBe(false);
    expect(chatStep?.message).toContain('reasoning');
  });

  it('400「invalid model format」直接指出要 provider/model 格式', async () => {
    const result = await diagnoseAi({
      baseUrl: 'https://ai.local/v1',
      apiKey: 'k',
      model: 'deepseek-chat',
      fetchImpl: fake({ status: 400, body: { error: 'invalid model format. Expected format: modelType/model' } }),
    });
    const chatStep = result.steps.find((step) => step.name === 'chat');
    expect(chatStep?.message).toContain('provider/model');
    expect(chatStep?.message).toContain('deepseek/deepseek-chat');
  });

  it('缺模型名或密钥时直接说明，不发请求', async () => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const noKey = await diagnoseAi({ baseUrl: 'https://ai.local/v1', apiKey: '', model: 'm1', fetchImpl });
    expect(noKey.ok).toBe(false);
    expect(noKey.message).toContain('密钥');
    const noModel = await diagnoseAi({ baseUrl: 'https://ai.local/v1', apiKey: 'k', model: '', fetchImpl });
    expect(noModel.message).toContain('模型名');
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
