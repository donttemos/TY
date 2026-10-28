/*
 * @file OpenAI 兼容调用单测（PRD-017 FR-17-23）
 * @description 不联网：用 fetch 替身锁死请求形状、成功解析与四类失败（401 / 非 JSON / 空内容 / 超时）。
 *   这些分支决定用户看到的是「能照做的提示」还是「一串英文栈」。
 * @author donttemo
 * @created 2026-10-22
 * @module cli
 */

import { describe, expect, it } from 'vitest';
import { chatCompletion } from '../provider.js';

const config = { baseUrl: 'https://ai.local/v1', apiKey: 'sk-test', model: 'review-model' };
const messages = [{ role: 'system' as const, content: 'sys' }, { role: 'user' as const, content: 'code' }];

/** 构造 JSON 响应替身 */
const jsonResponse = (payload: unknown, status = 200): Response =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

describe('chatCompletion', () => {
  it('请求形状正确：路径、鉴权头、模型与消息', async () => {
    let captured: { url: string; init?: RequestInit } | null = null;
    const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(url), init };
      return jsonResponse({ choices: [{ message: { content: '  [P0] a.ts:1 — 问题 → 建议  ' } }] });
    }) as typeof fetch;

    const content = await chatCompletion({ config, messages, fetchImpl });
    expect(content).toBe('[P0] a.ts:1 — 问题 → 建议');
    expect(captured!.url).toBe('https://ai.local/v1/chat/completions');
    expect((captured!.init?.headers as Record<string, string>).authorization).toBe('Bearer sk-test');
    const body = JSON.parse(String(captured!.init?.body)) as { model: string; messages: unknown[] };
    expect(body.model).toBe('review-model');
    expect(body.messages).toHaveLength(2);
  });

  it('兼容 { success, data } 包装（Cline 等网关）', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ success: true, data: { choices: [{ message: { content: ' 可用 ' } }] } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl })).resolves.toBe('可用');
  });

  it('200 但只有 reasoning 时给出可定位报错', async () => {
    const fetchImpl = (async () =>
      new Response(
        JSON.stringify({ success: true, data: { choices: [{ message: { content: '', reasoning: '思考' } }] } }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl })).rejects.toThrow(/reasoning/);
  });

  it('401 时提示检查 FW_AI_API_KEY，且不回显密钥', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"invalid key sk-test"}', { status: 401 })) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl })).rejects.toThrow(/FW_AI_API_KEY/);
    try {
      await chatCompletion({ config, messages, fetchImpl });
    } catch (error) {
      expect(String(error)).not.toContain('sk-test');
    }
  });

  it('非 JSON 响应提示检查 baseURL', async () => {
    const fetchImpl = (async () => new Response('<html>not api</html>', { status: 200 })) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl })).rejects.toThrow(/baseURL/);
  });

  it('400 模型名格式错误时给出 provider/model 提示', async () => {
    const fetchImpl = (async () =>
      new Response('{"error":"invalid model format. Expected format: modelType/model"}', { status: 400 })) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl })).rejects.toThrow(/provider\/model/);
  });

  it('空 choices 视为错误，不返回空报告', async () => {
    const fetchImpl = (async () => jsonResponse({ choices: [] })) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl })).rejects.toThrow(/没有返回正文内容/);
  });

  it('超时给出毫秒数与地址', async () => {
    const fetchImpl = ((_url: string, init: RequestInit) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    await expect(chatCompletion({ config, messages, fetchImpl, timeoutMs: 5 })).rejects.toThrow(
      /超时（5ms）：POST https://////ai//.local///v1///chat///completions/,
    );
  });
});
