/*
 * @file 菜单维护端点（C-06 前端 API 契约 §3.5 / PRD-003 FR-09）
 * @description /api/v1/menus：菜单树查询（管理页自行渲染树）与菜单维护 CRUD。
 *   与 /api/v1/auth/menus 的分工：后者是「当前用户可见菜单树」（按权限码过滤，供动态路由），
 *   前者是「全量菜单扁平列表」（管理页配置用，不过滤）。删除菜单时若有子菜单一律拒绝，
 *   避免出现父菜单消失而子菜单悬空（前端动态路由会丢失层级）。
 * @author donttemo
 * @created 2026-10-14
 * @module __APP_NAME__/admin
 */

import { Body, Controller, Delete, Get, Inject, Param, Post, Put } from '@nestjs/common';
import { BizError, ErrorCode } from '@fw/core';
import { AUTH_STORE, PERM, Permissions, type AuthMenu, type AuthStore } from '@fw/auth';
import { ADMIN_STORE } from './admin-store.js';
import type { AdminStore, MenuUpsertInput } from './admin-store.js';

/**
 * 菜单维护控制器：/api/v1/menus
 */
@Controller('/api/v1/menus')
export class MenusController {
  constructor(
    @Inject(AUTH_STORE) private readonly store: AuthStore,
    @Inject(ADMIN_STORE) private readonly admin: AdminStore,
  ) {}

  /** 全量菜单（扁平列表，管理页自行渲染树） */
  @Permissions(PERM.MENU_READ)
  @Get('tree')
  async tree(): Promise<AuthMenu[]> {
    return this.store.listMenus();
  }

  /** 新建菜单（parentId 缺省 '0' 为顶级） */
  @Permissions(PERM.MENU_CREATE)
  @Post()
  async create(@Body() body: MenuUpsertInput): Promise<AuthMenu> {
    return this.admin.createMenu(body);
  }

  /** 更新菜单 */
  @Permissions(PERM.MENU_UPDATE)
  @Put(':id')
  async update(@Param('id') id: string, @Body() body: MenuUpsertInput): Promise<AuthMenu> {
    return this.admin.updateMenu(id, body);
  }

  /** 删除菜单（有子菜单时拒绝，先删子级） */
  @Permissions(PERM.MENU_DELETE)
  @Delete(':id')
  async remove(@Param('id') id: string): Promise<{ id: string }> {
    const children = await this.admin.countChildMenus(id);
    if (children > 0) {
      throw new BizError(ErrorCode.STATE_NOT_ALLOWED, `该菜单下仍有 ${children} 个子菜单，请先删除子级`);
    }
    await this.admin.deleteMenu(id);
    return { id };
  }
}
