/*
 * @file 演示端点
 * @description M1 验收载体（统一响应/业务异常/未知异常/敏感日志）+ M2 验收载体（Repository CRUD/分页/软删）。
 *   M3 起全局鉴权守卫生效，本控制器整体标 @Public()：它是框架自检路由，不承载业务数据；
 *   需要鉴权的示例见 modules/auth 下的 /users、/roles、/audit-logs。
 * @author donttemo
 * @created 2026-10-13
 * @module demo
 * @since v0.1.0
 * @modified 2026-10-14 donttemo v0.2.0 发布：/demo/ok 自报版本由 v0.1.0 更新为 v0.2.0
 * @modified 2026-10-15 donttemo v0.5.0 发布：自报版本补更至 v0.5.0（v0.3/v0.4 两轮漏更，本次一并收口）
 */
import { Body, Controller, Delete, Get, Param, Patch, Post, Query } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { Logger } from '@fw/logger';
import { Public } from '@fw/auth';
import type { PageResult } from '@fw/db';
import { DemoItemRepository, type DemoItem } from './demo-item.repository.js';

const logger = Logger.for('demo');

/** 创建条目入参 */
interface CreateItemBody {
  title: string;
}

/**
 * 演示控制器：路径前缀 /api/v1/demo（全局标 @Public，避免框架自检路由鉴权耦合）
 */
@Public()
@Controller('/api/v1/demo')
export class DemoController {
  constructor(private readonly items: DemoItemRepository) {}

  /** 正常请求：验证统一响应包装（code=0 + traceId） */
  @Get('ok')
  ok(): { hello: string; framework: string } {
    return { hello: 'fw', framework: 'v0.5.0' };
  }

  /** 业务异常：验证结构化错误码（TC-CORE-004） */
  @Get('biz-error')
  bizError(): never {
    throw new BizError(ErrorCode.BIZ_FAILED, '演示业务异常：库存不足');
  }

  /** 参数级业务异常：验证 details 字段级提示 */
  @Get('biz-error-with-details')
  bizErrorWithDetails(): never {
    throw new BizError(ErrorCode.BAD_REQUEST, '参数错误', [
      { field: 'username', message: '长度需为 3-32' },
    ]);
  }

  /** 未知异常：验证收敛为 9001，不裸抛 500 */
  @Get('boom')
  boom(): never {
    throw new Error('意外错误：演示未知异常收敛');
  }

  /** 敏感日志：验证 password/token 自动脱敏为 ***（TC-CORE-005） */
  @Get('log-sensitive')
  logSensitive(): { logged: boolean } {
    logger.info('用户尝试登录', { username: 'alice', password: 'secret-123', accessToken: 'jwt-abc' });
    return { logged: true };
  }

  // ---------- M2：Repository CRUD（TC-ORM-001/002/004） ----------

  /** 列表分页：/api/v1/demo/items?page=1&pageSize=20 */
  @Get('items')
  listItems(@Query('page') page = '1', @Query('pageSize') pageSize = '20'): Promise<PageResult<DemoItem>> {
    return this.items.pageItems({ page: Number(page), pageSize: Number(pageSize) });
  }

  /** 创建：审计字段由 Repository 自动填充 */
  @Post('items')
  createItem(@Body() body: CreateItemBody): Promise<DemoItem> {
    if (!body?.title) {
      throw new BizError(ErrorCode.BAD_REQUEST, 'title 必填');
    }
    return this.items.create({ title: body.title });
  }

  /** 局部更新：切换完成状态 */
  @Patch('items/:id')
  updateItem(@Param('id') id: string, @Body() body: { done?: boolean }): Promise<DemoItem> {
    if (typeof body.done !== 'boolean') {
      throw new BizError(ErrorCode.BAD_REQUEST, 'done 必填（boolean）');
    }
    return this.items.toggleDone(id, body.done);
  }

  /** 软删除：默认查询不再可见（TC-ORM-004） */
  @Delete('items/:id')
  async deleteItem(@Param('id') id: string): Promise<{ deleted: true }> {
    await this.items.softDelete(id);
    return { deleted: true };
  }
}
