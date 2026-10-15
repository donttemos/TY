/*
 * @file 异步任务端点（N-02）
 * @description 通用任务面：`GET /jobs/:id/progress` 轮询进度、`POST /jobs/:id/retry` 原地重跑、
 *   `GET /jobs/:id/download` 取回产物（文本流，非统一信封）。
 *   鉴权：登录即可（任务归属人校验在控制器内做）——任务面的语义是「我自己的任务」，
 *   不额外要求业务权限码；派发侧（如 /audit-logs/export）才由业务权限码把关。
 *   不存在的任务 / 非归属人一律 404（不泄露存在性）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/jobs
 */

import { Controller, Get, Param, Post, Res } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { CurrentUser } from '@fw/auth';
import type { Response } from 'express';
import { JobCenterService, type JobView } from './job-center.service.js';

/**
 * 异步任务控制器：/api/v1/jobs
 */
@Controller('/api/v1/jobs')
export class JobsController {
  constructor(private readonly jobs: JobCenterService) {}

  /** 任务进度（前端任务条轮询入口） */
  @Get(':id/progress')
  progress(@Param('id') id: string, @CurrentUser('id') ownerId: string): JobView {
    const view = this.jobs.get(id, ownerId);
    if (!view) throw new BizError(ErrorCode.NOT_FOUND, '任务不存在或已过期');
    return view;
  }

  /** 失败任务原地重跑 */
  @Post(':id/retry')
  retry(@Param('id') id: string, @CurrentUser('id') ownerId: string): JobView {
    const { view, reason } = this.jobs.retry(id, ownerId);
    if (!view) throw new BizError(ErrorCode.NOT_FOUND, '任务不存在或已过期');
    if (reason) throw new BizError(ErrorCode.STATE_NOT_ALLOWED, reason);
    return view;
  }

  /**
   * 下载产物
   *
   * 用 `@Res()` 直接写流：统一响应拦截器对 `res.headersSent` 的场景不二次包装，
   * 因此这里能安全地返回裸文本（前端按 Blob 下载，不走信封解包）。
   */
  @Get(':id/download')
  download(@Param('id') id: string, @CurrentUser('id') ownerId: string, @Res() res: Response): void {
    const artifact = this.jobs.artifact(id, ownerId);
    if (!artifact) throw new BizError(ErrorCode.NOT_FOUND, '任务产物不存在或已过期');
    res.setHeader('Content-Type', `${artifact.contentType}; charset=utf-8`);
    // filename* 走 RFC 5987，避免中文文件名在浏览器端乱码
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(artifact.fileName)}`);
    res.send(artifact.content);
  }
}
