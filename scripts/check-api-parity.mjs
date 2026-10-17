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
 *   提取与归一化逻辑与 check-triway-consistency.mjs 共用 scripts/lib/api-parity-core.mjs——
 *   同一条路径必须在两个门禁里算出同一个键，否则对撞结论不可信。
 *
 *   退出码：0 = 一致；1 = 存在缺口；2 = 解析失败（宁可将 CI 挂红，也不放行未知状态）。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-17 donttemo 提取共享库 scripts/lib/api-parity-core.mjs（与三方一致性门禁同源）；
 *   路由提取新增同行字符串常量解析（@Get(CACHE_METRICS_PATH) 不再落入「无法静态解析」），
 *   路径归一化折叠连续斜杠（@Controller() 空前缀下的 //health → /health）
 * @module scripts
 */

import { join, relative } from 'node:path';
import {
  collectBackendRoutes,
  collectFrontendCalls,
  endpointKey,
} from './lib/api-parity-core.mjs';

const ROOT = process.cwd();
const WEB_SRC = join(ROOT, 'apps/admin-web/src');
const BACKEND_GLOBS = [
  join(ROOT, 'apps/example-api/src'),
  join(ROOT, 'packages'),
];

/** 前端调用经 request.ts 的 baseURL 拼成完整路径 */
const API_BASE = '/api/v1';

async function main() {
  const frontend = await collectFrontendCalls(WEB_SRC, API_BASE);
  const { routes: backend, skipped } = await collectBackendRoutes(BACKEND_GLOBS);

  // 动态调用面：路径首段即模板变量（如 CrudTable 的 props.api），运行时才确定，
  // 无法静态校验——单独计数并提示，不计入缺口（否则永远误报）
  const dynamic = frontend.filter((call) => call.path.startsWith(`${API_BASE}:dyn`));
  const staticCalls = frontend.filter((call) => !call.path.startsWith(`${API_BASE}:dyn`));

  const backendKeys = new Set(backend.map((route) => endpointKey(route.method, route.path)));
  const frontendKeys = new Set(staticCalls.map((call) => endpointKey(call.method, call.path)));

  const missing = staticCalls.filter((call) => !backendKeys.has(endpointKey(call.method, call.path)));
  const unused = backend.filter((route) => !frontendKeys.has(endpointKey(route.method, route.path)));

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
    for (const route of unused) console.log('    - %s %s (%s)', route.method, route.path, relative(ROOT, route.source));
  }

  if (missing.length > 0) {
    console.error('[api-parity] 前端调用但后端未注册（接入真实 API 即 404）：');
    for (const call of missing) {
      console.error('    - %s %s  ← %s', call.method, call.path, relative(ROOT, call.source));
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
