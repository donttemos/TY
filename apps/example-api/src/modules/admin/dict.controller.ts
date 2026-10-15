/*
 * @file 字典端点（C-06 前端 API 契约 §3.6 / PRD-005 FR-07）
 * @description /api/v1/dict：分类维护 + 字典项维护 + GET /dict/:code（useDict 消费入口）。
 *   设计目的：页面不硬编码枚举，字典由后台维护、前端按编码消费，改词不用发版。
 *   路由顺序：静态段（categories / items）必须先于动态段（:code）注册，否则 :code 会吞掉静态路径。
 * @author donttemo
 * @created 2026-10-14
 * @modified 2026-10-15 donttemo BUG-15 增量：GET /dict/categories 与 GET /dict/items 接入排序白名单
 *   （parseSortQuery，未知字段 / 非法方向 / 超上限一律 400/1001；白名单只收视图可见字段）
 * @module example-api/admin
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put, Query } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { PERM, Permissions } from '@fw/auth';
import { parseSortQuery } from '@fw/db';
import { ADMIN_STORE } from './admin-store.js';
import type {
  AdminStore,
  DictCategoryUpsertInput,
  DictCategoryView,
  DictItemUpsertInput,
  DictItemView,
} from './admin-store.js';

/** Prisma 唯一约束冲突错误码 */
const PRISMA_UNIQUE_VIOLATION = 'P2002';

/** GET /dict/categories 排序白名单（BUG-15 增量）——只收视图可见字段（DictCategoryView 无 createdAt） */
const DICT_CATEGORY_SORT_FIELDS = {
  id: 'id',
  code: 'code',
  name: 'name',
  remark: 'remark',
} as const;

/** GET /dict/items 排序白名单（DictItemView 无 createdAt，color 排序无业务意义） */
const DICT_ITEM_SORT_FIELDS = {
  id: 'id',
  label: 'label',
  value: 'value',
  sort: 'sort',
} as const;

/**
 * 字典控制器：/api/v1/dict
 */
@Controller('/api/v1/dict')
export class DictController {
  constructor(@Inject(ADMIN_STORE) private readonly admin: AdminStore) {}

  /** 分类列表（sort 经白名单解析，非法即 400） */
  @Permissions(PERM.DICT_READ)
  @Get('categories')
  async categories(@Query('sort') sort?: string): Promise<DictCategoryView[]> {
    return this.admin.listDictCategories(parseSortQuery<DictCategoryView>(sort, DICT_CATEGORY_SORT_FIELDS));
  }

  /** 新建分类（编码唯一，冲突 409） */
  @Permissions(PERM.DICT_WRITE)
  @Post('categories')
  async createCategory(@Body() body: DictCategoryUpsertInput): Promise<DictCategoryView> {
    try {
      return await this.admin.createDictCategory(body);
    } catch (error) {
      throw this.conflict(error, '分类编码已存在');
    }
  }

  /** 更新分类（code 不可改，改编码等于另建一个字典） */
  @Permissions(PERM.DICT_WRITE)
  @Put('categories/:id')
  async updateCategory(
    @Param('id') id: string,
    @Body() body: Partial<DictCategoryUpsertInput>,
  ): Promise<DictCategoryView> {
    return this.admin.updateDictCategory(id, body);
  }

  /** 删除分类（连带删除其下字典项） */
  @Permissions(PERM.DICT_WRITE)
  @Delete('categories/:id')
  async deleteCategory(@Param('id') id: string): Promise<{ id: string }> {
    await this.admin.deleteDictCategory(id);
    return { id };
  }

  /** 字典项列表（按分类；sort 经白名单解析，非法即 400） */
  @Permissions(PERM.DICT_READ)
  @Get('items')
  async items(@Query('category_id') categoryId: string, @Query('sort') sort?: string): Promise<DictItemView[]> {
    if (!categoryId) throw new BizError(ErrorCode.BAD_REQUEST, 'category_id 必填');
    return this.admin.listDictItems(categoryId, parseSortQuery<DictItemView>(sort, DICT_ITEM_SORT_FIELDS));
  }

  /** 新建字典项 */
  @Permissions(PERM.DICT_WRITE)
  @Post('items')
  async createItem(@Body() body: DictItemUpsertInput & { categoryId?: string }): Promise<DictItemView> {
    if (!body?.categoryId) throw new BizError(ErrorCode.BAD_REQUEST, 'categoryId 必填');
    try {
      return await this.admin.createDictItem(body.categoryId, body);
    } catch (error) {
      throw this.conflict(error, '同分类下字典值已存在');
    }
  }

  /** 更新字典项 */
  @Permissions(PERM.DICT_WRITE)
  @Put('items/:id')
  async updateItem(@Param('id') id: string, @Body() body: Partial<DictItemUpsertInput>): Promise<DictItemView> {
    return this.admin.updateDictItem(id, body);
  }

  /** 删除字典项 */
  @Permissions(PERM.DICT_WRITE)
  @Delete('items/:id')
  async deleteItem(@Param('id') id: string): Promise<{ id: string }> {
    await this.admin.deleteDictItem(id);
    return { id };
  }

  /** 按分类编码取字典项（useDict / DictSelect / StatusTag 消费入口；编码不存在返回空数组而非报错） */
  @Permissions(PERM.DICT_READ)
  @Get(':code')
  async byCode(@Param('code') code: string): Promise<DictItemView[]> {
    return this.admin.listDictItemsByCode(code);
  }

  /** 唯一约束冲突转业务 409（其余原样抛出，交由全局异常过滤） */
  private conflict(error: unknown, message: string): unknown {
    if (error && typeof error === 'object' && (error as { code?: string }).code === PRISMA_UNIQUE_VIOLATION) {
      return new BizError(ErrorCode.CONFLICT, message);
    }
    return error;
  }
}
