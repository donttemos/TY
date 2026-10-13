/*
 * @file Prisma Repository 实现（方言公共子集适配器）
 * @description 实现 repository.interface.ts 冻结的 Repository<T> 契约：
 *   软删过滤、审计字段自动填充、排序 tie-breaker、页码/游标双分页、
 *   交互式事务共享连接、upsert/jsonContains 方言差异下沉。
 *   M8 T-M8-02：注入 TenantDataSource 后，每次调用按请求上下文选路——
 *   dedicated 隔离租户读写独立库 client，shared / 无上下文走默认 client（行为与旧版一致）。
 *   禁止在本类之外出现裸 delegate 调用（TC-ORM-005 由 lint 兜底）。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

import { getRequestContext } from '@fw/logger';
import { BizError, ErrorCode } from '@fw/core';
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
import type { TenantDataSource } from './tenant-datasource.js';

/** 事务标记（接口层只透传不解释） */
const TX_MARKER = Symbol('fw.tx') as unknown as symbol;

/** 系统操作者标识（无请求上下文时的审计字段值） */
const SYSTEM_OPERATOR = 'system';

/** 列表查询默认上限 */
const LIST_MAX = 1000;

/** 单页条数上限 */
const PAGE_SIZE_MAX = 100;
const MAX_TENANT_ID = 9223372036854775807n;

export interface PrismaRepositoryOptions {
  /** Enable shared-table tenant enforcement for a model with tenantId. */
  tenantScoped?: boolean;
  /**
   * 租户数据源路由（M8 T-M8-02，PRD-008 FR-02）：dedicated 隔离租户的查询按请求上下文
   * 路由到独立库 client；shared / 无上下文回退构造时注入的默认 client（行为与本选项缺省一致）。
   */
  dataSource?: TenantDataSource;
}

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
  /** 事务期间覆盖当前委托：指向 tx 内的同名委托，保证事务内操作共享连接 */
  private delegateOverride: ModelDelegate | null = null;

  /**
   * @param client Prisma Client（或事务内的 tx client）
   * @param modelName 模型名（schema 中的 model 名，小写开头）
   */
  constructor(
    private readonly client: PrismaClientLike,
    private readonly modelName: string,
    private readonly options: PrismaRepositoryOptions = {},
  ) {}

  /**
   * 当前请求应使用的 client（M8 T-M8-02）：注入了 dataSource 时按上下文选路
   * （dedicated 租户 → 独立库 client，其余 → 默认 client）；未注入时恒为默认 client。
   */
  private async currentClient(): Promise<PrismaClientLike> {
    return this.options.dataSource ? this.options.dataSource.resolve() : this.client;
  }

  /** 当前生效的模型委托：事务期间指向 tx 内的委托，否则按当前 client 取 */
  private async currentDelegate(): Promise<ModelDelegate> {
    if (this.delegateOverride) return this.delegateOverride;
    const client = await this.currentClient();
    return client[this.modelName] as ModelDelegate;
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

  private tenantWhere(): Record<string, bigint> {
    if (!this.options.tenantScoped) return {};
    const context = getRequestContext();
    if (context?.ignoreTenant === true) return {};
    const tenantId = context?.tenantId;
    if (!context?.tenantVerified || !tenantId || !/^[1-9][0-9]*$/.test(tenantId) || BigInt(tenantId) > MAX_TENANT_ID) {
      throw new BizError(ErrorCode.TENANT_INVALID, '缺失有效租户上下文');
    }
    return { tenantId: BigInt(tenantId) };
  }

  /** 组装 where：调用方条件 + deletedAt IS NULL */
  private withSoftDelete(where?: Where<T>): Record<string, unknown> {
    return { ...(where ?? {}), ...this.notDeleted(), ...this.tenantWhere() };
  }

  /** 排序追加主键 tie-breaker，保证分页稳定（TC-ORM-002） */
  private withTieBreaker(sort?: Sort<T>): Record<string, string>[] {
    const entries = Object.entries(sort ?? {}) as [string, string][];
    return [...entries.map(([field, dir]) => ({ [field]: dir })), { id: 'asc' }];
  }

  // ---------- 读 ----------

  async findById(id: ID): Promise<T | null> {
    const delegate = await this.currentDelegate();
    const row = await delegate.findUnique({ where: { id, ...this.notDeleted(), ...this.tenantWhere() } });
    return row as T | null;
  }

  async findOne(where: Where<T>): Promise<T | null> {
    const delegate = await this.currentDelegate();
    const row = await delegate.findFirst({ where: this.withSoftDelete(where) });
    return row as T | null;
  }

  async list(where?: Where<T>, sort?: Sort<T>, select?: readonly string[]): Promise<T[]> {
    const delegate = await this.currentDelegate();
    const rows = await delegate.findMany({
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
    const delegate = await this.currentDelegate();

    // count 与 findMany 并行，减少一轮 RTT
    const [rows, total] = await Promise.all([
      delegate.findMany({
        where,
        orderBy,
        skip: (page - 1) * pageSize,
        take: pageSize,
        ...(query.select ? { select: this.buildSelect(query.select) } : {}),
      }),
      delegate.count({ where }),
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
    const delegate = await this.currentDelegate();
    const rows = (await delegate.findMany({
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
    const tenant = this.tenantWhere();
    const delegate = await this.currentDelegate();
    const row = await delegate.create({
      data: { ...data, ...tenant, createdBy: this.operator(), updatedBy: this.operator() },
    });
    return row as T;
  }

  async update(id: ID, patch: Partial<T>): Promise<T> {
    const tenant = this.tenantWhere();
    const delegate = await this.currentDelegate();
    const row = await delegate.update({
      where: { id, ...tenant },
      data: { ...patch, ...tenant, updatedBy: this.operator() },
    });
    return row as T;
  }

  async softDelete(id: ID): Promise<void> {
    const delegate = await this.currentDelegate();
    await delegate.update({
      where: { id, ...this.tenantWhere() },
      data: { deletedAt: new Date(), updatedBy: this.operator() },
    });
  }

  async hardDelete(id: ID): Promise<void> {
    const delegate = await this.currentDelegate();
    await delegate.delete({ where: { id, ...this.tenantWhere() } });
  }

  async count(where?: Where<T>): Promise<number> {
    const delegate = await this.currentDelegate();
    return delegate.count({ where: this.withSoftDelete(where) });
  }

  // ---------- 事务 ----------

  async withTransaction<R>(
    fn: (tx: symbol) => Promise<R>,
    isolation?: IsolationLevel,
  ): Promise<R> {
    // 选路一次：事务内所有操作共享该 client 的连接（dedicated 租户事务天然落在同一独立库内）
    const client = await this.currentClient();
    const options = isolation ? { isolationLevel: ISOLATION_MAP[isolation] } : undefined;
    return client.$transaction(
      async (tx) => {
        // 事务内把委托切到 tx 的同名委托：fn 内的所有读写共享同一连接
        const outer = this.delegateOverride;
        this.delegateOverride = tx[this.modelName];
        try {
          return await fn(TX_MARKER);
        } finally {
          this.delegateOverride = outer;
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
    const tenant = this.tenantWhere();
    const delegate = await this.currentDelegate();
    const row = await delegate.upsert({
      where: { ...where, ...tenant },
      create: { ...create, ...tenant, createdBy: this.operator(), updatedBy: this.operator() },
      update: { ...update, ...tenant, updatedBy: this.operator() },
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
    if (this.options.tenantScoped) {
      this.tenantWhere();
      throw new BizError(ErrorCode.TENANT_INVALID, '租户模型暂不支持原生 JSON 查询');
    }
    this.assertIdent(this.tableName());
    this.assertIdent(field);
    if (driver === 'sqlite') {
      throw new Error('jsonContains 在 SQLite 驱动下不支持：请改用 PostgreSQL/MySQL，或在方言白名单内换适配器方法');
    }
    if (driver === 'postgresql') {
      // PG jsonb @> 操作符：${} 插值由 Prisma 自动参数化
      const client = await this.currentClient();
      const rows = await client.$queryRaw`SELECT * FROM "${this.tableName()}" WHERE "${field}" @> ${JSON.stringify(value)}::jsonb AND "deleted_at" IS NULL`;
      return rows as T[];
    }
    // MySQL JSON_CONTAINS
    const client = await this.currentClient();
    const rows = await client.$queryRaw`SELECT * FROM \`${this.tableName()}\` WHERE JSON_CONTAINS(\`${field}\`, ${JSON.stringify(value)}) AND \`deleted_at\` IS NULL`;
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
