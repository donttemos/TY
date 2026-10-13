# @file 方言能力白名单（数据库可切换的宪法）
# @description 业务层只允许使用三库公共子集能力；特有函数/语法必须下沉到 @fw/db 适配器方法。
#   静态检查由 scripts/check-no-raw-sql.mjs 强制：无 @sql('<dialect>') 标注的 $queryRaw/$executeRaw 直接失败（TC-ORM-005）。
# @author donttemo
# @created 2026-10-12
# @module @fw/db

# ============ 公共子集（业务层可直接用，三库行为一致） ============

| 能力 | Repository 方法 | 说明 |
|---|---|---|
| 等值/范围/IN/LIKE 过滤 | `findById` / `findOne` / `list` / `page` 的 where | `FilterOp` 六操作符 |
| 多字段排序 | sort 参数 | 自动追加 `id` tie-breaker |
| 分页 | `page`（页码）/ `pageByCursor`（游标） | 页码模式 `LIMIT/OFFSET`；游标模式 `id > cursor` |
| 软删除 | `softDelete` / 默认查询过滤 | `deletedAt IS NULL` 由实现强制 |
| 物理删除 | `hardDelete` | 仅后台/清理场景 |
| 插入/局部更新 | `create` / `update` | 审计字段自动填充 |
| 计数 | `count` | 不含软删 |
| upsert | `upsert` | Prisma 自动映射 ON DUPLICATE / ON CONFLICT / INSERT OR CONFLICT |
| JSON 包含查询 | `jsonContains` | mysql→JSON_CONTAINS、pg→@>、sqlite→抛错 |
| 事务 | `withTransaction` | 隔离级别三档公共子集 |

# ============ 黑名单（业务层禁用，CI 拦截） ============

| 禁用项 | 原因 | 替代 |
|---|---|---|
| `ON DUPLICATE KEY UPDATE` 直写 | MySQL 独有 | `repo.upsert()` |
| `ON CONFLICT ... DO UPDATE` 直写 | PG 独有 | `repo.upsert()` |
| `INSERT OR REPLACE/IGNORE` | SQLite 独有 | `repo.upsert()` |
| jsonb 操作符（`@>` `?` `->` `->>`） | PG 独有且强类型 | `repo.jsonContains()`，PG 侧实现 |
| `JSON_CONTAINS` / `JSON_EXTRACT` | MySQL 独有 | `repo.jsonContains()`，MySQL 侧实现 |
| `LIMIT n, m` 语法 | MySQL 逗号语法 | `LIMIT m OFFSET n`（Prisma 统一） |
| `IFNULL()` / `ISNULL()` / `NVL()` | 各库空值函数不同 | 应用层 `??` |
| 全文检索（MATCH/AGAINST、to_tsvector） | 三库语法完全不同 | M8 搜索引擎抽象 |
| 窗口函数 | SQLite 版本支持不一 | 应用层计算或 `@sql` 标注 + 双库验证 |
| 存储过程 / 触发器 | 迁移与回滚不可移植 | 应用层逻辑 |
| 大小写敏感依赖（LIKE 'ABC' 语义） | MySQL 默认不敏感、PG 敏感 | 应用层统一大小写或 citext |
| 自增主键依赖（AUTO_INCREMENT/SERIAL/rowid） | 主键策略应统一 UUID | schema 用 `@default(uuid())` |

# ============ 逃逸口（确需原生 SQL 时） ============

1. 仅在 `@fw/db` 适配器方法内使用 `$queryRaw` / `$executeRaw`（已封装方言分支）。
2. 业务代码确需原生 SQL：调用处上方 3 行内加标注
   ```ts
   // @sql('mysql','postgresql') 批量对账：窗口函数三库语法不一，仅这两库运行
   const rows = await client.$queryRaw`SELECT ...`;
   ```
3. 标注后仍受 CI 约束：必须在 MySQL 与 PG 两个集成环境验证通过（T-M2-07 矩阵）。
4. 值一律参数化插值（`${value}`），标识符必须过白名单正则（`^[A-Za-z_][A-Za-z0-9_]*$`）。
