/*
 * @file vite mock server 插件
 * @description 以 connect 中间件挂载 /api/v1/*（C-06 契约的内存实现）；仅在非 production 模式启用，
 *   production 构建不引入任何 mock 代码（产物纯静态）。切真实后端：改 .env.* 的 VITE_API_BASE_URL 即可，
 *   业务代码零改动（85 文档 §6 L4「完全不等后端」策略）。
 * @author donttemo
 * @created 2026-10-13
 * @module admin-web/mock
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Plugin, ViteDevServer } from 'vite';
import { handleMockRequest } from './handlers';

/** 是否需要启用 mock：mode 非 production，或显式 VITE_USE_MOCK=true */
export function shouldUseMock(mode: string, useMockFlag?: string): boolean {
  if (useMockFlag === 'true') return true;
  if (useMockFlag === 'false') return false;
  return mode !== 'production';
}

/** 注册 mock 中间件；返回 null 表示不启用 */
export function viteMockServer(mode: string, useMockFlag?: string): Plugin | null {
  if (!shouldUseMock(mode, useMockFlag)) return null;
  return {
    name: 'fw-admin-mock-server',
    configureServer(server: ViteDevServer) {
      server.middlewares.use('/api/v1', (req: IncomingMessage, res: ServerResponse, next: () => void) => {
        void handleMockRequest(req, res).then((result) => {
          if (!result.handled) next();
        });
      });
    },
  };
}
