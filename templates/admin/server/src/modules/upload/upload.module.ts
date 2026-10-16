/*
 * @file 附件上传模块（admin 模板）
 * @description PRD-010 E-09 收编：StorageModule.forRoot() 按 STORAGE_DRIVER 装配存储端口（local/s3），
 *   UploadModule 只承载 /api/v1/files 业务端点与 upload_files 元数据落库。
 *   multer 由 @nestjs/platform-express 内置（Express 5 携带 2.4.0）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-16 donttemo E-09 收编：本地磁盘实现平移到 @fw/storage（原服务内 fs 逻辑删除）
 * @module __APP_NAME__/upload
 */
import { Module } from '@nestjs/common';
import { StorageModule } from '@fw/storage';
import { UploadController } from './upload.controller.js';
import { UploadService } from './upload.service.js';

/**
 * 附件上传模块
 */
@Module({
  imports: [StorageModule.forRoot()],
  controllers: [UploadController],
  providers: [UploadService],
  exports: [UploadService],
})
export class UploadModule {}
