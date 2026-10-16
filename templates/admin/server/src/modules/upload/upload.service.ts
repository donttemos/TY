/*
 * @file 附件上传服务（admin 模板）
 * @description PRD-010 E-09 收编：文件内容经 @fw/storage 的 StorageService 写入
 *   （类型/大小白名单校验 + `<yyyyMM>/<uuid><ext>` key 生成 + StoragePort 落盘，STORAGE_DRIVER=local/s3 一改即切），
 *   本服务只管 upload_files 元数据行（原始文件名 / 存储 key / MIME / 大小 / 上传人）。
 *   业务接口与 M10 E-08 交付时保持不变（POST /files、GET /files/:id、GET /files/:id/download）。
 * @author donttemo
 * @created 2026-10-15
 * @modified 2026-10-16 donttemo E-09 收编：本地磁盘写盘逻辑平移为 StoragePort local 适配（原 fs 实现 → @fw/storage）
 * @module __APP_NAME__/upload
 */
import { Inject, Injectable } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { DB_CLIENT, type PrismaClientLike } from '@fw/db';
import { StorageService, type StoredFile } from '@fw/storage';

/** 上传文件行类型（与 schema.prisma 的 UploadFile 模型对齐） */
export interface UploadFileRow {
  id: string;
  ownerId: string | null;
  originalName: string;
  storedName: string;
  mimeType: string;
  size: number;
  deletedAt: Date | null;
  createdAt: Date;
}

/** upload_files 模型委托（弱类型访问，与 admin-store 同构） */
interface UploadFileDelegate {
  create: (args: { data: Record<string, unknown> }) => Promise<UploadFileRow>;
  findUnique: (args: { where: { id: string } }) => Promise<UploadFileRow | null>;
}

/**
 * 附件上传服务
 */
@Injectable()
export class UploadService {
  private readonly files: UploadFileDelegate;

  constructor(
    @Inject(DB_CLIENT) db: PrismaClientLike,
    private readonly storage: StorageService,
  ) {
    // PrismaClientLike 是泛化层（不含业务模型）；schema 生成后运行时必然携带 uploadFile 委托
    this.files = (db as unknown as { uploadFile: UploadFileDelegate }).uploadFile;
  }

  /**
   * 保存上传文件：@fw/storage 校验 + 落存储 + 元数据落库
   * @param file multer 内存缓冲（字段名 file）
   * @param ownerId 上传人（登录用户 ID）
   */
  async save(file: { originalname: string; mimetype: string; size: number; buffer: Buffer }, ownerId: string): Promise<UploadFileRow> {
    const stored: StoredFile = await this.storage.save({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
    });
    return this.files.create({
      data: {
        ownerId,
        originalName: stored.originalName,
        storedName: stored.key,
        mimeType: stored.mimeType,
        size: stored.size,
      },
    });
  }

  /** 查元数据（软删视为不存在，不泄露存在性） */
  async getById(id: string): Promise<UploadFileRow> {
    const row = await this.files.findUnique({ where: { id } });
    if (!row || row.deletedAt) throw new BizError(ErrorCode.NOT_FOUND, '文件不存在或已删除');
    return row;
  }

  /** 按 key 读取文件内容（类型/大小白名单与 key 合法性由 @fw/storage 把关） */
  async read(key: string): Promise<Buffer> {
    return this.storage.read(key);
  }
}
