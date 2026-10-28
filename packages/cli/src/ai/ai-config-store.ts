/*
 * @file AI 路由配置存储（PRD-017 FR-17-25）
 * @description 页面里填写的供应商地址 / 模型 / 密钥存在**用户级**文件：
 *   `~/.fw/studio-ai.json`（目录 0700、文件 0600）。刻意不写项目目录——
 *   项目里的 `.env` 会进版本库，密钥一旦提交就收不回来。
 *   读取只回状态与明文地址/模型，**永不把密钥回传给页面**；优先级：页面配置 > 环境变量 > 默认。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/ai
 * @since v0.8.0
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AI_ENV } from '../review/config.js';
import { readChatCompletion } from '../review/provider.js';

/** 配置文件结构 */
export interface AiConfigFile {
  /** 接口根地址（已去尾斜杠） */
  baseUrl?: string;
  /** 模型名 */
  model?: string;
  /** 密钥（仅本文件持有，不回传、不记日志） */
  apiKey?: string;
  /** 调用超时（毫秒）；推理模型/大 prompt 需要更长 */
  timeoutMs?: number;
  /** 最近保存时间（ISO） */
  updatedAt?: string;
}

/** 读取结果（损坏时给 error，而不是静默当作没配置） */
export interface AiConfigFileState {
  config: AiConfigFile | null;
  error?: string;
}

/** 保存入参 */
export interface AiConfigPatch {
  baseUrl?: string;
  model?: string;
  apiKey?: string;
  /** true = 删除已保存的密钥 */
  clearApiKey?: boolean;
  /** 调用超时（毫秒，1000~600000） */
  timeoutMs?: number;
}

/** 生效状态（给页面看，不含密钥） */
export interface AiRouteStatus {
  /** 密钥与模型是否齐备 */
  configured: boolean;
  /** 生效地址 */
  baseUrl: string;
  /** 生效模型 */
  model: string;
  /** 是否已设置密钥（不回传内容） */
  apiKeySet: boolean;
  /** 生效超时（毫秒） */
  timeoutMs: number;
  /** 配置来源 */
  source: 'file' | 'env' | 'none';
  /** 配置文件路径（便于用户自己检查） */
  file: string;
  /** 配置文件损坏时的说明 */
  error?: string;
}

/** 默认配置文件路径（可用 FW_STUDIO_AI_FILE 覆盖，测试用） */
export function aiConfigFilePath(env: NodeJS.ProcessEnv = process.env): string {
  const override = (env.FW_STUDIO_AI_FILE ?? '').trim();
  if (override !== '') return path.resolve(override);
  return path.join(os.homedir(), '.fw', 'studio-ai.json');
}

/**
 * 读取配置文件
 * @param file 路径（默认用户级）
 * @returns 配置或错误；文件不存在返回 { config: null }
 */
export function readAiConfigFile(file: string = aiConfigFilePath()): AiConfigFileState {
  if (!fs.existsSync(file)) return { config: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as AiConfigFile;
    if (typeof parsed !== 'object' || parsed === null) return { config: null, error: '配置文件不是对象' };
    return { config: parsed };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return { config: null, error: `配置文件无法解析：${detail}（可删除 ${file} 后重填）` };
  }
}

/**
 * 校验并归一化地址
 * @param raw 原始地址
 */
function normalizeBaseUrl(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(trimmed)) {
    throw new Error(`接口地址不合法：${raw}（需以 http:// 或 https:// 开头）`);
  }
  return trimmed;
}

/**
 * 保存配置（合并已有值；未提供的键保留）
 * @param patch 变更
 * @param file 路径（默认用户级）
 * @returns 保存后的配置（含密钥，调用方不要回传）
 */
export function saveAiConfig(patch: AiConfigPatch, file: string = aiConfigFilePath()): AiConfigFile {
  const current = readAiConfigFile(file);
  if (current.error) throw new Error(current.error);
  const next: AiConfigFile = { ...(current.config ?? {}) };

  if (patch.baseUrl !== undefined) next.baseUrl = normalizeBaseUrl(patch.baseUrl);
  if (patch.model !== undefined) {
    const model = patch.model.trim();
    if (model === '') throw new Error('模型名不能为空');
    next.model = model;
  }
  if (patch.timeoutMs !== undefined) {
    if (!Number.isInteger(patch.timeoutMs) || patch.timeoutMs < 1000 || patch.timeoutMs > 600_000) {
      throw new Error('超时需为 1000~600000 的整数毫秒（例如 120000）');
    }
    next.timeoutMs = patch.timeoutMs;
  }
  if (patch.clearApiKey === true) {
    delete next.apiKey;
  } else if (patch.apiKey !== undefined && patch.apiKey.trim() !== '') {
    next.apiKey = patch.apiKey.trim();
  }
  next.updatedAt = new Date().toISOString();

  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  try {
    fs.chmodSync(file, 0o600); // Windows 上只影响只读位，尽力而为
  } catch {
    // 权限设置失败不阻断保存（文件已在用户目录，不随项目提交）
  }
  return next;
}

/**
 * 计算生效配置（页面配置 > 环境变量）
 * @param fileConfig 文件配置
 * @param env 环境变量
 */
export function effectiveAiEnv(
  env: NodeJS.ProcessEnv = process.env,
  fileConfig: AiConfigFile | null = null,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...env };
  if (fileConfig?.baseUrl) merged[AI_ENV.baseUrl] = fileConfig.baseUrl;
  if (fileConfig?.model) merged[AI_ENV.model] = fileConfig.model;
  if (fileConfig?.apiKey) merged[AI_ENV.apiKey] = fileConfig.apiKey;
  if (fileConfig?.timeoutMs) merged[AI_ENV.timeoutMs] = String(fileConfig.timeoutMs);
  return merged;
}

/**
 * 读取生效状态（不含密钥）
 * @param options 文件路径与环境变量
 */
export function aiRouteStatus(options: { file?: string; env?: NodeJS.ProcessEnv } = {}): AiRouteStatus {
  const env = options.env ?? process.env;
  const file = options.file ?? aiConfigFilePath(env);
  const state = readAiConfigFile(file);
  const config = state.config ?? {};

  const baseUrl = config.baseUrl ?? (env[AI_ENV.baseUrl] ?? '').trim();
  const model = config.model ?? (env[AI_ENV.model] ?? '').trim();
  const apiKey = config.apiKey ?? (env[AI_ENV.apiKey] ?? env.OPENAI_API_KEY ?? '').trim();
  const envTimeout = Number((env[AI_ENV.timeoutMs] ?? '').trim());
  const timeoutMs =
    config.timeoutMs ?? (Number.isInteger(envTimeout) && envTimeout >= 1000 ? envTimeout : 120_000);
  const hasFile = Boolean(config.baseUrl || config.model || config.apiKey);
  const hasEnv = Boolean(
    (env[AI_ENV.baseUrl] ?? '').trim() || (env[AI_ENV.model] ?? '').trim() || (env[AI_ENV.apiKey] ?? env.OPENAI_API_KEY ?? '').trim(),
  );

  return {
    configured: apiKey !== '' && model !== '',
    baseUrl,
    model,
    apiKeySet: apiKey !== '',
    timeoutMs,
    source: hasFile ? 'file' : hasEnv ? 'env' : 'none',
    file,
    ...(state.error ? { error: state.error } : {}),
  };
}

/**
 * 列出可用模型（`GET {baseUrl}/models`）
 * @description 只读、不产生推理费用；部分自建网关不实现该接口，此时 ok=false 并提示手填。
 *   返回的 id 去重排序，响应与错误信息都不含密钥。
 * @param options 地址、密钥、超时与 fetch 替身
 */
export async function listAiModels(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; models: string[]; message: string }> {
  if (options.apiKey.trim() === '') return { ok: false, models: [], message: '还没有填写密钥' };
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(options.baseUrl);
  } catch (error) {
    return { ok: false, models: [], message: error instanceof Error ? error.message : String(error) };
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
  try {
    const response = await fetchImpl(`${baseUrl}/models`, {
      headers: { authorization: `Bearer ${options.apiKey}` },
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        models: [],
        message:
          response.status === 401 || response.status === 403
            ? `鉴权失败（HTTP ${response.status}）：检查密钥是否有效`
            : `接口返回 HTTP ${response.status}：检查地址是否指向 OpenAI 兼容接口`,
      };
    }
    const payload = (await response.json().catch(() => null)) as { data?: unknown } | null;
    const ids = Array.isArray(payload?.data)
      ? payload.data
          .map((item) => (item as { id?: unknown }).id)
          .filter((id): id is string => typeof id === 'string' && id.trim() !== '')
      : [];
    const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
    if (models.length === 0) {
      return { ok: false, models, message: '接口未返回模型列表（可能不支持 /models），请手动填写模型名' };
    }
    return { ok: true, models, message: `已获取 ${models.length} 个模型` };
  } catch (error) {
    if (controller.signal.aborted) return { ok: false, models: [], message: `连接超时（${options.timeoutMs ?? 10_000}ms）` };
    return {
      ok: false,
      models: [],
      message: `连接失败：${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 连接诊断：先查模型列表，再发一条最小对话
 * @description 单独「测试连接」只打 `/models` 无法区分「路径不存在」与「模型排队」。
 *   这里补一条 `max_tokens: 1` 的真实对话请求：404 说明供应商不支持该路径，
 *   401 是密钥问题，超时才是网络或供应商排队——三类问题给三种结论。
 *   请求会消耗极少量 token，但只在用户点击诊断时发生。
 * @param options 地址、密钥、模型、超时与 fetch 替身
 */
export async function diagnoseAi(options: {
  baseUrl: string;
  apiKey: string;
  model: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{
  ok: boolean;
  chatUrl: string;
  steps: { name: 'models' | 'chat'; ok: boolean; message: string; status?: number; elapsedMs: number }[];
  message: string;
}> {
  let baseUrl: string;
  try {
    baseUrl = normalizeBaseUrl(options.baseUrl);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, chatUrl: '', steps: [], message };
  }
  const chatUrl = `${baseUrl}/chat/completions`;
  const timeoutMs = options.timeoutMs ?? 30_000;
  const steps: { name: 'models' | 'chat'; ok: boolean; message: string; status?: number; elapsedMs: number }[] = [];

  if (options.apiKey.trim() === '') {
    return { ok: false, chatUrl, steps, message: '还没有填写密钥' };
  }
  if (options.model.trim() === '') {
    return { ok: false, chatUrl, steps, message: '还没有填写模型名' };
  }

  // ① 模型列表
  const startedModels = Date.now();
  const models = await listAiModels({ baseUrl, apiKey: options.apiKey, fetchImpl: options.fetchImpl, timeoutMs });
  steps.push({
    name: 'models',
    ok: models.ok,
    message: models.ok ? `可见 ${models.models.length} 个模型` : models.message,
    elapsedMs: Date.now() - startedModels,
  });

  // ② 最小对话（max_tokens=1）
  const fetchImpl = options.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const startedChat = Date.now();
  try {
    const response = await fetchImpl(chatUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${options.apiKey}` },
      // 不设 max_tokens：推理模型在 1 token 下会产出空正文，网关会直接 500
      body: JSON.stringify({
        model: options.model,
        messages: [{ role: 'user', content: '只回复 ok' }],
        stream: false,
      }),
      signal: controller.signal,
    });
    const text = await response.text();
    const elapsedMs = Date.now() - startedChat;
    if (!response.ok) {
      const plain = text.replace(/\s+/g, ' ').slice(0, 160);
      const modelFormatIssue = response.status === 400 && /invalid model format|model.*format/i.test(text);
      const reason =
        response.status === 404
          ? '路径不存在：供应商可能不支持 OpenAI 兼容的 /chat/completions'
          : response.status === 401 || response.status === 403
            ? '鉴权失败：检查密钥与该模型的权限'
            : response.status === 429
              ? '限流：稍后重试或降低频率'
              : modelFormatIssue
                ? `模型名格式不匹配：该供应商要求 provider/model（如 deepseek/deepseek-chat），请从「从地址获取」的列表里选。原始响应：${plain}`
                : `接口返回 HTTP ${response.status}：${plain}`;
      steps.push({ name: 'chat', ok: false, message: reason, status: response.status, elapsedMs });
    } else {
      // 200 也可能是空正文（推理模型只回 reasoning）——不能只看状态码
      const payload = (() => {
        try {
          return JSON.parse(text) as unknown;
        } catch {
          return null;
        }
      })();
      const completion = payload === null ? null : readChatCompletion(payload);
      if (completion !== null && completion.content === null) {
        const shape = completion.rootKeys.length > 0 ? `（顶层字段：${completion.rootKeys.join('、')}）` : '';
        steps.push({
          name: 'chat',
          ok: false,
          message: `接口返回 200 但没有正文${shape}：该模型可能只返回 reasoning，换非推理模型或调整思考参数`,
          status: response.status,
          elapsedMs,
        });
      } else {
        steps.push({ name: 'chat', ok: true, message: `对话接口可用（${elapsedMs}ms）`, status: response.status, elapsedMs });
      }
    }
  } catch (error) {
    const elapsedMs = Date.now() - startedChat;
    steps.push({
      name: 'chat',
      ok: false,
      message: controller.signal.aborted
        ? `超时 ${timeoutMs}ms：地址可达但响应过慢，或需要代理`
        : `连接失败：${error instanceof Error ? error.message : String(error)}`,
      elapsedMs,
    });
  } finally {
    clearTimeout(timer);
  }

  const modelsStep = steps.find((step) => step.name === 'models');
  const chatStep = steps.find((step) => step.name === 'chat');
  if (!modelsStep || !chatStep) {
    return { ok: false, chatUrl, steps, message: '诊断未完成：缺少步骤结果' };
  }
  const ok = modelsStep.ok && chatStep.ok;
  const message = ok
    ? `链路可用：模型列表与对话接口均连通（${chatUrl}）`
    : chatStep.ok
      ? `对话接口可用，但模型列表失败：${modelsStep.message}`
      : `对话接口不可用：${chatStep.message}`;
  return { ok, chatUrl, steps, message };
}

/**
 * 测试连接（复用模型列表接口，只读、不产生费用）
 * @param options 地址、密钥、超时与 fetch 替身
 * @returns 结果与可展示说明
 */
export async function testAiConnection(options: {
  baseUrl: string;
  apiKey: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}): Promise<{ ok: boolean; message: string; models?: number }> {
  const result = await listAiModels(options);
  if (!result.ok) return { ok: false, message: result.message };
  return { ok: true, message: `连接成功，可见 ${result.models.length} 个模型`, models: result.models.length };
}
