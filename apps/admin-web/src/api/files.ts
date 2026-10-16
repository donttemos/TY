/*
 * @file files.ts
 * @description 附件 API 封装（PRD-010 E-09）：上传（multipart，字段名 file）/ 下载地址拼装，
 *   与后端 /api/v1/files 契约一一对应（api-spec §3.19）。上传成功返回文件 id + 下载 url，
 *   业务表单把 id 存入附件字段（*FileId），下载面按 id 现取（权限随会话）。
 * @author donttemo
 * @created 2026-10-16
 * @module admin-web/api
 */

import { request } from '@/utils/request';

/** 上传结果（与后端 POST /files 响应 data 对齐） */
export interface UploadedFile {
  /** 文件 id（业务附件字段存这个） */
  id: string;
  /** 下载相对路径（/api/v1/files/:id/download） */
  url: string;
  /** 原始文件名 */
  originalName: string;
  /** 字节数 */
  size: number;
  /** MIME 类型 */
  mimeType: string;
}

/** 文件元数据（与后端 GET /files/:id 响应 data 对齐） */
export interface FileMeta {
  id: string;
  originalName: string;
  size: number;
  mimeType: string;
  createdAt: string;
}

/** 上传附件（multipart/form-data；类型/大小白名单由服务端把关，超限回 1001 文案） */
export function uploadFile(file: File): Promise<UploadedFile> {
  const form = new FormData();
  form.append('file', file);
  return request.post<UploadedFile>('/files', form, { headers: { 'Content-Type': 'multipart/form-data' } });
}

/** 文件元数据 */
export function fetchFileMeta(id: string): Promise<FileMeta> {
  return request.get<FileMeta>(`/files/${id}`);
}

/** 下载地址（带会话鉴权的相对路径；el-upload/预览组件直接引用） */
export function fileDownloadUrl(id: string): string {
  return `/api/v1/files/${id}/download`;
}
