/*
 * @file Studio 本地服务（TY Studio S1 + S2 写接口 / PRD-017 铁律 5）
 * @description 职责仍是两件：托管页面、按白名单返回/修改项目数据。所有安全约束在 handleRequest 内强制执行：
 *   - 只监听 127.0.0.1；本机令牌按项目持久化（`~/.fw/studio-token.json`），`/api/*` 必须携带（常量时间比较）；
 *   - 校验 Host 与 Origin，防 DNS rebinding 与跨站读写；
 *   - **方法按路由白名单**：只有 `/api/schema/preview` 与 `/api/schema/apply` 接受 POST，
 *     其余一律只读；请求体大小上限 256KB；
 *   - 写 schema 必须走 schema-api（风险分级 + 一次性确认令牌 + 结构自检 + prisma validate + 备份 + 原子写），
 *     服务本身不实现任何规则，也不接受「传路径改任意文件」。
 * @author donttemo
 * @created 2026-10-22
 * @modified 2026-10-22 M17 S4：新增 /api/review（AI 审查生成物）——GET 只回配置状态、
 *   POST 起 CLI 子进程；未配置密钥时 400 ai-not-configured，而不是起一个注定失败的任务。
 * @module cli/studio
 * @since v0.8.0
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Exec } from '../deploy/exec.js';
import {
  aiConfigFilePath,
  aiRouteStatus,
  effectiveAiEnv,
  diagnoseAi,
  listAiModels,
  readAiConfigFile,
  saveAiConfig,
  testAiConnection,
} from '../ai/ai-config-store.js';
import { checkArtifactDrift, readManifest as readGenManifest, type GenManifestEntry } from '../gen/manifest.js';
import { resolveLayout } from '../gen/render.js';
import { buildDesignerContext, summarizeContext } from '../model-designer/context.js';
import { DraftError, runDraftDesign } from '../model-designer/draft.js';
import { clearSavedDraft, draftFilePath, readSavedDraft, saveDraft } from '../model-designer/draft-store.js';
import { draftToEditorModels } from '../model-designer/to-editor.js';
import { applyOperations } from '../model-designer/apply-operations.js';
import { parseModelsJson } from '../model-designer/json-import.js';
import { buildAnnotateMessages, candidateStats, collectAnnotateCandidates, parseAnnotateResult } from './annotate.js';
import { AI_ENV, hasAiConfig, resolveAiConfig } from '../review/config.js';
import { chatCompletion } from '../review/provider.js';
import { inspectProject, type ProjectInspection } from './inspect.js';
import { JobManager } from './jobs.js';
import { resolveStudioToken } from './token-store.js';
import { renderStudioPage } from './page.js';
import {
  applyEdits,
  buildRelationEdits,
  listModels,
  previewEdits,
  ConfirmTokenStore,
  SchemaEditError,
  type ModelView,
  type RelationRequest,
} from './schema-api.js';
import type { ModelEdit } from './schema-doc.js';

/** 启动选项 */
export interface StudioServerOptions {
  /** 被检视的项目根 */
  projectRoot: string;
  /** 端口（0 = 随机空闲端口） */
  port?: number;
  /** 指定 token（默认随机生成，测试可注入） */
  token?: string;
  /** 输出（启动提示） */
  log?: (message: string) => void;
  /** 执行器（透传给 prisma validate；测试注入） */
  exec?: Exec;
  /** CLI 入口（默认本包 dist/index.js；测试可指向替身脚本） */
  cliEntry?: string;
  /** 跳过 prisma validate（仅测试用） */
  skipValidate?: boolean;
  /** 模型调用替身（测试注入；默认全局 fetch） */
  fetchImpl?: typeof fetch;
  /** AI 路由配置文件路径（默认 ~/.fw/studio-ai.json；测试注入临时文件） */
  aiConfigFile?: string;
  /** 强制轮换本地令牌（--new-token） */
  rotateToken?: boolean;
  /** 草案缓存文件（默认 ~/.fw/drafts/<项目哈希>.json；测试注入） */
  draftFile?: string;
  /**
   * 前端产物目录（默认自动探测 `packages/studio-web/dist`）。
   * 找不到时回退到内置只读页——保证 `fw studio` 在未构建前端时仍然可用。
   */
  webDist?: string;
}

/** 服务句柄 */
export interface StudioServerHandle {
  /** 完整访问地址（含 token 查询参数） */
  url: string;
  /** 实际端口 */
  port: number;
  /** 本次启动的 token */
  token: string;
  /** 关闭服务 */
  close: () => Promise<void>;
}

/** 默认端口（固定端口便于反复打开，被占用时上层可改 0） */
export const DEFAULT_STUDIO_PORT = 4310;

/** 允许的 Host 名（防 DNS rebinding） */
const ALLOWED_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** 请求体上限：schema 编辑指令是结构化 JSON，256KB 足够 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * 解析 Host 头的主机名部分
 * @param host Host 头
 */
function hostNameOf(host: string | undefined): string {
  if (!host) return '';
  const matched = host.match(/^(\[[^\]]+\]|[^:]+)(?::\d+)?$/);
  return matched ? matched[1] : host;
}

/**
 * 判断 Origin 是否同源（未带 Origin 的请求放行：直接访问页面时浏览器可能不带）
 * @param origin Origin 头
 * @param port 实际端口
 */
function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (!origin) return true;
  try {
    const url = new URL(origin);
    return ALLOWED_HOSTS.has(url.hostname) && Number(url.port || (url.protocol === 'https:' ? 443 : 80)) === port;
  } catch {
    return false;
  }
}

/** 发送 JSON */
function sendJson(response: http.ServerResponse, status: number, payload: unknown): void {
  const body = JSON.stringify(payload, null, 2);
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

/** 发送 HTML */
function sendHtml(response: http.ServerResponse, html: string): void {
  response.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'",
    'referrer-policy': 'no-referrer',
  });
  response.end(html);
}

/**
 * 读取并解析 JSON 请求体（带大小上限）
 * @param request 请求
 */
async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = chunk as Buffer;
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new SchemaEditError('invalid-edits', `请求体超过 ${MAX_BODY_BYTES} 字节上限`);
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8').trim();
  if (text === '') return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new SchemaEditError('invalid-edits', '请求体不是合法 JSON');
  }
}

/** 从请求体里取出 edits（结构校验） */
function readEdits(payload: unknown): ModelEdit[] {
  const edits = (payload as { edits?: unknown })?.edits;
  if (!Array.isArray(edits)) throw new SchemaEditError('invalid-edits', '缺少 edits 数组');
  for (const edit of edits) {
    const item = edit as Partial<ModelEdit>;
    if (typeof item.model !== 'string' || item.model.trim() === '') {
      throw new SchemaEditError('invalid-edits', 'edits 中每项都必须有 model 名称');
    }
  }
  return edits as ModelEdit[];
}

/**
 * 探测前端产物目录
 * @description 三种布局都试：workspace（packages/cli/../studio-web/dist）、
 *   打包进 CLI（dist/studio-web）、以及从仓库根触发（cwd/packages/studio-web/dist）。
 */
export function resolveStudioWebDist(explicit?: string): string | null {
  if (explicit) return fs.existsSync(path.join(explicit, 'index.html')) ? explicit : null;
  const candidates: string[] = [];
  try {
    // 运行期本文件位于 <cli>/dist/studio/，向上两级即 CLI 包根
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(path.resolve(here, '..', '..', '..', 'studio-web', 'dist'));
    candidates.push(path.resolve(here, '..', 'studio-web'));
  } catch {
    // import.meta.url 在部分打包/测试环境下不是 file: URL，忽略
  }
  candidates.push(path.join(process.cwd(), 'packages', 'studio-web', 'dist'));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'index.html'))) return candidate;
  }
  return null;
}

/** 静态文件的 content-type 映射 */
const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};

/**
 * 读取静态资源（限制在 webDist 内，防目录穿越）
 * @param webDist 产物目录
 * @param urlPath 请求路径
 * @returns 命中返回 { body, contentType }，否则 null
 */
function readStatic(webDist: string, urlPath: string): { body: Buffer; contentType: string } | null {
  const relative = decodeURIComponent(urlPath).replace(/^\/+/, '');
  if (relative.includes('\0')) return null;
  const target = path.resolve(webDist, relative === '' ? 'index.html' : relative);
  const root = path.resolve(webDist);
  // 必须落在产物目录内（前缀校验 + 分隔符，避免 /dist-evil 之类同前缀绕过）
  if (target !== root && !target.startsWith(`${root}${path.sep}`)) return null;
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) return null;
  const contentType = CONTENT_TYPES[path.extname(target).toLowerCase()] ?? 'application/octet-stream';
  return { body: fs.readFileSync(target), contentType };
}

/**
 * 解析 CLI 入口（用于以子进程方式调用 fw 命令）
 * @description 运行期本文件在 `<cli>/dist/studio/`，入口是同级的 `../index.js`。
 */
export function resolveCliEntry(): string {
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(here, '..', 'index.js');
  } catch {
    return path.join(process.cwd(), 'packages', 'cli', 'dist', 'index.js');
  }
}

/** 合法模型名（同时防止参数注入：只允许标识符，绝不放行空格/分号/引号） */
const MODEL_NAME = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

/**
 * 把「生成请求」翻译成固定的参数数组
 * @description 前端只能提交数据，不能提交命令行：参数拼装全部在这里完成。
 * @param payload 请求体
 */
export function buildGenArgs(payload: unknown): { models: string[]; args: string[] } {
  const body = payload as {
    models?: unknown;
    dry?: unknown;
    allowDestructive?: unknown;
    noMigrate?: unknown;
    noSeed?: unknown;
    force?: unknown;
  };
  if (!Array.isArray(body.models) || body.models.length === 0) {
    throw new SchemaEditError('invalid-edits', '缺少 models（要生成的模型名列表）');
  }
  if (body.models.length > 20) {
    throw new SchemaEditError('invalid-edits', '一次最多生成 20 个模型');
  }
  const models = body.models.map((item) => {
    if (typeof item !== 'string' || !MODEL_NAME.test(item)) {
      throw new SchemaEditError('invalid-edits', `模型名不合法：${String(item)}（只允许字母开头、字母数字下划线中划线）`);
    }
    return item;
  });
  const args = ['gen', 'crud', ...models];
  if (body.dry === true) args.push('--dry');
  if (body.noMigrate === true) args.push('--no-migrate');
  if (body.noSeed === true) args.push('--no-seed');
  if (body.allowDestructive === true) args.push('--allow-destructive');
  if (body.force === true) args.push('--force');
  return { models, args };
}

/**
 * 把「审查请求」翻译成固定的参数数组
 * @description 与生成同一条铁律：前端只提交模型名，命令由服务端拼装，不经 shell。
 * @param payload 请求体（models 可省略 = 审查清单里全部模型）
 */
export function buildReviewArgs(payload: unknown): { models: string[]; args: string[] } {
  const body = payload as { models?: unknown; split?: unknown };
  // 切分策略：只接受白名单，非法值静默忽略（CLI 侧还有兜底）
  const split =
    body.split === 'auto' || body.split === 'model' || body.split === 'file' ? body.split : undefined;
  const splitArg = split ? [`--split=${split}`] : [];
  if (body.models === undefined) return { models: [], args: ['review', ...splitArg] };
  if (!Array.isArray(body.models)) {
    throw new SchemaEditError('invalid-edits', 'models 必须是数组（省略则审查全部生成物）');
  }
  if (body.models.length > 20) {
    throw new SchemaEditError('invalid-edits', '一次最多审查 20 个模型');
  }
  const models = body.models.map((item) => {
    if (typeof item !== 'string' || !MODEL_NAME.test(item)) {
      throw new SchemaEditError('invalid-edits', `模型名不合法：${String(item)}（只允许字母开头、字母数字下划线中划线）`);
    }
    return item;
  });
  return { models, args: ['review', ...models, ...splitArg] };
}

/** 常量时间字符串比较 */
function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * 启动 Studio 服务
 * @param options 选项
 */
export async function startStudioServer(options: StudioServerOptions): Promise<StudioServerHandle> {
  // 令牌按项目持久化：重启不再换 token，避免「页面还开着、保存就 401」
  const token = resolveStudioToken({
    projectRoot: options.projectRoot,
    explicit: options.token,
    rotate: options.rotateToken,
  }).token;
  const log = options.log ?? ((message: string) => console.log(message));
  const tokens = new ConfirmTokenStore();
  const webDist = resolveStudioWebDist(options.webDist);
  const cliEntry = options.cliEntry ?? resolveCliEntry();
  const jobs = new JobManager();
  let cached: { at: number; data: ProjectInspection } | null = null;

  /** 草案缓存文件路径 */
  const draftFile = (): string => options.draftFile ?? draftFilePath(options.projectRoot);

  /** 当前生效的 AI 环境：页面保存的配置优先于环境变量 */
  const aiEnv = (): NodeJS.ProcessEnv =>
    effectiveAiEnv(process.env, readAiConfigFile(options.aiConfigFile ?? aiConfigFilePath()).config);

  /** 解析当前项目的 schema 绝对路径 */
  const schemaFileOf = (): string =>
    resolveLayout({ models: [], projectRoot: options.projectRoot, author: '', created: '', since: '' }).schemaFile;

  const server = http.createServer((request, response) => {
    void (async () => {
      // ① Host 校验：只接受本机名，挡住 DNS rebinding
      const hostName = hostNameOf(request.headers.host);
      if (!ALLOWED_HOSTS.has(hostName)) {
        sendJson(response, 403, { error: 'forbidden-host', message: `拒绝非本机 Host：${request.headers.host ?? '(空)'}` });
        return;
      }

      const port = (server.address() as AddressInfo).port;

      // ② Origin 校验：跨站页面读写都被挡
      if (!isAllowedOrigin(request.headers.origin, port)) {
        sendJson(response, 403, { error: 'forbidden-origin', message: `拒绝跨站来源：${request.headers.origin}` });
        return;
      }

      const url = new URL(request.url ?? '/', `http://${request.headers.host ?? '127.0.0.1'}`);
      const method = request.method ?? 'GET';
      const isGet = method === 'GET' || method === 'HEAD';

      // ③ 页面与静态资源不需要 token（token 经 URL 参数带进页面）
      if (isGet && (url.pathname === '/' || url.pathname === '/index.html')) {
        if (webDist) {
          const asset = readStatic(webDist, 'index.html');
          if (asset) {
            response.writeHead(200, {
              'content-type': asset.contentType,
              'cache-control': 'no-store',
              'content-security-policy':
                "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'",
            });
            response.end(asset.body);
            return;
          }
        }
        // 前端未构建：回退内置只读页，fw studio 仍然可用
        sendHtml(response, renderStudioPage());
        return;
      }

      if (isGet && url.pathname.startsWith('/assets/')) {
        const asset = webDist ? readStatic(webDist, url.pathname) : null;
        if (!asset) {
          sendJson(response, 404, { error: 'not-found', message: '静态资源不存在（前端可能未构建：pnpm --filter @fw/studio-web run build）' });
          return;
        }
        response.writeHead(200, { 'content-type': asset.contentType, 'cache-control': 'no-store' });
        response.end(asset.body);
        return;
      }

      if (!url.pathname.startsWith('/api/')) {
        sendJson(response, 404, { error: 'not-found', message: `未知路径：${url.pathname}` });
        return;
      }

      // ④ API 一律要 token
      const headerToken = request.headers['x-studio-token'];
      const provided = (Array.isArray(headerToken) ? headerToken[0] : headerToken) ?? url.searchParams.get('token') ?? '';
      if (!safeEqual(provided, token)) {
        sendJson(response, 401, { error: 'unauthorized', message: '缺少或错误的 token（重新执行 fw studio 获取新地址）' });
        return;
      }

      // ⑤ 路由（方法白名单：只有 schema 的两个接口接受 POST）
      if (url.pathname === '/api/health' && isGet) {
        sendJson(response, 200, { ok: true, version: 2, projectRoot: options.projectRoot });
        return;
      }

      if (url.pathname === '/api/project' && isGet) {
        const now = Date.now();
        if (!cached || now - cached.at > 5000) {
          cached = { at: now, data: await inspectProject(options.projectRoot) };
        }
        sendJson(response, 200, cached.data);
        return;
      }

      if (url.pathname === '/api/schema' && isGet) {
        const file = schemaFileOf();
        if (!fs.existsSync(file)) {
          sendJson(response, 200, { exists: false, file, models: [] as ModelView[] });
          return;
        }
        const text = fs.readFileSync(file, 'utf8');
        sendJson(response, 200, { exists: true, file, models: listModels(text) });
        return;
      }

      if (url.pathname === '/api/schema/preview' && method === 'POST') {
        const file = schemaFileOf();
        if (!fs.existsSync(file)) throw new SchemaEditError('invalid-edits', 'schema 不存在，无法编辑');
        const text = fs.readFileSync(file, 'utf8');
        const edits = readEdits(await readJsonBody(request));
        const preview = previewEdits(text, edits, tokens);
        // 回显 edits：apply 必须使用「预览时那一份」，否则指纹对不上、令牌失效
        sendJson(response, 200, { ok: true, edits, ...preview });
        return;
      }

      if (url.pathname === '/api/gen/drift' && isGet) {
        const layout = resolveLayout({ models: [], projectRoot: options.projectRoot, author: '', created: '', since: '' });
        let entries: GenManifestEntry[] = [];
        try {
          entries = readGenManifest(layout.backendRoot).entries;
        } catch {
          // 清单损坏：按无指纹处理（宁可说不知道）
          entries = [];
        }
        sendJson(response, 200, {
          ok: true,
          tracked: entries.some((entry) => (entry.files ?? []).length > 0),
          // 清单路径以后端应用根为基准（与生成时的 cwd 无关）
          models: checkArtifactDrift(layout.backendRoot, entries),
        });
        return;
      }

      if (url.pathname === '/api/model-draft/saved' && isGet) {
        const state = readSavedDraft(draftFile());
        sendJson(response, 200, { ok: true, saved: state.saved, ...(state.error ? { error: state.error } : {}) });
        return;
      }

      if (url.pathname === '/api/model-draft/saved' && method === 'POST') {
        const body = (await readJsonBody(request)) as { draft?: unknown };
        if (typeof body.draft !== 'object' || body.draft === null || Array.isArray(body.draft)) {
          throw new SchemaEditError('invalid-edits', '缺少 draft（要缓存的草案对象）');
        }
        try {
          const savedAt = saveDraft(body.draft as Record<string, unknown>, draftFile());
          sendJson(response, 200, { ok: true, savedAt });
        } catch (error) {
          throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (url.pathname === '/api/model-draft/saved/clear' && method === 'POST') {
        const cleared = clearSavedDraft(draftFile());
        sendJson(response, 200, { ok: true, cleared });
        return;
      }

      if (url.pathname === '/api/model-draft' && isGet) {
        // 只回上下文摘要（模型名与约定），不回 schema 全文：界面只需展示「读到了什么」
        const context = buildDesignerContext({ projectRoot: options.projectRoot });
        sendJson(response, 200, { ok: true, configured: hasAiConfig(aiEnv()), context: summarizeContext(context) });
        return;
      }

      if (url.pathname === '/api/model-draft/revise' && method === 'POST') {
        const body = (await readJsonBody(request)) as { draft?: unknown; instruction?: unknown };
        if (typeof body.draft !== 'object' || body.draft === null || Array.isArray(body.draft)) {
          throw new SchemaEditError('invalid-edits', '缺少 draft（当前草案）');
        }
        if (typeof body.instruction !== 'string' || body.instruction.trim() === '') {
          throw new SchemaEditError('invalid-edits', '缺少 instruction（要用自然语言改什么）');
        }
        const draft = body.draft as Record<string, unknown>;
        const revision = Number(draft.revision);
        if (!Number.isInteger(revision) || revision < 1) {
          throw new SchemaEditError('invalid-edits', '草案缺少整数 revision，无法做增量修改');
        }
        try {
          const result = await runDraftDesign(
            { requirement: body.instruction, mode: 'revise', baseRevision: revision, draft },
            { projectRoot: options.projectRoot, fetchImpl: options.fetchImpl, env: aiEnv() },
          );
          const operations = Array.isArray(result.draft.operations) ? result.draft.operations : [];
          const applied = applyOperations(draft, operations);
          sendJson(response, 200, {
            ok: true,
            draft: applied.draft,
            operations,
            changes: applied.changes,
            skipped: applied.skipped,
            destructive: applied.destructive,
            attempts: result.attempts,
            warnings: result.warnings,
          });
        } catch (error) {
          if (error instanceof DraftError) {
            const status = error.code === 'revision-conflict' ? 409 : error.code === 'model-failed' ? 502 : 400;
            sendJson(response, status, { error: error.code, message: error.message, issues: error.issues });
            return;
          }
          throw error;
        }
        return;
      }

      if (url.pathname === '/api/schema/annotate' && method === 'POST') {
        const file = schemaFileOf();
        if (!fs.existsSync(file)) {
          throw new SchemaEditError('invalid-edits', 'schema 不存在，无法生成标注');
        }
        const models = listModels(fs.readFileSync(file, 'utf8'));
        const candidates = collectAnnotateCandidates(models);
        if (candidates.length === 0) {
          sendJson(response, 200, {
            ok: true,
            suggestions: { models: [], fields: [] },
            candidates: { models: 0, fields: 0 },
            message: '所有模型与字段都已有注释',
          });
          return;
        }
        let config;
        try {
          config = resolveAiConfig({ env: aiEnv() });
        } catch (error) {
          throw new SchemaEditError('ai-not-configured', error instanceof Error ? error.message : String(error));
        }
        try {
          const raw = await chatCompletion({
            config,
            messages: buildAnnotateMessages(candidates),
            responseFormat: 'json_object',
            fetchImpl: options.fetchImpl,
            timeoutMs: config.timeoutMs,
          });
          const suggestions = parseAnnotateResult(raw, candidates);
          sendJson(response, 200, { ok: true, suggestions, candidates: candidateStats(candidates) });
        } catch (error) {
          throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (url.pathname === '/api/schema/import-json' && method === 'POST') {
        const body = (await readJsonBody(request)) as { json?: unknown };
        if (typeof body.json !== 'string' || body.json.trim() === '') {
          throw new SchemaEditError('invalid-edits', '缺少 json（要识别的 JSON 文本）');
        }
        let parsed: ReturnType<typeof parseModelsJson>;
        try {
          parsed = parseModelsJson(body.json);
        } catch (error) {
          throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
        }
        const context = buildDesignerContext({ projectRoot: options.projectRoot });
        // 与 AI 草案导入同一条链路：补框架字段、翻译约束、关系只留外键；不写盘
        const result = draftToEditorModels(parsed.draft, {
          conventions: context.conventions,
          database: context.database || 'postgresql',
        });
        sendJson(response, 200, {
          ok: true,
          models: result.models,
          notes: [...parsed.notes, ...result.notes],
          skipped: result.skipped,
        });
        return;
      }

      if (url.pathname === '/api/model-draft/to-editor' && method === 'POST') {
        const body = (await readJsonBody(request)) as { draft?: unknown };
        if (typeof body.draft !== 'object' || body.draft === null || Array.isArray(body.draft)) {
          throw new SchemaEditError('invalid-edits', '缺少 draft（要导入编辑器的草案对象）');
        }
        const context = buildDesignerContext({ projectRoot: options.projectRoot });
        // 只做格式转换：不写 schema、不落盘，写入仍走 /api/schema/preview + apply
        const result = draftToEditorModels(body.draft as Record<string, unknown>, {
          conventions: context.conventions,
          database: context.database || 'postgresql',
        });
        sendJson(response, 200, { ok: true, ...result });
        return;
      }

      if (url.pathname === '/api/model-draft' && method === 'POST') {
        const body = (await readJsonBody(request)) as {
          requirement?: unknown;
          mode?: unknown;
          baseRevision?: unknown;
          draft?: unknown;
        };
        if (typeof body.requirement !== 'string') {
          throw new SchemaEditError('invalid-edits', '缺少 requirement（业务描述）');
        }
        if (body.mode !== undefined && body.mode !== 'create' && body.mode !== 'revise') {
          throw new SchemaEditError('invalid-edits', 'mode 只能是 create 或 revise');
        }
        const draft =
          typeof body.draft === 'object' && body.draft !== null && !Array.isArray(body.draft)
            ? (body.draft as Record<string, unknown>)
            : undefined;
        try {
          const result = await runDraftDesign(
            {
              requirement: body.requirement,
              mode: body.mode === 'revise' ? 'revise' : 'create',
              baseRevision: typeof body.baseRevision === 'number' ? body.baseRevision : undefined,
              draft,
            },
            { projectRoot: options.projectRoot, fetchImpl: options.fetchImpl, env: aiEnv() },
          );
          sendJson(response, 200, {
            ok: true,
            draft: result.draft,
            attempts: result.attempts,
            warnings: result.warnings,
            context: summarizeContext(result.context),
          });
        } catch (error) {
          if (error instanceof DraftError) {
            const status = error.code === 'revision-conflict' ? 409 : error.code === 'model-failed' ? 502 : 400;
            sendJson(response, status, { error: error.code, message: error.message, issues: error.issues });
            return;
          }
          throw error;
        }
        return;
      }

      if (url.pathname === '/api/ai-config' && isGet) {
        sendJson(response, 200, { ok: true, ...aiRouteStatus({ file: options.aiConfigFile }) });
        return;
      }

      if (url.pathname === '/api/ai-config' && method === 'POST') {
        const body = (await readJsonBody(request)) as {
          baseUrl?: unknown;
          model?: unknown;
          apiKey?: unknown;
          clearApiKey?: unknown;
          timeoutMs?: unknown;
        };
        const patch: {
          baseUrl?: string;
          model?: string;
          apiKey?: string;
          clearApiKey?: boolean;
          timeoutMs?: number;
        } = {};
        if (body.baseUrl !== undefined) {
          if (typeof body.baseUrl !== 'string') throw new SchemaEditError('invalid-edits', 'baseUrl 必须是字符串');
          patch.baseUrl = body.baseUrl;
        }
        if (body.model !== undefined) {
          if (typeof body.model !== 'string') throw new SchemaEditError('invalid-edits', 'model 必须是字符串');
          patch.model = body.model;
        }
        if (body.apiKey !== undefined) {
          if (typeof body.apiKey !== 'string') throw new SchemaEditError('invalid-edits', 'apiKey 必须是字符串');
          patch.apiKey = body.apiKey;
        }
        if (body.clearApiKey !== undefined) {
          if (typeof body.clearApiKey !== 'boolean') throw new SchemaEditError('invalid-edits', 'clearApiKey 必须是布尔值');
          patch.clearApiKey = body.clearApiKey;
        }
        if (body.timeoutMs !== undefined) {
          if (typeof body.timeoutMs !== 'number') throw new SchemaEditError('invalid-edits', 'timeoutMs 必须是数字（毫秒）');
          patch.timeoutMs = body.timeoutMs;
        }
        if (Object.keys(patch).length === 0) {
          throw new SchemaEditError('invalid-edits', '没有要保存的字段（baseUrl / model / apiKey / clearApiKey）');
        }
        try {
          saveAiConfig(patch, options.aiConfigFile);
        } catch (error) {
          throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
        }
        // 保存后只回状态，绝不回显密钥
        sendJson(response, 200, { ok: true, ...aiRouteStatus({ file: options.aiConfigFile }) });
        return;
      }

      if (url.pathname === '/api/ai-config/test' && method === 'POST') {
        const body = (await readJsonBody(request)) as { baseUrl?: unknown; apiKey?: unknown };
        const fileConfig = readAiConfigFile(options.aiConfigFile ?? aiConfigFilePath()).config ?? {};
        const baseUrl =
          typeof body.baseUrl === 'string' && body.baseUrl.trim() !== ''
            ? body.baseUrl
            : (fileConfig.baseUrl ?? process.env[AI_ENV.baseUrl] ?? 'https://api.openai.com/v1');
        const apiKey =
          typeof body.apiKey === 'string' && body.apiKey.trim() !== ''
            ? body.apiKey
            : (fileConfig.apiKey ?? process.env[AI_ENV.apiKey] ?? process.env.OPENAI_API_KEY ?? '');
        const result = await testAiConnection({ baseUrl, apiKey, fetchImpl: options.fetchImpl });
        sendJson(response, 200, { ok: result.ok, message: result.message, models: result.models });
        return;
      }

      if (url.pathname === '/api/ai-config/diagnose' && method === 'POST') {
        const body = (await readJsonBody(request)) as { baseUrl?: unknown; apiKey?: unknown; model?: unknown };
        const fileConfig = readAiConfigFile(options.aiConfigFile ?? aiConfigFilePath()).config ?? {};
        const env = aiEnv();
        const baseUrl =
          typeof body.baseUrl === 'string' && body.baseUrl.trim() !== ''
            ? body.baseUrl
            : (fileConfig.baseUrl ?? env[AI_ENV.baseUrl] ?? 'https://api.openai.com/v1');
        const apiKey =
          typeof body.apiKey === 'string' && body.apiKey.trim() !== ''
            ? body.apiKey
            : (fileConfig.apiKey ?? env[AI_ENV.apiKey] ?? env.OPENAI_API_KEY ?? '');
        const model =
          typeof body.model === 'string' && body.model.trim() !== ''
            ? body.model
            : (fileConfig.model ?? env[AI_ENV.model] ?? '');
        const timeoutMs =
          fileConfig.timeoutMs ??
          (Number(env[AI_ENV.timeoutMs] ?? '') >= 1000 ? Number(env[AI_ENV.timeoutMs]) : 30_000);
        const result = await diagnoseAi({ baseUrl, apiKey, model, fetchImpl: options.fetchImpl, timeoutMs });
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === '/api/ai-config/models' && method === 'POST') {
        const body = (await readJsonBody(request)) as { baseUrl?: unknown; apiKey?: unknown };
        const fileConfig = readAiConfigFile(options.aiConfigFile ?? aiConfigFilePath()).config ?? {};
        const baseUrl =
          typeof body.baseUrl === 'string' && body.baseUrl.trim() !== ''
            ? body.baseUrl
            : (fileConfig.baseUrl ?? process.env[AI_ENV.baseUrl] ?? 'https://api.openai.com/v1');
        const apiKey =
          typeof body.apiKey === 'string' && body.apiKey.trim() !== ''
            ? body.apiKey
            : (fileConfig.apiKey ?? process.env[AI_ENV.apiKey] ?? process.env.OPENAI_API_KEY ?? '');
        const result = await listAiModels({ baseUrl, apiKey, fetchImpl: options.fetchImpl });
        // 失败也 200：这是「查列表」的探测结果，不是请求错误
        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === '/api/review' && isGet) {
        // 只回「有没有配置」与地址/模型名，永不回显密钥
        const env = aiEnv();
        sendJson(response, 200, {
          ok: true,
          configured: hasAiConfig(env),
          baseUrl: env[AI_ENV.baseUrl] ?? '',
          model: env[AI_ENV.model] ?? '',
        });
        return;
      }

      if (url.pathname === '/api/review' && method === 'POST') {
        // 未配置就先拦：让用户看到「少哪个环境变量」，而不是一个失败任务
        try {
          resolveAiConfig({ env: aiEnv() });
        } catch (error) {
          throw new SchemaEditError('ai-not-configured', error instanceof Error ? error.message : String(error));
        }
        const reviewReq = buildReviewArgs(await readJsonBody(request));
        try {
          const jobId = jobs.start({
            action: `review ${reviewReq.models.length > 0 ? reviewReq.models.join(' ') : '全部生成物'}`,
            command: process.execPath,
            args: [cliEntry, ...reviewReq.args],
            cwd: options.projectRoot,
          });
          sendJson(response, 202, { ok: true, jobId });
        } catch (error) {
          throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (url.pathname === '/api/gen' && method === 'POST') {
        const { models, args } = buildGenArgs(await readJsonBody(request));
        try {
          // 用当前 node 执行 CLI 入口：不依赖 PATH，也不引入 shell（无注入面）
          const jobId = jobs.start({
            action: `gen crud ${models.join(' ')}`,
            command: process.execPath,
            args: [cliEntry, ...args],
            cwd: options.projectRoot,
          });
          sendJson(response, 202, { ok: true, jobId });
        } catch (error) {
          throw new SchemaEditError('invalid-edits', error instanceof Error ? error.message : String(error));
        }
        return;
      }

      if (url.pathname.startsWith('/api/jobs/') && isGet) {
        const id = url.pathname.slice('/api/jobs/'.length);
        const job = jobs.get(id);
        if (!job) {
          sendJson(response, 404, { error: 'not-found', message: `任务不存在：${id}` });
          return;
        }
        sendJson(response, 200, job);
        return;
      }

      if (url.pathname === '/api/schema/relation' && method === 'POST') {
        const file = schemaFileOf();
        if (!fs.existsSync(file)) throw new SchemaEditError('invalid-edits', 'schema 不存在，无法编辑');
        const text = fs.readFileSync(file, 'utf8');
        const payload = (await readJsonBody(request)) as Partial<RelationRequest>;
        if (typeof payload.from !== 'string' || typeof payload.to !== 'string') {
          throw new SchemaEditError('invalid-edits', '缺少 from / to（关系的两端模型）');
        }
        // 关系的两端字段由服务端生成：界面只提交「谁指向谁」，避免两端写法不一致
        const edits = buildRelationEdits(text, {
          from: payload.from,
          to: payload.to,
          required: payload.required === true,
          fkName: typeof payload.fkName === 'string' ? payload.fkName : undefined,
          fieldName: typeof payload.fieldName === 'string' ? payload.fieldName : undefined,
        });
        const preview = previewEdits(text, edits, tokens);
        sendJson(response, 200, { ok: true, edits, ...preview });
        return;
      }

      if (url.pathname === '/api/schema/apply' && method === 'POST') {
        const file = schemaFileOf();
        if (!fs.existsSync(file)) throw new SchemaEditError('invalid-edits', 'schema 不存在，无法编辑');
        const text = fs.readFileSync(file, 'utf8');
        const payload = (await readJsonBody(request)) as { edits?: unknown; confirmToken?: unknown };
        const edits = readEdits(payload);
        const outcome = await applyEdits({
          text,
          edits,
          schemaFile: file,
          backupDir: path.join(options.projectRoot, 'backups', 'schema'),
          confirmToken: typeof payload.confirmToken === 'string' ? payload.confirmToken : undefined,
          store: tokens,
          skipValidate: options.skipValidate,
          exec: options.exec,
        });
        // 写成功后立刻让体检缓存失效，页面刷新即看到新模型
        cached = null;
        sendJson(response, 200, { ok: true, ...outcome });
        return;
      }

      // 已知路径但方法不对 → 405（明确告知该用什么方法，比 404 更好排错）
      const knownGet = [
        '/api/health',
        '/api/project',
        '/api/schema',
        '/api/gen/drift',
        '/api/review',
        '/api/model-draft',
        '/api/model-draft/saved',
        '/api/ai-config',
      ];
      if (url.pathname.startsWith('/api/jobs/')) {
        response.writeHead(405, { allow: 'GET', 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'method-not-allowed', message: '任务查询只接受 GET' }));
        return;
      }
      if (knownGet.includes(url.pathname)) {
        response.writeHead(405, { allow: 'GET, HEAD', 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'method-not-allowed', message: '该接口只读' }));
        return;
      }
      const knownPost = [
        '/api/schema/preview',
        '/api/schema/apply',
        '/api/schema/relation',
        '/api/gen',
        '/api/review',
        '/api/model-draft',
        '/api/ai-config',
        '/api/ai-config/test',
        '/api/ai-config/models',
        '/api/ai-config/diagnose',
        '/api/model-draft/to-editor',
        '/api/model-draft/saved',
        '/api/model-draft/saved/clear',
        '/api/model-draft/revise',
        '/api/schema/import-json',
        '/api/schema/annotate',
      ];
      if (knownPost.includes(url.pathname)) {
        response.writeHead(405, { allow: 'POST', 'content-type': 'application/json; charset=utf-8' });
        response.end(JSON.stringify({ error: 'method-not-allowed', message: '该接口只接受 POST' }));
        return;
      }

      sendJson(response, 404, { error: 'not-found', message: `未知路径：${url.pathname}` });
    })().catch((error: unknown) => {
      if (error instanceof SchemaEditError) {
        const status = error.code === 'confirm-required' ? 409 : 400;
        sendJson(response, status, { error: error.code, message: error.message });
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      sendJson(response, 500, { error: 'internal', message });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    // 只绑 127.0.0.1：即使调用方想开外网也开不了
    server.listen(options.port ?? DEFAULT_STUDIO_PORT, '127.0.0.1', () => resolve());
  });

  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${port}/?token=${token}`;
  log(`[studio] 服务已启动：${url}`);

  return {
    url,
    port,
    token,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
