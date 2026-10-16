/*
 * @file 附件上传端点（admin 模板）
 * @description POST /api/v1/files（需 file:create，multipart/form-data，字段名 file）；
 *   GET /api/v1/files/:id 元数据；GET /api/v1/files/:id/download 下载（登录即可）。
 *   下载用 @Res() 直接写 Buffer：统一响应拦截器对 res.headersSent 场景不二次包装（与任务产物下载同款约定），
 *   Content-Disposition 带原始文件名（RFC 5987 编码中文）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-16 donttemo E-09 收编：下载由本地盘流改为 StoragePort 读取（Buffer），multer 上限随 STORAGE_MAX_MB
 * @module __APP_NAME__/upload
 */
import { Controller, Get, Param, Post, Res, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { Response } from 'express';
import { BizError, ErrorCode } from '@fw/core';
import { loadEnv } from '@fw/config';
import { CurrentUser, Permissions } from '@fw/auth';
import { UploadService } from './upload.service.js';

/** multer 层大小上限：与 @fw/storage 的 STORAGE_MAX_MB 同口径（装饰期静态取 env，运行期业务校验兜底） */
const MULTER_FILE_SIZE = (loadEnv().STORAGE_MAX_MB ?? 20) * 1024 * 1024;

/**
 * 附件上传控制器：/api/v1/files
 */
@Controller('/api/v1/files')
export class UploadController {
  constructor(private readonly uploads: UploadService) {}

  /** 上传附件（multipart，字段名 file） */
  @Permissions('file:create')
  @Post()
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MULTER_FILE_SIZE } }))
  async create(
    @UploadedFile() file: Express.Multer.File | undefined,
    @CurrentUser('id') ownerId: string,
  ): Promise<{ id: string; url: string; originalName: string; size: number; mimeType: string }> {
    if (!file) {
      throw new BizError(ErrorCode.BAD_REQUEST, '请以 multipart/form-data 上传，字段名为 file');
    }
    const row = await this.uploads.save(file, ownerId);
    return { id: row.id, url: `/api/v1/files/${row.id}/download`, originalName: row.originalName, size: row.size, mimeType: row.mimeType };
  }

  /** 元数据 */
  @Get(':id')
  async meta(@Param('id') id: string): Promise<{ id: string; originalName: string; size: number; mimeType: string; createdAt: string }> {
    const row = await this.uploads.getById(id);
    return { id: row.id, originalName: row.originalName, size: row.size, mimeType: row.mimeType, createdAt: row.createdAt.toISOString() };
  }

  /** 下载（登录即可访问；权限点由业务按需收紧） */
  @Get(':id/download')
  async download(@Param('id') id: string, @Res() res: Response): Promise<void> {
    const row = await this.uploads.getById(id);
    const content = await this.uploads.read(row.storedName);
    res.setHeader('Content-Type', row.mimeType);
    // filename* 走 RFC 5987，避免中文文件名在浏览器端乱码
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(row.originalName)}`);
    res.send(content);
  }
}
