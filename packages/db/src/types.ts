/*
 * @file Prisma 结构类型（框架侧最小依赖）
 * @description @fw/db 不依赖具体生成的 Prisma Client 类型（那是业务 schema 的产物），
 *   只依赖此处声名的结构子集。业务项目通过泛型传入强类型实体。
 * @author donttemo
 * @created 2026-10-12
 * @module @fw/db
 */

/** Prisma 模型委托（findMany/create/update 等）的结构最小集 */
export interface ModelDelegate {
  findUnique(args: unknown): Promise<unknown>;
  findFirst(args: unknown): Promise<unknown>;
  findMany(args: unknown): Promise<unknown>;
  create(args: unknown): Promise<unknown>;
  update(args: unknown): Promise<unknown>;
  updateMany(args: unknown): Promise<{ count: number }>;
  delete(args: unknown): Promise<unknown>;
  deleteMany(args: unknown): Promise<{ count: number }>;
  upsert(args: unknown): Promise<unknown>;
  count(args?: unknown): Promise<number>;
}

/** Prisma Client 结构最小集：按模型名取委托 + 交互式事务 */
export interface PrismaClientLike {
  [modelName: string]: unknown;
  $transaction<R>(
    fn: (tx: Record<string, ModelDelegate>) => Promise<R>,
    options?: { isolationLevel?: string },
  ): Promise<R>;
  $queryRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<unknown>;
  $executeRaw(query: TemplateStringsArray, ...values: unknown[]): Promise<number>;
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $on(event: string, cb: (payload: unknown) => void): void;
  $extends(extensions: unknown): PrismaClientLike;
}

/** 交互式事务句柄：按模型名取该事务内的委托 */
export type TxClient = Record<string, ModelDelegate>;

/** 隔离级别：Prisma 枚举值映射 */
export const ISOLATION_MAP: Record<string, string> = {
  'read-committed': 'ReadCommitted',
  'repeatable-read': 'RepeatableRead',
  serializable: 'Serializable',
};
