/*
 * @file 配置中心 API（M9 / PRD-009 FR-06，api-spec §3.10）
 * @description 白名单键列表与在线修改。写走单一生效管道：校验 → 审计 → 持久化 → 应用 → 通知；
 *   错误语义：boot 键 400/5001、值非法 400/5002（details 带原因）、未知键 404/5003、越权 403/3002。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { ConfigListResult, ConfigWriteResult } from './types';

/** 白名单键当前生效值列表 + 运行元信息 */
export function fetchConfigs(): Promise<ConfigListResult> {
  return request.get<ConfigListResult>('/configs');
}

/** 修改白名单键（value 为 JSON 语义：数字 / 字符串；服务端复用 env 同一份校验器） */
export function updateConfig(key: string, value: unknown): Promise<ConfigWriteResult> {
  return request.put<ConfigWriteResult>(`/configs/${key}`, { value });
}
