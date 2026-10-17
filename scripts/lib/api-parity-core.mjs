/*
 * @file API 对撞共享库（调用面 / 路由面提取与归一化）
 * @description 供两个门禁共用：
 *   - scripts/check-api-parity.mjs：apps/admin-web 前端调用面 ↔ 后端路由面（C-06 对撞）；
 *   - scripts/check-triway-consistency.mjs：框架包 ↔ example-api ↔ admin 模板三方对撞。
 *   两处门禁必须同源——否则同一条路径在两侧算出不同键，对撞结论不可信。
 *   能力：路径归一化（模板变量/命名参数统一 :dyn、查询串剥离、连续斜杠折叠）、
 *   TS/Vue 文件收集、request.* 调用面提取、*.controller.ts 路由面提取
 *   （@Controller 前缀 + 方法装饰器，同行字符串常量可解析）、注释剥离（权限码提取用）。
 * @author donttemo
 * @created 2026-10-17
 * @module scripts/lib
 */

import { readdir, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 归一化路径：模板变量与命名参数统一为 :dyn，使 `/users/${id}` 与 `@Get(':id')` 可比
 * （参数名两侧各自随意取，语义上同一个占位段）；连续斜杠折叠（@Controller() 空前缀 +
 * 带斜杠方法路径会产生 `//health`，必须折成 `/health` 才能与前端调用对上键）
 */
export function normalizePath(path) {
  return path
    .replace(/\$\{[^}]*\}/g, ':dyn')
    .replace(/:[A-Za-z_][A-Za-z0-9_]*/g, ':dyn')
    .replace(/\/{2,}/g, '/')
    .replace(/\/+$/, '')
    .replace(/^([^?]*)\?.*$/, '$1');
}

/** 统一方法名大小写 */
export function normalizeMethod(method) {
  return method.toUpperCase();
}

/** 端点键：方法 + 归一化路径 */
export function endpointKey(method, path) {
  return `${method} ${path}`;
}

/** 递归收集目录下所有 .ts / .vue 文件（跳过 node_modules / dist / 测试目录） */
export async function collectTsFiles(dir, out = []) {
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
 * 剥离注释（行内 // 与块 /* *\/，感知字符串字面量，不误伤 'http://' 之类内容）
 * 仅用于权限码等「按字面量提取」的场景——路由/调用面提取不走此函数
 * （request.get('/x') 的路径串里出现 // 的概率为零，但权限码注释里写码是常态）
 */
export function stripComments(text) {
  let out = '';
  let quote = null;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (quote) {
      out += ch;
      if (ch === '\\') {
        out += next ?? '';
        i += 1;
      } else if (ch === quote) {
        quote = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === '/' && next === '/') {
      while (i < text.length && text[i] !== '\n') i += 1;
      out += '\n';
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i += 1;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * 提取前端调用面
 * 匹配 request.get('/x')、request.post(`/x/${id}`)、request.put<Generic>('/x', data) 等
 * （[^(]*? 兼容带泛型的调用：泛型里不会出现左括号，「到左括号为止」既宽松又不会跨到下一个调用）
 */
export async function collectFrontendCalls(dir, apiBase) {
  const files = await collectTsFiles(dir);
  const calls = [];
  for (const file of files) {
    const text = await readFile(file, 'utf8');
    const pattern = /request\.(get|post|put|delete|patch)\b[^(]*?\(\s*(['"`])([^'"`]+)\2/g;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      calls.push({
        method: normalizeMethod(match[1]),
        path: `${apiBase}${normalizePath(match[3])}`,
        source: file,
      });
    }
  }
  return calls;
}

/**
 * 收集文件内的字符串常量声明（const / export const NAME = 'literal'）
 * 供 @Get(CONST) 形式的路由常量解析使用（如 @fw/cache 的 CACHE_METRICS_PATH）
 */
function collectStringConstants(text) {
  const map = new Map();
  const pattern = /(?:export\s+)?const\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?::[^=]+)?=\s*'([^']*)'/g;
  let match;
  while ((match = pattern.exec(text)) !== null) map.set(match[1], match[2]);
  return map;
}

/**
 * 提取后端路由面
 * 逐文件按 @Controller 分段：段内首个 @Controller 的参数为前缀，其后到下一个 @Controller 前的
 * 所有 @Get/@Post/@Put/@Delete/@Patch 装饰器参数为方法路径（无参表示前缀本身）。
 * 动态路径（@Get(CONST)）：同行/同文件常量可解析则计入路由面，否则记入 skipped 供人工核对。
 */
export async function collectBackendRoutes(dirs) {
  const routes = [];
  const skipped = [];
  for (const base of dirs) {
    for (const file of await collectTsFiles(base)) {
      if (!file.endsWith('.controller.ts')) continue;
      const text = await readFile(file, 'utf8');
      const constants = collectStringConstants(text);
      const lines = text.split('\n');
      let prefix = null;
      for (const line of lines) {
        const controllerMatch = line.match(/@Controller\s*\(\s*(['"`])([^'"`]*)\1\s*\)/);
        if (controllerMatch) {
          prefix = controllerMatch[2];
          continue;
        }
        // 空前缀控制器（@Controller()：健康探针 / 指标类，方法路径即完整路由）
        const emptyControllerMatch = line.match(/@Controller\s*\(\s*\)/);
        if (emptyControllerMatch) {
          prefix = '';
          continue;
        }
        if (prefix === null) continue;
        // 字面量路径：@Get('x') / @Get()
        const methodMatch = line.match(
          /@(Get|Post|Put|Delete|Patch)\s*\(\s*(['"`])([^'"`]*)\2\s*\)/,
        );
        if (methodMatch) {
          routes.push({
            method: normalizeMethod(methodMatch[1]),
            path: normalizePath(`${prefix}/${methodMatch[3]}`),
            source: file,
          });
          continue;
        }
        const bareMatch = line.match(/@(Get|Post|Put|Delete|Patch)\s*\(\s*\)/);
        if (bareMatch) {
          routes.push({
            method: normalizeMethod(bareMatch[1]),
            path: normalizePath(prefix),
            source: file,
          });
          continue;
        }
        // 常量路径：@Get(CONST)——同文件可解析则归一化计入，否则留待人工核对
        const constMatch = line.match(/@(Get|Post|Put|Delete|Patch)\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*\)/);
        if (constMatch) {
          const value = constants.get(constMatch[2]);
          if (value !== undefined) {
            routes.push({
              method: normalizeMethod(constMatch[1]),
              path: normalizePath(`${prefix}/${value}`),
              source: file,
            });
          } else {
            skipped.push({ line: line.trim(), source: file });
          }
        }
      }
    }
  }
  return { routes, skipped };
}
