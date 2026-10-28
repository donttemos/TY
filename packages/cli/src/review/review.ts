/*
 * @file fw review 编排（PRD-017 FR-17-23）
 * @description 一条命令完成「选产物 → 收集 → 拼提示词 → 调模型 → 打印结论」。
 *   审查是**只读**的：不写文件、不改 schema、不落盘报告；密钥只从环境变量来。
 *   `--dry` 只打印将发送的文件与目标地址（不联网），用于先确认「哪些代码会出境」。
 * @author donttemo
 * @created 2026-10-22
 * @module cli/review
 * @since v0.8.0
 */

import { readManifest, MANIFEST_FILE } from '../gen/manifest.js';
import { resolveLayout } from '../gen/render.js';
import type { GenIo } from '../gen/writer.js';
import { collectReviewFiles, type CollectResult } from './collect.js';
import { resolveAiConfig, type AiConfig } from './config.js';
import { buildReviewMessages } from './prompt.js';
import { expandOversizedFiles, planReviewChunks } from './chunk.js';
import { formatFindings, mergeFindings, parseFindings } from './summarize.js';
import { chatCompletion, DEFAULT_TIMEOUT_MS } from './provider.js';

/** 命令选项 */
export interface ReviewOptions {
  /** 位置参数 / --model：只审这些模型（PascalCase 或 kebab） */
  models?: string[];
  /** --app=<目录名> */
  app?: string;
  /** --schema=<路径> */
  schema?: string;
  /** --dry：只列出将发送的文件，不联网 */
  dry?: boolean;
  /** --ai-model=<模型名>（覆盖 FW_AI_MODEL） */
  aiModel?: string;
  /** --base-url=<url>（覆盖 FW_AI_BASE_URL） */
  baseUrl?: string;
  /** --max-files=<n> */
  maxFiles?: number;
  /** --timeout=<ms> */
  timeoutMs?: number;
  /** 单片体积预算（字节）；默认 24KB，测试/大模型可调 */
  chunkBytes?: number;
  /** 每个文件单独一次调用（失败隔离，但会拆散跨文件因果） */
  perFile?: boolean;
  /** 切分策略：auto=按体积装箱 / file=逐文件 / model=按模型分组后组内装箱 */
  split?: 'auto' | 'file' | 'model';
  /** 打印模型原文（默认只打印去重后的汇总） */
  raw?: boolean;
}

/** 可注入依赖（单测不联网） */
export interface ReviewDeps {
  /** 输出 */
  io?: GenIo;
  /** 已解析配置（跳过环境变量解析） */
  config?: AiConfig;
  /** fetch 替身 */
  fetchImpl?: typeof fetch;
  /** 环境变量（测试注入） */
  env?: NodeJS.ProcessEnv;
}

/** 审查结果（供测试断言） */
export interface ReviewOutcome {
  /** 待审文件 */
  collected: CollectResult;
  /** 模型输出；dry-run 时为 null */
  content: string | null;
}

/** 默认 IO */
const consoleIo: GenIo = {
  log: (message) => console.log(message),
  error: (message) => console.error(message),
};

/**
 * 执行一次生成物审查
 * @param options 命令选项
 * @param deps 可注入依赖
 * @returns 收集结果与模型输出
 */
export async function runReview(options: ReviewOptions = {}, deps: ReviewDeps = {}): Promise<ReviewOutcome> {
  const io = deps.io ?? consoleIo;
  const projectRoot = process.cwd();
  const layout = resolveLayout({
    models: [],
    projectRoot,
    app: options.app,
    schema: options.schema,
    author: '',
    created: '',
    since: '',
  });

  // 1. 素材来自清单：没有生成过就没有可审的东西，不猜、不扫全仓库
  const manifest = readManifest(layout.backendRoot);
  if (manifest.entries.length === 0) {
    throw new Error(`无法审查：${MANIFEST_FILE} 里没有生成记录（先执行 fw gen crud <模型>）`);
  }

  const collected = collectReviewFiles({
    backendRoot: layout.backendRoot,
    entries: manifest.entries,
    models: options.models,
    maxFiles: options.maxFiles,
  });

  if (collected.files.length === 0) {
    const reasons = collected.skipped.map((item) => `  - ${item.path}：${item.reason}`).join('\n');
    throw new Error(`没有可审查的文件（清单里有记录，但磁盘上找不到产物）${reasons ? `：\n${reasons}` : ''}`);
  }

  const kb = Math.max(1, Math.round(collected.files.reduce((sum, file) => sum + file.bytes, 0) / 1024));
  io.log(`[review] 模型：${collected.models.join('、')}｜待审 ${collected.files.length} 个文件（${kb}KB）`);
  if (kb > 40) {
    // 实测：推理模型处理 61KB 会超过 180s，先提醒而不是等超时
    io.log('[warn] 本次体积偏大：推理模型可能超过调用超时，建议减少模型/文件，或换非推理模型、调大 --timeout');
  }
  if (collected.skipped.length > 0) {
    io.log(
      `[warn] ${collected.skipped.length} 个文件被跳过：\n${collected.skipped
        .slice(0, 5)
        .map((item) => `  - ${item.path}：${item.reason}`)
        .join('\n')}${collected.skipped.length > 5 ? `\n  … 另有 ${collected.skipped.length - 5} 个` : ''}`,
    );
  }

  const perFile = options.perFile === true || options.split === 'file';
  const groupBy: 'size' | 'model' = options.split === 'model' ? 'model' : 'size';

  // 非法/过小的预算回落到默认值：否则会退化成「每个文件一片」甚至切不动
  const budget =
    Number.isFinite(options.chunkBytes) && (options.chunkBytes ?? 0) >= 4096 ? (options.chunkBytes as number) : 24 * 1024;

  // 2. dry-run 放在配置解析之前：只想看「会发什么」不该被密钥挡住
  if (options.dry) {
    let target = '未配置（dry-run 不联网，无需密钥）';
    try {
      const preview = deps.config ?? resolveAiConfig({ env: deps.env, baseUrl: options.baseUrl, model: options.aiModel });
      target = `${preview.baseUrl}｜${preview.model}`;
    } catch {
      // 没配置也允许 dry-run：它的价值就是先确认文件范围
    }
    io.log(`[review] 目标：${target}`);
    // 预演必须显示真实的分片与切段，否则用户以为一次发 61KB
    const preview = expandOversizedFiles(collected.files, budget);
    for (const line of preview.log) io.log(`[warn] ${line}`);
    const plan = planReviewChunks(preview.files, { budgetBytes: budget, perFile, groupBy });
    io.log(
      perFile
        ? `[review] dry-run：未联网。逐文件发送，共 ${plan.chunks.length} 次调用：`
        : groupBy === 'model'
          ? `[review] dry-run：未联网。按模型分组，共 ${plan.chunks.length} 片（组内预算 ${Math.round(budget / 1024)}KB）：`
          : `[review] dry-run：未联网。将分 ${plan.chunks.length} 片发送（单片预算 ${Math.round(budget / 1024)}KB）：`,
    );
    plan.chunks.forEach((chunk, index) => {
      const size = Math.max(1, Math.round(chunk.bytes / 1024));
      io.log(`  [${index + 1}/${plan.chunks.length}]${chunk.label ? ` ${chunk.label} ·` : ''} ${chunk.files.length} 个文件 ${size}KB`);
      for (const file of chunk.files) {
        const kb = Math.max(1, Math.round(file.bytes / 1024));
        const slice = (file as { slice?: { fromLine: number; toLine: number; totalLines: number } }).slice;
        const range = slice ? `（第 ${slice.fromLine}-${slice.toLine} 行 / 共 ${slice.totalLines} 行）` : '';
        io.log(`    - ${file.path}${range}（${kb}KB）`);
      }
    });
    return { collected, content: null };
  }

  const config = deps.config ?? resolveAiConfig({ env: deps.env, baseUrl: options.baseUrl, model: options.aiModel });
  io.log(`[review] 目标：${config.baseUrl}｜模型：${config.model}`);
  io.log('[warn] 代码将发送到上述地址（本次只读，不写盘；密钥来自环境变量）');

  // 3. 调模型：按体积分片，避免一次塞 60KB 把推理模型拖过超时
  const effectiveTimeoutMs = options.timeoutMs ?? config.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  // 先把超大单文件按行切段，否则它会独占一片继续超时
  const expandedResult = expandOversizedFiles(collected.files, budget);
  for (const line of expandedResult.log) io.log(`[warn] ${line}`);
  const expanded = expandedResult.files;
  const plan = planReviewChunks(expanded, { budgetBytes: budget, perFile, groupBy });
  for (const warning of plan.warnings) io.log(`[warn] ${warning}`);
  if (perFile) {
    io.log(`[review] 逐文件发送：共 ${plan.chunks.length} 次调用（每次独立超时 ${effectiveTimeoutMs}ms）`);
  } else if (plan.chunks.length > 1) {
    const mode = groupBy === 'model' ? '按模型分组' : `单片预算 ${Math.round(budget / 1024)}KB`;
    io.log(`[review] 分 ${plan.chunks.length} 片执行（${mode}，每片独立超时 ${effectiveTimeoutMs}ms）`);
  }

  const parts: string[] = [];
  const failures: string[] = [];
  for (const chunk of plan.chunks) {
    const messages = buildReviewMessages(chunk.files, chunk.index === 0 ? collected.skipped : []);
    if (plan.chunks.length > 1) {
      const size = Math.max(1, Math.round(chunk.bytes / 1024));
      const label = chunk.label ? `${chunk.label} · ` : '';
      io.log(`[review] 分片 ${chunk.index + 1}/${plan.chunks.length}：${label}${chunk.files.length} 个文件 ${size}KB${chunk.oversized ? '（单文件超预算）' : ''}…`);
    } else {
      io.log(`[review] 正在调用模型（超时 ${effectiveTimeoutMs}ms）…`);
    }
    try {
      const part = await chatCompletion({
        config,
        messages,
        fetchImpl: deps.fetchImpl,
        timeoutMs: options.timeoutMs ?? config.timeoutMs,
      });
      parts.push(part);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      failures.push(`分片 ${chunk.index + 1}：${detail}`);
      io.log(`[error] 分片 ${chunk.index + 1} 失败：${detail}`);
    }
  }

  if (parts.length === 0) {
    // 全军覆没才算失败；只要有一片产出，就把能拿到的问题交出去
    throw new Error(`审查失败：${failures.join('；')}`);
  }
  if (failures.length > 0) {
    io.log(`[warn] ${failures.length}/${plan.chunks.length} 个分片失败，以下结论只覆盖成功的分片`);
  }

  const content =
    parts.length === 1
      ? parts[0]
      : parts
          .map((part, index) => {
            const label = plan.chunks[index]?.label;
            return `## 分片 ${index + 1}/${plan.chunks.length}${label ? ` · ${label}` : ''}\n\n${part}`;
          })
          .join('\n\n');

  // 4. 汇总：跨片/跨次重复的同一问题只留一条，严重级取更高
  const merged = mergeFindings(parts.map((part) => parseFindings(part)));
  if (merged.findings.length > 0) {
    io.log('\n[review] 审查结果：\n');
    io.log(formatFindings(merged));
    if (options.raw === true) {
      io.log('\n[review] 模型原文：\n');
      io.log(content);
    }
  } else {
    // 解析不出条目就把原文交出去，不能因为格式不标准就吞掉结果
    io.log('\n[review] 审查结果（未识别出结构化条目，以下为原文）：\n');
    io.log(content);
  }
  return { collected, content };
}
