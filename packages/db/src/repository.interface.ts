/*
 * @file Repository 统一接口契约
# @description 业务层唯一数据访问入口：findById/findOne/list/page/create/update/softDelete/count/withTransaction。
#   软删除（deletedAt）与审计字段（createdAt/updatedAt/createdBy/updatedBy）为通用约定；
#   方言差异（分页语法、upsert、JSON 操作）一律下沉适配器方法，业务层禁止写原生 SQL（PRD-002 FR-01/03/04/05）。
# @author donttemo
# @created 2026-10-12
# @module @fw/db

/** 主键类型：字符串 UUID 或数字自增，由各项目 schema 决定 */
export type ID = string | number;

/** 排序方向 */
export type SortDir = 'asc' | 'desc';

/** 排序条件：字段名 → 方向。多字段排序按声明顺序生效 */
export type Sort<T> = Partial<Record<keyof T & string, SortDir>>;

/** 投影：指定返回字段，减少数据传输 */
export type Projection<T> = readonly (keyof T & string)[];

/** 比较操作符（方言公共子集） */
export type FilterOp = 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'in' | 'like';

/** 单字段过滤条件 */
export interface FieldFilter<V = unknown> {
  op: FilterOp;
  value: V;
}

/** 列表查询条件：等值/Object 形式或 FieldFilter 形式均可 */
export type Where<T> = {
  [K in keyof T & string]?: unknown | FieldFilter;
};

/** 通用约定字段：所有表必须带（迁移规范强制） */
export interface BaseEntity {
  /** 主键 */
  id: ID;
  /** 软删时间戳：null = 未删除 */
  deletedAt: Date | null;
  /** 创建时间 */
  createdAt: Date;
  /** 更新时间 */
  updatedAt: Date;
  /** 创建人 ID（由请求上下文注入，系统操作为 'system'） */
  createdBy: ID;
  /** 更新人 ID */
  updatedBy: ID;
}

/** 分页查询（页码模式） */
export interface PageQuery<T> {
  /** 页码，从 1 开始 */
  page: number;
  /** 每页条数，上限 100 */
  pageSize: number;
  /** 过滤条件 */
  where?: Where<T>;
  /** 多字段排序；未传按主键升序（保证 tie-breaker 稳定，TC-ORM-002） */
  sort?: Sort<T>;
  /** 字段投影 */
  select?: Projection<T>;
}

/** 游标查询：深分页场景，避免大 offset */
export interface CursorQuery<T> {
  /** 每页条数 */
  pageSize: number;
  /** 上一页最后一条的游标字段值（排序键） */
  cursor?: ID;
  where?: Where<T>;
  sort?: Sort<T>;
  select?: Projection<T>;
}

/** 分页结果 */
export interface PageResult<T> {
  /** 当前页数据 */
  items: T[];
  /** 总条数（不含软删） */
  total: number;
  /** 当前页码（游标模式下为请求序号，从 1 开始） */
  page: number;
  /** 每页条数 */
  pageSize: number;
  /** 是否有下一页 */
  hasMore: boolean;
}

/** 事务句柄：事务内创建的 Repository 共享同一连接 */
export type Tx = symbol;

/** 事务隔离级别（方言公共子集，适配器负责映射不支持时的降级） */
export type IsolationLevel = 'read-committed' | 'repeatable-read' | 'serializable';

/**
 * 统一 Repository 接口（PRD-002 FR-01，契约冻结版）
 *
 * 实现约定：
 * - 所有查询默认过滤 `deletedAt IS NULL`；`hardDelete` 才物理删除（TC-ORM-004）
 * - create/update 自动填充审计字段（操作人取自 @fw/logger 请求上下文，缺失时 'system'）
 * - 写操作默认在事务中；批量写提供 chunk 参数
 */
export interface Repository<T extends BaseEntity> {
  /** 按主键查询，不存在返回 null */
  findById(id: ID): Promise<T | null>;
  /** 单条件查询，取第一条 */
  findOne(where: Where<T>): Promise<T | null>;
  /** 列表查询（无分页，上限 1000 条） */
  list(where?: Where<T>, sort?: Sort<T>, select?: Projection<T>): Promise<T[]>;
  /** 分页查询（页码模式） */
  page(query: PageQuery<T>): Promise<PageResult<T>>;
  /** 分页查询（游标模式） */
  pageByCursor(query: CursorQuery<T>): Promise<PageResult<T>>;
  /** 创建，返回含审计字段的完整实体 */
  create(data: Partial<T>): Promise<T>;
  /** 局部更新，返回更新后实体 */
  update(id: ID, patch: Partial<T>): Promise<T>;
  /** 软删除：置 deletedAt */
  softDelete(id: ID): Promise<void>;
  /** 物理删除（仅后台/清理场景，业务代码禁用） */
  hardDelete(id: ID): Promise<void>;
  /** 计数（不含软删） */
  count(where?: Where<T>): Promise<number>;
  /**
   * 事务封装：fn 内可继续用同一 repo 实例操作（共享事务连接）
   * 提交后执行缓存失效（与 PRD-004 联动）；fn 抛错整体回滚（TC-ORM-003）
   */
  withTransaction<R>(fn: (tx: Tx) => Promise<R>, isolation?: IsolationLevel): Promise<R>;
}
