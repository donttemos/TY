/*
 * @file OpenAI 兼容模型调用（PRD-017 FR-17-23）
 * @description 只依赖 `/chat/completions`，不引 SDK：DeepSeek、通义、自建网关、Ollama 都能直接换 baseURL。
 *   错误一律转成「能照做的中文提示」——401 指出 key、超时给出毫秒数与地址、非 JSON 给出响应片段，
 *   绝不把整段响应或 Authorization 头打进日志。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/review
 * @since v0.8.0
 */

import type { AiConfig } from './config.js';
import type { ChatMessage } from './prompt.js';

/** 调用选项 */
export interface ChatOptions {
  /** 已解析配置 */
  config: AiConfig;
  /** 消息 */
  messages: ChatMessage[];
  /** 注入 fetch（测试替身） */
  fetchImpl?: typeof fetch;
  /** 超时毫秒数（默认 60s：一次代码审查通常 10~40s） */
  timeoutMs?: number;
  /** 输出上限（部分供应商必填） */
  maxTokens?: number;
  /** 响应格式：结构化输出必须用 json_object（默认文本） */
  responseFormat?: 'json_object';
  /** 采样温度（默认 0.1；建模场景可给 0.2） */
  temperature?: number;
}


/** 解析结果（兼容标准 OpenAI 顶层与 `{ success, data }` 包装） */
export interface CompletionPayload {
  /** 正文内容；缺失为 null */
  content: string | null;
  /** 是否走了 data 包装 */
  enveloped: boolean;
  /** 顶层字段名（报错时用于定位「这是哪家的响应」） */
  rootKeys: string[];
}

/**
 * 从响应 JSON 里取正文
 * @description 部分网关（如 Cline）返回 `{ success, data: { choices } }`，
 *   只认顶层 `choices` 会把 200 误判成「没有返回内容」。
 * @param payload 已解析的响应
 */
export function readChatCompletion(payload: unknown): CompletionPayload {
  const root = (payload ?? {}) as Record<string, unknown>;
  const rootKeys = Object.keys(root);
  const inner =
    root.data !== null && typeof root.data === 'object' && !Array.isArray(root.data)
      ? (root.data as Record<string, unknown>)
      : root;
  const choices = inner.choices as { message?: { content?: unknown } }[] | undefined;
  const raw = Array.isArray(choices) ? choices[0]?.message?.content : undefined;
  return {
    content: typeof raw === 'string' && raw.trim() !== '' ? raw.trim() : null,
    enveloped: inner !== root,
    rootKeys,
  };
}

/** 默认超时 */
export const DEFAULT_TIMEOUT_MS = 120_000;

/**
 * 对话补全的完整地址
 * @param baseUrl 接口根地址（已无尾斜杠）
 */
export function chatEndpoint(baseUrl: string): string {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/** 响应片段上限（错误信息里只带一小段，避免把整页 HTML 打出来） */
const SNIPPET_LIMIT = 300;

/**
 * 取一小段响应正文用于报错
 * @param text 响应正文
 */
function snippet(text: string): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length > SNIPPET_LIMIT ? `${clean.slice(0, SNIPPET_LIMIT)}…` : clean;
}

/**
 * 调用一次聊天补全，返回纯文本结果
 * @param options 调用选项
 * @returns 模型输出（已 trim；空输出视为错误）
 */
export async function chatCompletion(options: ChatOptions): Promise<string> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? options.config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let response: Response;
    try {
      response = await fetchImpl(chatEndpoint(options.config.baseUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.config.apiKey}`,
        },
        body: JSON.stringify({
          model: options.config.model,
          messages: options.messages,
          temperature: options.temperature ?? 0.1,
          stream: false,
          ...(options.responseFormat === 'json_object' ? { response_format: { type: 'json_object' } } : {}),
          ...(options.maxTokens === undefined ? {} : { max_tokens: options.maxTokens }),
        }),
        signal: controller.signal,
      });
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`模型调用超时（${timeoutMs}ms）：POST ${chatEndpoint(options.config.baseUrl)}（服务可能排队或网络不可达）`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`调用模型失败：${detail}（POST ${chatEndpoint(options.config.baseUrl)}；检查地址是否可达、是否需要代理）`);
    }

    const text = await response.text();
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) {
        throw new Error(`模型接口拒绝鉴权（HTTP ${response.status}）：检查 FW_AI_API_KEY 是否有效、是否有该模型权限`);
      }
      const formatHint =
        response.status === 400 && /invalid model format|model.*format/i.test(text)
          ? '；该供应商要求模型名为 provider/model（如 deepseek/deepseek-chat），可从 Studio 的「AI 路由」里点「从地址获取」选'
          : '';
      throw new Error(
        `模型接口返回 HTTP ${response.status}（POST ${chatEndpoint(options.config.baseUrl)}）：${snippet(text)}${formatHint}`,
      );
    }

    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new Error(`模型接口返回的不是 JSON（检查 baseURL 是否指向 OpenAI 兼容接口）：${snippet(text)}`);
    }

    const completion = readChatCompletion(payload);
    if (completion.content === null) {
      const shape = completion.rootKeys.length > 0 ? `（响应顶层字段：${completion.rootKeys.join('、')}）` : '';
      throw new Error(
        `模型没有返回正文内容${shape}：可能是推理模型只返回了 reasoning、内容被过滤或额度不足`,
      );
    }
    return completion.content;
  } finally {
    clearTimeout(timer);
  }
}
