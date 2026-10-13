/*
 * @file Prisma Repository 实现（方言公共子集适配器）
 * @description 实现 repository.interface.ts 冻结的 Repository<T> 契约：
 *   软删过滤、审计字段自动填充、排序 tie-breaker、页码/游标双分页、
 *   交互式事务共享连接、upsert/jsonContains 方言差异下沉。
 *   禁止在本类之外出现裸 delegate 调用（TC-ORM-005 由 lint 兜底）。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { getRequestContext } from '@fw/logger';
import type {
  BaseEntity,
  CursorQuery,
  ID,
  IsolationLevel,
  PageQuery,
  PageResult,
  Repository,
  Sort,
  Where,
} from './repository.interface.js';
import { ISOLATION_MAP, type ModelDelegate, type PrismaClientLike } from './types.js';

/** 事务标记（接口层只透传不解释） */
const TX_MARKER = Symbol('fw.tx') as unknown as symbol;

/** 系统操作者标识（无请求上下文时的审计字段值） */
const SYSTEM_OPERATOR = 'system';

/** 列表查询默认上限 */
const LIST_MAX = 1000;

/** 单页条数上限 */
const PAGE_SIZE_MAX = 100;

/**
 * 基于 Prisma 的 Repository 实现
 *
 * 用法：业务项目为每个模型继承本类并绑定 modelName：
 * ```ts
 * export class UserRepository extends PrismaRepository<User> {
 *   constructor(client: PrismaClientLike) { super(client, 'user'); }
 * }
 * ```
 *
 * 事务约束：同一实例不可并发进入两个 withTransaction（内部切换 delegate 非线程安全）；
 * 并发事务场景请各自 new 实例。
 */
export class PrismaRepository<T extends BaseEntity> implements Repository<T> {
  /** 当前生效的模型委托：事务期间指向 tx 内的委托，保证事务内操作共享连接 */
  private delegate: ModelDelegate;

  /**
   * @param client Prisma Client（或事务内的 tx client）
   * @param modelName 模型名（schema 中的 model 名，小写开头）
   */
  constructor(
    private readonly client: PrismaClientLike,
    private readonly modelName: string,
  ) {
    this.delegate = client[modelName] as ModelDelegate;
  }

  /** 取操作人：优先请求上下文 userId，缺失 'system' */
  private operator(): ID {
    const ctx = getRequestContext();
    const userId = ctx?.userId;
    return typeof userId === 'string' || typeof userId === 'number' ? userId : SYSTEM_OPERATOR;
  }

  /** 所有查询强制追加软删过滤（hardDelete 除外） */
  private notDeleted(): { deletedAt: null } {
    return { deletedAt: null };
  }

  /** 组装 where：调用方条件 + deletedAt IS NULL */
  private withSoftDelete(where?: Where<T>): Record<string, unknown> {
    return { ...(where ?? {}), ...this.notDeleted() };
  }

  /** 排序追加主键 tie-breaker，保证分页稳定（TC-ORM-002） */
  private withTieBreaker(sort?: Sort<T>): Record<string, string>[] {
    const entries = Object.entries(sort ?? {}) as [string, string][];
    return [...entries.map(([field, dir]) => ({ [field]: dir })), { id: 'asc' }];
  }

  // ---------- 读 ----------

  async findById(id: ID): Promise<T | null> {
    const row = await this.delegate.findUnique({ where: { id, ...this.notDeleted() } });
    return row as T | null;
  }

  async findOne(where: Where<T>): Promise<T | null> {
    const row = await this.delegate.findFirst({ where: this.withSoftDelete(where) });
    return row as T | null;
  }

  async list(where?: Where<T>, sort?: Sort<T>, select?: readonly string[]): Promise<T[]> {
    const rows = await this.delegate.findMany({
      where: this.withSoftDelete(where),
      orderBy: this.withTieBreaker(sort),
      take: LIST_MAX,
      ...(select ? { select: this.buildSelect(select) } : {}),
    });
    return rows as T[];
  }

  async page(query: PageQuery<T>): Promise<PageResult<T>> {
    const page = Math.max(1, Math.floor(query.page));
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    const where = this.withSoftDelete(query.where);
    const orderBy = this.withTieBreaker(query.sort);

    // count 与 findMany 并行，减少一轮 RTT
    const [rows, total] = await Promise.all([
      this.delegate.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        ...(query.select ? { select: this.buildSelect(query.select) } : {}),
      }),
      this.delegate.count({ where }),
    ]);

    return {
      items: rows as T[],
      total,
      page,
      pageSize,
      hasMore: page * pageSize < total,
    };
  }

  async pageByCursor(query: CursorQuery<T>): Promise<PageResult<T>> {
    const pageSize = Math.min(PAGE_SIZE_MAX, Math.max(1, Math.floor(query.pageSize)));
    const where = this.withSoftDelete(query.where);
    // 多取一条探 hasMore，避免全量 count
    const rows = (await this.delegate.findMany({
      where: query.cursor !== undefined ? { ...where, id: { gt: query.cursor } } : where,
      orderBy: this.withTieBreaker(query.sort),
      take: pageSize + 1,
      ...(query.select ? { select: this.buildSelect(query.select) } : {}),
    })) as T[];

    const hasMore = rows.length > pageSize;
    const items = hasMore ? rows.slice(0, pageSize) : rows;
    return {
      items,
      total: -1, // 游标模式不返回全量 total（深分页 count 成本高），调用方按需另查
      page: 1,
      pageSize,
      hasMore,
    };
  }

  // ---------- 写 ----------

  async create(data: Partial<T>): Promise<T> {
    const row = await this.delegate.create({
      data: { ...data, createdBy: this.operator(), updatedBy: this.operator() },
    });
    return row as T;
  }

  async update(id: ID, patch: Partial<T>): Promise<T> {
    const row = await this.delegate.update({
      where: { id },
      data: { ...patch, updatedBy: this.operator() },
    });
    return row as T;
  }

  async softDelete(id: ID): Promise<void> {
    await this.delegate.update({
      where: { id },
      data: { deletedAt: new Date(), updatedBy: this.operator() },
    });
  }

  async hardDelete(id: ID): Promise<void> {
    await this.delegate.delete({ where: { id } });
  }

  async count(where?: Where<T>): Promise<number> {
    return this.delegate.count({ where: this.withSoftDelete(where) });
  }

  // ---------- 事务 ----------

  async withTransaction<R>(
    fn: (tx: symbol) => Promise<R>,
    isolation?: IsolationLevel,
  ): Promise<R> {
    const options = isolation ? { isolationLevel: ISOLATION_MAP[isolation] } : undefined;
    return this.client.$transaction(
      async (tx) => {
        // 事务内把 delegate 切到 tx 的同名委托：fn 内的所有读写共享同一连接
        const outer = this.delegate;
        this.delegate = tx[this.modelName];
        try {
          return await fn(TX_MARKER);
        } finally {
          this.delegate = outer;
        }
      },
      options as { isolationLevel?: string } | undefined,
    );
  }

  // ---------- 方言差异适配（PRD-002 FR-05：差异下沉，业务层不写原生 SQL） ----------

  /**
   * upsert：三库均支持，但 MySQL 走 ON DUPLICATE / PG 走 ON CONFLICT / SQLite 走 INSERT OR CONFLICT，
   * 由 Prisma client 自动映射，业务层零差异调用
   */
  async upsert(where: Record<string, unknown>, create: Partial<T>, update: Partial<T>): Promise<T> {
    const row = await this.delegate.upsert({
      where,
      create: { ...create, createdBy: this.operator(), updatedBy: this.operator() },
      update: { ...update, updatedBy: this.operator() },
    });
    return row as T;
  }

  /** SQL 标识符白名单：表名/字段名只允许字母数字下划线（防注入） */
  private assertIdent(name: string): void {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
      throw new Error(`非法 SQL 标识符: ${name}`);
    }
  }

  /**
   * JSON 字段包含查询：三库语法差异大（MySQL JSON_CONTAINS / PG @> / SQLite 不支持），
   * 统一在本方法内分支，业务层禁止直接写 json 路径过滤。
   * 标识符（表名/字段名）经 assertIdent 白名单校验；值一律走参数化插值。
   * @param driver 当前数据库驱动（由 DbModule 注入时确定）
   */
  async jsonContains(
    driver: 'mysql' | 'postgresql' | 'sqlite',
    field: string,
    value: unknown,
  ): Promise<T[]> {
    this.assertIdent(this.tableName());
    this.assertIdent(field);
    if (driver === 'sqlite') {
      throw new Error('jsonContains 在 SQLite 驱动下不支持：请改用 PostgreSQL/MySQL，或在方言白名单内换适配器方法');
    }
    if (driver === 'postgresql') {
      // PG jsonb @> 操作符：${} 插值由 Prisma 自动参数化
      const rows = await this.client.$queryRaw`SELECT * FROM "${this.tableName()}" WHERE "${field}" @> ${JSON.stringify(value)}::jsonb AND "deleted_at" IS NULL`;
      return rows as T[];
    }
    // MySQL JSON_CONTAINS
    const rows = await this.client.$queryRaw`SELECT * FROM \`${this.tableName()}\` WHERE JSON_CONTAINS(\`${field}\`, ${JSON.stringify(value)}) AND \`deleted_at\` IS NULL`;
    return rows as T[];
  }

  // ---------- 内部工具 ----------

  /** 模型名 → 表名：Prisma 默认映射（model User → user），schema 可 @@map 覆盖，此处按约定小写 */
  private tableName(): string {
    return this.modelName;
  }

  /** 组装 select：字段数组 → Prisma select 对象 */
  private buildSelect(select: readonly string[]): Record<string, true> {
    return Object.fromEntries(select.map((f) => [f, true]));
  }
}
