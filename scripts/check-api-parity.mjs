#!/usr/bin/env node
/*
 * @file 前后端接口对撞门禁（API parity check）
 * @description 本仓库的架构是「契约先行 + mock 顶上」：C-06 契约（docs/contracts/api-web.ts）冻结于 M5，
 *   前端 admin-web 与 mock 按契约全量实现，而后端 example-api 只落地到「演示可验证」深度。
 *   两边各自的门禁（前端单测/冒烟走 mock，后端冒烟走已实现路由）都是绿的，于是
 *   「契约声明、mock 有、后端未注册」的端点只有在接真实 API 后才 404 —— 线上点页面才第一次暴露。
 *
 *   本脚本把两侧的路由面拉平对撞：
 *     - 前端调用面：apps/admin-web/src 下所有 request.<method>('<path>') 调用（模板串归一为 :param）；
 *     - 后端路由面：全仓 *.controller.ts 的 @Controller 前缀 + @Get/@Post/@Put/@Delete/@Patch 方法路径。
 *   前端调用而后端未注册 → 失败（这就是线上 404 的直接来源）。
 *   后端注册而前端未调用 → 仅提示（演示端点 / 运维端点本就不该被前端调）。
 *
 *   退出码：0 = 一致；1 = 存在缺口；2 = 解析失败（宁可将 CI 挂红，也不放行未知状态）。
 * @author donttemo
 * @created 2026-10-14
 * @module scripts
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, relative } from 'node:path';

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, 'apps/admin-web/src');
const BACKEND_GLOBS = [
  join(ROOT, 'apps/example-api/src'),
  join(ROOT, 'packages'),
];

/** 前端调用经 request.ts 的 baseURL 拼成完整路径 */
const API_BASE = '/api/v1';

/**
 * 归一化路径：模板变量与命名参数统一为 :dyn，使 `/users/${id}` 与 `@Get(':id')` 可比
 * （参数名两侧各自随意取，语义上同一个占位段）
 */
function normalizePath(path) {
  return path
    .replace(/\$\{[^}]*\}/g, ':dyn')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':dyn')
    .replace(/\/+$/, '')
    .replace(/^([^?]*)\?.*$/, '$1');
}

/** 统一方法名大小写 */
function normalizeMethod(method) {
  return method.toUpperCase();
}

/** 递归收集目录下所有 .ts 文件 */
async function collectTsFiles(dir, out = []) {
  if (!existsSync(dir)) return out;
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue;
      await collectTsFiles(full, out);
    } else if (entry.isFile() && (entry.name.endsWith('.ts') || entry.name.endsWith('.vue'))) {
      out.push(full);
    }
  }
  return out;
}

/**
 * 提取前端调用面
 * 匹配 request.get('/x')、request.post(`/x/${id}`)、request.put(`/x/${id}`, data) 等
 */
async function collectFrontendCalls() {
  const files = await collectTsFiles(WEB_SRC);
  const calls = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    // [^(]*? 兼容带泛型的调用（request.get<PageResult<UserListItem>>('...')）：
    // 泛型里不会出现左括号，故「到左括号为止」的匹配既宽松又不会跨到下一个调用
    const pattern = /request\.(get|post|put|delete|patch)\b[^(]*?\(\s*(['"`])([^'"`]+)\2/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const [, method, , rawPath] = match;
      calls.push({
        method: normalizeMethod(method),
        path: `${API_BASE}${normalizePath(rawPath)}`,
        source: relative(ROOT, file),
      });
    }
  }
  return calls;
}

/**
 * 提取后端路由面
 * 逐文件按 @Controller 分段：段内首个 @Controller 的参数为前缀，其后到下一个 @Controller 前的
 * 所有 @Get/@Post/@Put/@Delete/@Patch 装饰器参数为方法路径（无参表示前缀本身）。
 */
async function collectBackendRoutes() {
  const routes = [];
  const skipped = [];
  for (const base of BACKEND_GLOBS) {
    for (const file of await collectTsFiles(base)) {
      if (!file.endsWith('.controller.ts')) continue;
      const text = await readFile(file, 'utf8');
      const lines = text.split('\n');
      let prefix = null;
      for (const line of lines) {
        const controllerMatch = line.match(/@Controller\s*\(\s*(['"`])([^'"`]*)\1\s*\)/);
        if (controllerMatch) {
          prefix = controllerMatch[2];
          continue;
        }
        if (prefix === null) continue;
        const methodMatch = line.match(
          /@(Get|Post|Put|Delete|Patch)\s*\(\s*(['"`])([^'"`]*)\2\s*\)/,
        );
        if (methodMatch) {
          routes.push({
            method: normalizeMethod(methodMatch[1]),
            path: normalizePath(`${prefix}/${methodMatch[3]}`),
            source: relative(ROOT, file),
          });
          continue;
        }
        // 无参方法装饰器（@Get() / @Post()）：路径即前缀本身
        const bareMatch = line.match(/@(Get|Post|Put|Delete|Patch)\s*\(\s*\)/);
        if (bareMatch) {
          routes.push({
            method: normalizeMethod(bareMatch[1]),
            path: normalizePath(prefix),
            source: relative(ROOT, file),
          });
          continue;
        }
        // 动态路径（@Get(CONSTANT)）：无法静态解析，记录下来供人工核对
        const dynamicMatch = line.match(/@(Get|Post|Put|Delete|Patch)\s*\(\s*[A-Z_][A-Z0-9_]*\s*\)/);
        if (dynamicMatch) {
          skipped.push({ line: line.trim(), source: relative(ROOT, file) });
        }
      }
    }
  }
  return { routes, skipped };
}

/** 端点键：方法 + 归一化路径 */
function key(method, path) {
  return `${method} ${path}`;
}

async function main() {
  const frontend = await collectFrontendCalls();
  const { routes: backend, skipped } = await collectBackendRoutes();

  // 动态调用面：路径首段即模板变量（如 CrudTable 的 props.api），运行时才确定，
  // 无法静态校验——单独计数并提示，不计入缺口（否则永远误报）
  const dynamic = frontend.filter((call) => call.path.startsWith(`${API_BASE}${':dyn'}`));
  const staticCalls = frontend.filter((call) => !call.path.startsWith(`${API_BASE}${':dyn'}`));

  const backendKeys = new Set(backend.map((route) => key(route.method, route.path)));
  const frontendKeys = new Set(staticCalls.map((call) => key(call.method, call.path)));

  const missing = staticCalls.filter((call) => !backendKeys.has(key(call.method, call.path)));
  const unused = backend.filter((route) => !frontendKeys.has(key(route.method, route.path)));

  console.log('[api-parity] 前端调用面：%d 个端点（%d 个文件）', frontendKeys.size, new Set(staticCalls.map((c) => c.source)).size);
  console.log('[api-parity] 后端路由面：%d 个端点', backendKeys.size);
  if (dynamic.length > 0) {
    const sources = [...new Set(dynamic.map((call) => call.source))];
    console.log('[api-parity] 运行时动态路径（无法静态校验，共 %d 处调用）：%s', dynamic.length, sources.join('、'));
  }

  if (skipped.length > 0) {
    console.log('[api-parity] 无法静态解析的后端路由（动态路径常量，需人工核对）：');
    for (const item of skipped) console.log('    - %s (%s)', item.line, item.source);
  }

  if (unused.length > 0) {
    console.log('[api-parity] 后端已注册但前端未调用（演示 / 运维端点，属正常，仅提示）：');
    for (const route of unused) console.log('    - %s %s (%s)', route.method, route.path, route.source);
  }

  if (missing.length > 0) {
    console.error('[api-parity] 前端调用但后端未注册（接入真实 API 即 404）：');
    for (const call of missing) {
      console.error('    - %s %s  ← %s', call.method, call.path, call.source);
    }
    console.error('[api-parity] 缺口 %d 个，请补齐后端实现或修正前端路径', missing.length);
    process.exit(1);
  }

  console.log('[api-parity] OK：前端调用面全部有对应后端路由');
  process.exit(0);
}

main().catch((error) => {
  console.error('[api-parity] 解析失败：', error);
  process.exit(2);
});
