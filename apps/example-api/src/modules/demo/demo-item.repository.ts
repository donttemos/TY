/*
 * @file 演示条目 Repository
 * @description M2 验收载体：演示业务 Repository 只依赖 @fw/db 的 PrismaRepository 基类，
 *   全部查询走公共子集（软删过滤/审计填充/tie-breaker 由基类保证），
 *   切换 MySQL/PG 时本文件零改动（TC-ORM-008 的 diff=0 证明）。
 * @author donttemo
 * @created 2026-10-12
 * @module demo
 */
import { Inject, Injectable } from '@nestjs/common';
import { PrismaRepository, DB_CLIENT, type PrismaClientLike } from '@fw/db';
import type { BaseEntity, PageQuery, PageResult } from '@fw/db';

/** 演示条目实体（与 prisma/schema.prisma 的 DemoItem 对齐） */
export interface DemoItem extends BaseEntity {
  title: string;
  done: boolean;
}

/**
 * 演示条目数据访问：业务方法只表达意图，方言细节全部在基类
 */
@Injectable()
export class DemoItemRepository extends PrismaRepository<DemoItem> {
  constructor(@Inject(DB_CLIENT) client: PrismaClientLike) {
    super(client, 'demoItem');
  }

  /** 分页查询（页码模式） */
  pageItems(query: PageQuery<DemoItem>): Promise<PageResult<DemoItem>> {
    return this.page(query);
  }

  /** 切换状态 */
  toggleDone(id: string, done: boolean): Promise<DemoItem> {
    return this.update(id, { done });
  }
}
