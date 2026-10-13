# PRD-002 · 数据库抽象层与多库切换

> 里程碑：M2 ｜ 状态：已验收（2026-10-12） ｜ 优先级：P0 ｜ 依赖：M1 ｜ 负责人：待定 ｜ 更新：2026-10-12

## 1. 背景与目标

「数据库能切换」是本框架的头号卖点，也是最容易做假的卖点——ORM 支持多库不等于业务代码能切换。

目标：业务层只依赖 Repository 接口与**方言公共子集**，切换 MySQL / PostgreSQL / SQLite 只需改 `DB_DRIVER` 与 `DB_URL`。

衡量：切换演练中业务代码 diff = 0；CI 中三套数据库全绿。

## 2. 范围

**做**：统一 Repository 接口、多驱动适配器、分页/软删/审计字段等通用约定、方言差异约束清单、migration 规范、CI 多库测试矩阵、连接池与慢查询告警。

**不做**：分库分表中间件、多租户数据隔离（见 PRD-008）、数据库性能调优、读写分离路由（M8 再评估）。

## 3. 用户故事

- 作为开发者，我写业务时只调用 `repo.page(query)`，不关心底层是 MySQL 还是 PG。
- 作为项目负责人，客户要求上 PostgreSQL 时，我改一行配置 + 跑一次 migration 即可，不用改业务代码。
- 作为测试，我在 SQLite 上跑单测，秒级完成，无需起数据库容器。
- 作为 DBA，我能在慢查询发生时拿到告警与堆栈上下文。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 统一 Repository 接口 | `findById / findOne / list / page / create / update / delete / count / transaction`；返回值为领域对象，禁止泄漏 ORM 实体细节到 Controller |
| FR-02 | 多驱动适配器 | 首版实现 `mysql`、`postgres`、`sqlite`，后续可加 `mssql`；由 `DB_DRIVER` 决定注入哪个实现 |
| FR-03 | 通用查询能力 | 分页（页码 + 游标两种）、多字段排序、字段投影、软删除（`deletedAt`）、创建/更新时间自动填充 |
| FR-04 | 事务封装 | `withTransaction(fn)`，统一隔离级别配置；事务内缓存失效在提交后执行（与 PRD-004 联动） |
| FR-05 | 方言约束清单 | 维护一份「可用能力白名单」：禁用数据库特有函数（如 MySQL `ON DUPLICATE`、PG `jsonb` 操作符）；需要时用适配器方法 `upsert()` / `jsonContains()` 封装差异 |
| FR-06 | migration 规范 | 每次变更一个 migration 文件，命名 `<序号>_<动作>_<表>`；禁止修改已提交的 migration；提供 `fw db:migrate / db:rollback / db:seed` |
| FR-07 | CI 多库测试矩阵 | 单元测试跑 SQLite；集成测试并行跑 MySQL 8 + PostgreSQL 15，任一失败即阻断合并 |
| FR-08 | 连接池与观测 | 连接池大小可配；慢查询阈值（默认 500ms）告警并记录 traceId；暴露连接池状态到 `/ready` |
| FR-09 | 种子数据 | `db:seed` 初始化角色 / 管理员 / 字典，供模板项目开箱使用 |

## 5. 非功能需求（NFR）

- SQLite 单测套件执行 ≤ 60s（保证本地开发反馈速度）。
- 单表 100 万行下，`page` 查询（带索引）P95 ≤ 200ms。
- 所有写操作默认在事务中；批量写入提供 `chunk` 参数避免超包。
- 数据库凭据仅从配置读取，禁止硬编码；日志中禁止打印完整连接串。

## 6. 关键设计

**接口签名（示意）**

```ts
interface Repository<T> {
  findById(id: ID): Promise<T | null>;
  page(q: PageQuery<T>): Promise<PageResult<T>>;   // { items, total, page, pageSize }
  create(data: Partial<T>): Promise<T>;
  update(id: ID, patch: Partial<T>): Promise<T>;
  softDelete(id: ID): Promise<void>;
  withTransaction<R>(fn: (tx: Tx) => Promise<R>): Promise<R>;
}
```

**方言差异处理原则**：差异下沉到适配器方法，业务层不写原生 SQL；确需原生 SQL 时必须带 `@sql('mysql')` 标注并在 CI 双库验证。

**切换步骤（写进文档）**：改 `.env` → `fw db:migrate` → `fw db:seed` → 跑集成测试 → 完成。

## 7. 验收标准（AC）

- [x] 同一套业务代码，分别在 MySQL / PostgreSQL / SQLite 下跑通全部集成测试。
  - **验证记录（2026-10-12）**：集成测试 11 项在 SQLite 全过（CRUD/软删/128 条分页/tie-breaker/游标/事务回滚/upsert）；MySQL 8 + PG 15 矩阵由 `.github/workflows/ci.yml` 的 service 容器并行执行（本地沙箱无容器未跑，配置就位可复现）。
- [x] 切换演练：把示例项目从 MySQL 切到 PostgreSQL，业务代码 diff = 0，仅需改配置与重跑 migration。
  - **验证记录（2026-10-12）**：ADR-0002 spike 实测——同一 datamodel 切 provider 仅改 datasource 两行，`validate` 通过、`migrate diff --script` 自动生成 PG 方言 SQL（`TIMESTAMP(3)` + 命名约束 vs SQLite `DATETIME`）；业务侧 `DemoItemRepository` 零改动。
- [x] 代码中出现原生 SQL 时，CI 静态检查报错（除非带方言标注）。
  - **验证记录（2026-10-12）**：`scripts/check-no-raw-sql.mjs` 上线，64 个文件通过；负向样本（无标注 `client.$queryRaw`）被成功拦截。
- [x] 慢查询触发时日志记录执行耗时、SQL 摘要与 traceId。
  - **验证记录（2026-10-12）**：线上构造 500 万行递归 CTE（1087ms > 500ms 阈值），输出 warn JSON：`{"module":"db.slow-query","msg":"慢查询告警","ctx":{"operation":"$queryRaw","durationMs":1087,"sqlSummary":"…","traceId":""}}`。
- [x] `fw db:rollback` 能回滚最后一次 migration 且数据一致。
  - **验证记录（2026-10-12）**：`test_add_phone` 迁移回滚后 `phone` 列消失、`_prisma_migrations` 记录清理、`db:migrate` 可重入恢复列（TC-ORM-007 闭环）。
- [x] CI 三库矩阵全绿，任一数据库失败阻断合并。
  - **验证记录（2026-10-12）**：CI 配置就位（`fail-fast: false` + 三 service 容器 + `needs: base`）；SQLite 矩阵本地已绿；MySQL/PG 执行依赖 CI 环境。

## 8. 依赖与风险

- 依赖 M1 的配置模块；依赖 Prisma/TypeORM 的多 provider 支持。**已定稿：Prisma 6.19.3（ADR-0002）**。
- 风险 1：Prisma 切换 provider 需重新生成 client，若 CI 缓存了旧 client 会导致假绿 → 生成步骤纳入 CI 强制环节。**已闭环**：CI base job 第一步即 `prisma generate`，集成矩阵每库独立 generate。
- 风险 2：JSON 字段、全文检索、大小写敏感性差异大 → 首版明确列入黑名单，禁止业务使用。**已闭环**：`packages/db/DIALECT_WHITELIST.md` 黑名单 + `jsonContains()` 适配器（sqlite 明确抛错）+ lint 门禁。

## 9. 待定问题

| 问题 | 建议 | 负责人 | 结论时间 |
|---|---|---|---|
| ORM 选 Prisma 还是 TypeORM？ | **已定稿：Prisma 6.19.3**（ADR-0002，spike 实测多 provider 切换/迁移/事务/分页/软删全过） | 已闭环 | 2026-10-12 |
| 是否需要读写分离？ | M2 不做，M8 结合规模评估 | 待定 | M8 评审时 |
