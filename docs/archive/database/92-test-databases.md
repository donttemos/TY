<!--
@file docs/archive/database/92-test-databases.md
@description 远程共用测试数据库（MySQL / PostgreSQL / Redis）连接信息登记，供本地调试与 CI 矩阵复用
@author donttemo
@created 2026-10-13
-->

# 测试数据库环境（远程共用实例）

> ⚠️ **安全提示（必读）**：本文件会被纳入 Git 版本库，内附**明文凭证**，仅作连接信息登记用。
> 实际运行/测试请优先使用 `.env.test`（`APP_ENV=test` 时自动加载，已被 `.gitignore` 的 `.env.*` 规则忽略）
> 或 CI Secret 注入，不要把明文密码直接提交到业务配置。生产环境**严禁**使用本实例。

## 1. 实例清单

| 类型 | 主机 | 端口 | 用户名 | 密码 | 框架用途 |
|------|------|------|--------|------|----------|
| MySQL 8 | `106.55.32.251` | `3306` | `root` | `mysql1234` | `DB_DRIVER=mysql` 集成测试 |
| PostgreSQL | `106.55.32.251` | `5432` | `user` | `123456cs` | `DB_DRIVER=postgres` 集成测试 |
| Redis | `106.55.32.251` | `6379` | （无用户名） | `redis1234` | `CACHE_DRIVER=redis` 缓存测试 |

> 🔧 **端口更正记录**：Redis 端口以 **`6379`** 为准（前文笔误写成 6739，已修正）。

## 2. 可直接复制的连接串

### MySQL（`DB_DRIVER=mysql`）
```dotenv
DB_DRIVER=mysql
DB_URL=mysql://root:mysql1234@106.55.32.251:3306/framework_test
```
> 首次使用先建库：`CREATE DATABASE framework_test;`

### PostgreSQL（`DB_DRIVER=postgres`）
```dotenv
DB_DRIVER=postgres
DB_URL=postgresql://user:123456cs@106.55.32.251:5432/framework_test
```
> 首次使用先建库：`CREATE DATABASE framework_test;`

### Redis（缓存，非关系库）
```dotenv
CACHE_DRIVER=redis
CACHE_URL=redis://:redis1234@106.55.32.251:6379
```

## 3. 在系统测试中切换使用

框架数据库抽象层（ADR-0002）支持 `mysql` / `postgres` / `sqlite` 三种驱动，配置加载顺序见
`packages/config/src/loader.ts`：`.env → .env.{APP_ENV} → 进程环境变量 → overrides`。

- **本地调试**：把上面任一组 `DB_DRIVER` + `DB_URL`（或 `CACHE_URL`）写入项目 `.env` 或 `.env.test`
  （`APP_ENV=test` 时自动加载；`.env.test` 已被 gitignore，推荐）。
- **进程变量优先**：直接以环境变量覆盖，例如
  `DB_DRIVER=postgres DB_URL=postgresql://user:123456cs@106.55.32.251:5432/framework_test pnpm --filter @fw/db test`。
- **CI 三库一致性矩阵（T-M2-07）**：同一套 `@fw/db` 用例分别在 `mysql` / `postgres` / `sqlite` 上复跑，
  切换仅改 `DB_DRIVER` + `DB_URL` 两行并重建迁移，业务代码 diff = 0（详见 `docs/adr/0002-orm-selection.md`）。
- **SQLite 仍是默认/离线测试库**：文件型、无需远程，`packages/db` 集成测试默认用本地 `prisma/test-int.db`。

## 4. 多人共用约定

- 共用同一实例时，用独立数据库名避免相互污染，例如 `framework_test_<姓名缩写>`。
- 测试前后清理各自库表，禁止跨人/跨任务依赖同一份数据。
- 若实例不可用，回退到 SQLite 离线库，保证单测与覆盖率门禁不阻塞。

## 5. 执行记录

### 2026-10-13 · v0.1.0 联通性与切换实测（详见 [`93-db-connectivity-switch-test.md`](./93-db-connectivity-switch-test.md)）

- **实测服务端版本**：MySQL **8.4.11**、PostgreSQL **18.6**（Alpine，SCRAM-SHA-256，迭代 4096）、Redis **8.10.2**（standalone）。
  —— 以真实握手返回为准，非本文档抄录值。
- **测试库已创建**：MySQL 与 PostgreSQL 的 `framework_test` 均于本轮首次建立；Redis 为共享 `db0`（测试后键已清理）。
- **结果**：三库连通与鉴权全部通过；`@fw/db` 三库一致性矩阵（sqlite / mysql / postgres）同一套 11 项断言全绿，业务代码 diff = 0；
  缓存层 `redis` 驱动对接真实实例 18/18 通过（含键空间独立核验）。
- **注意事项（本轮实测发现）**：
  - PostgreSQL 库需先用 `CREATE DATABASE framework_test;` 建立后再跑迁移；本机无 `psql` 时可用协议级客户端或 `prisma db execute`。
  - MySQL 服务端 `lower_case_table_names` 生效，`TestUser` 落库后显示为 `testuser`；Prisma 查询不受影响，但**自写原生 SQL 需注意大小写归一**。
  - 跨公网逐条 `create` 造数较慢（128 条 ≈ 5.2s），批量造数请用 `createMany`，并为远端用例放宽单测超时。
