/*
 * @file dedicated 租户路由验证端点（M8 T-M8-02，PRD-008 FR-02 / TC-TNT-003）
 * @description 与整体 @Public 的 DemoController 不同，本控制器走全局鉴权守卫：
 *   守卫在确认「登录用户归属当前租户」后才写 tenantVerified，Repository 的
 *   TenantDataSource 据此把 dedicated 租户的查询路由到独立库（未认证请求
 *   一律回退共享库，fail-closed 语义由守卫与 Repository 的 tenantWhere 保证）。
 *   本端点仅用于冒烟与联调验证独立库物理隔离，不承载生产业务。
 * @author donttemo
 * @created 2026-10-14
 * @module demo
 */
import { Body, Controller, Get, Post, Query } from '@nestjs/common';
import type { PageResult } from '@fw/db';
import { DemoItemRepository, type DemoItem } from './demo-item.repository.js';

/** 创建条目入参 */
interface CreateItemBody {
  title: string;
}

/**
 * 租户路由验证控制器：路径前缀 /api/v1/demo/tenant-items（需登录 + 租户上下文）
 */
@Controller('/api/v1/demo/tenant-items')
export class DemoTenantItemsController {
  constructor(private readonly items: DemoItemRepository) {}

  /** 列表分页：dedicated 租户的查询只返回其独立库内的数据 */
  @Get()
  listItems(@Query('page') page = '1', @Query('pageSize') pageSize = '20'): Promise<PageResult<DemoItem>> {
    return this.items.pageItems({ page: Number(page), pageSize: Number(pageSize) });
  }

  /** 创建：dedicated 租户的写入落在其独立库 */
  @Post()
  createItem(@Body() body: CreateItemBody): Promise<DemoItem> {
    return this.items.create({ title: body.title });
  }
}
