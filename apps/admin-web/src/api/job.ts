/*
 * @file 异步任务 API（N-02 通用任务面）
 * @description 进度轮询、失败重跑与产物下载。任务由业务侧派发（如 `GET /audit-logs/export`、
 *   `POST /tenants/:id/migrate`）并立即返回 jobId，本模块只消费 `/jobs/:id/*`。
 *   下载走 axios 的 blob 通道（而非直接开窗口）：令牌在内存里，直接 window.open 会 401；
 *   走统一请求层还能复用 401 → 无感刷新 → 重放。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/api
 */

import { request } from '@/utils/request';
import type { JobView } from './types';

/** 任务进度（轮询） */
export function fetchJobProgress(id: string): Promise<JobView> {
  return request.get<JobView>(`/jobs/${id}/progress`);
}

/** 失败任务原地重跑 */
export function retryJob(id: string): Promise<JobView> {
  return request.post<JobView>(`/jobs/${id}/retry`);
}

/** 拉取任务产物（Blob；调用方负责触发下载） */
export function fetchJobArtifact(id: string): Promise<Blob> {
  return request.get<Blob>(`/jobs/${id}/download`, { responseType: 'blob' });
}

/**
 * 下载任务产物
 * @param id 任务 ID
 * @param fileName 文件名（缺省用服务端建议名 job-<id>.dat）
 */
export async function downloadJob(id: string, fileName?: string): Promise<void> {
  const blob = await fetchJobArtifact(id);
  const url = URL.createObjectURL(blob);
  try {
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = fileName ?? `job-${id}.dat`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
  } finally {
    // 释放临时 URL，避免长时间使用累积内存
    URL.revokeObjectURL(url);
  }
}
