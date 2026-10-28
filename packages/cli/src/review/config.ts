/*
 * @file AI 审查配置（PRD-017 FR-17-23）
 * @description 只从环境变量与命令行读取，**不写项目文件**：密钥属于本机开发者，不该进版本库，
 *   也不该被 `fw deploy` 带到服务器。缺配置时直接报错并给出可用变量名，绝不静默跳过审查。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/review
 * @since v0.8.0
 */

/** 环境变量名（错误信息与文档共用，避免两处漂移） */
export const AI_ENV = {
  /** OpenAI 兼容接口根地址，如 https://api.deepseek.com/v1 */
  baseUrl: 'FW_AI_BASE_URL',
  /** 接口密钥（也接受 OPENAI_API_KEY 作为回退） */
  apiKey: 'FW_AI_API_KEY',
  /** 模型名，如 deepseek-chat / gpt-4o-mini */
  model: 'FW_AI_MODEL',
  /** 调用超时（毫秒），推理模型/大 prompt 需要更长 */
  timeoutMs: 'FW_AI_TIMEOUT_MS',
} as const;

/** 默认接口地址（OpenAI 官方；国内供应商请显式覆盖） */
const DEFAULT_BASE_URL = 'https://api.openai.com/v1';

/** 解析后的配置 */
export interface AiConfig {
  /** 接口根地址（已去掉末尾 `/`） */
  baseUrl: string;
  /** 接口密钥（只存在于内存，日志与清单永不写入） */
  apiKey: string;
  /** 模型名 */
  model: string;
  /** 调用超时（毫秒）；来自 FW_AI_TIMEOUT_MS，未设为 undefined */
  timeoutMs?: number;
}

/** 解析入参（命令行优先于环境变量） */
export interface AiConfigInput {
  /** 环境变量（测试可注入） */
  env?: NodeJS.ProcessEnv;
  /** --base-url=<url> */
  baseUrl?: string;
  /** --ai-model=<name> */
  model?: string;
}

/**
 * 解析 AI 审查配置
 * @param input 入参（命令行覆盖环境变量）
 * @returns 配置
 * @throws 缺少密钥 / 模型或地址非法时抛错，文案给出可直接照做的修复方式
 */
export function resolveAiConfig(input: AiConfigInput = {}): AiConfig {
  const env = input.env ?? process.env;

  const apiKey = (env[AI_ENV.apiKey] ?? env.OPENAI_API_KEY ?? '').trim();
  if (apiKey === '') {
    throw new Error(
      `未配置模型密钥：请设置 ${AI_ENV.apiKey}（OpenAI 兼容接口的 key，也可用 OPENAI_API_KEY）。` +
        '密钥只从环境变量读取，不写入项目文件。',
    );
  }

  const model = (input.model ?? env[AI_ENV.model] ?? '').trim();
  if (model === '') {
    throw new Error(`未指定模型：请设置 ${AI_ENV.model} 或传 --ai-model=<模型名>`);
  }

  const rawBase = (input.baseUrl ?? env[AI_ENV.baseUrl] ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '');
  if (!/^https?:\/\/[^\s]+$/i.test(rawBase)) {
    throw new Error(`接口地址不合法：${rawBase}（需以 http:// 或 https:// 开头）`);
  }

  const timeoutRaw = (env[AI_ENV.timeoutMs] ?? '').trim();
  let timeoutMs: number | undefined;
  if (timeoutRaw !== '') {
    const parsed = Number(timeoutRaw);
    if (!Number.isInteger(parsed) || parsed < 1000 || parsed > 600_000) {
      throw new Error(`超时配置不合法：${timeoutRaw}（${AI_ENV.timeoutMs} 需为 1000~600000 的整数毫秒）`);
    }
    timeoutMs = parsed;
  }

  return { baseUrl: rawBase, apiKey, model, ...(timeoutMs === undefined ? {} : { timeoutMs }) };
}

/**
 * 是否已具备审查条件（Studio 用来决定按钮是否可用，不抛错）
 * @param env 环境变量
 */
export function hasAiConfig(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[AI_ENV.apiKey] ?? env.OPENAI_API_KEY ?? '').trim() !== '' && (env[AI_ENV.model] ?? '').trim() !== '';
}
