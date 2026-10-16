/*
 * @file 附件上传模块（example-api）
 * @description PRD-010 E-09：StorageModule.forRoot() 按 STORAGE_DRIVER 装配存储端口（local/s3），
 *   UploadModule 只承载 /api/v1/files 业务端点与元数据落库。multer 由 @nestjs/platform-express 内置。
 * @author donttemo
 * @created 2026-10-16
 * @module example-api/upload
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
