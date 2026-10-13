<!--
@file docs/93-db-connectivity-switch-test.md
@description v0.1.0 数据库联通性与「数据库可切换」实测报告：MySQL / PostgreSQL / Redis 真实实例连接、
  T-M2-07 三库一致性矩阵（sqlite / mysql / postgres 同一套断言）、业务代码零改动证明与遗留项
@author donttemo
@created 2026-10-13
-->

# v0.1.0 数据库联通性与切换实测报告

> 结论：**通过**。远程 MySQL / PostgreSQL / Redis 三实例连通与鉴权全部确认；
> 「数据库可切换」在真实 MySQL 8.4 与 PostgreSQL 18 上以**同一套 11 项断言**全量复跑通过，
> 业务代码（`PrismaRepository`）改动 **diff = 0**；缓存层 `redis` 驱动对接真实实例 18/18 通过。
> 本报告覆盖验收总纲遗留项 **R-01（三库矩阵与数据库切换演练未在真实环境执行）** 与
> **R-07（真实 Redis 未实跑）** 的实测闭环（R-07 的 Redis Cluster 部分仍未闭环，见 §7）。

## 1. 测试对象与环境

| 项 | 值 |
|---|---|
| 被测版本 | v0.1.0（tag `v0.1.0` → `5f35895`） |
| 实例来源 | `docs/92-test-databases.md` 登记的远程共用测试实例 |
| 主机 | `106.55.32.251`（3306 / 5432 / 6379 三口均可达） |
| 验证日期 | 2026-10-13 |

实测到的服务端版本（**非文档抄录，为真实握手返回**）：

| 类型 | 版本 | 鉴权 | 备注 |
|---|---|---|---|
| MySQL | **8.4.11** | 口令（`caching_sha2_password` 协商通过） | 服务端 `lower_case_table_names` 使表名归一为小写 |
| PostgreSQL | **18.6**（x86_64-pc-linux-musl, Alpine） | **SCRAM-SHA-256**（迭代 4096），`user` 具超级用户权限 | 服务端 `TimeZone=UTC`、`client_encoding=UTF8` |
| Redis | **8.10.2**（standalone 模式） | `requirepass` | 空库，`DBSIZE=0` 起步 |

测试库 `framework_test` 在本轮首次创建（MySQL + PostgreSQL 各一），符合 `92-test-databases.md` §2 的首次使用约定。

## 2. 连通性实测

### 2.1 MySQL

```bash
mysql -h106.55.32.251 -P3306 -uroot -pmysql1234 -e "SELECT VERSION(), NOW(); SHOW DATABASES;"
# → 8.4.11 / 2026-10-13 12:57:30
# → framework_test 首次创建成功（utf8mb4 / utf8mb4_unicode_ci）
```

### 2.2 PostgreSQL

本机无 `psql` 客户端，改用**最小 PostgreSQL 3.0 前端/后端协议客户端**（纯标准库实现）完成真实握手，
不走「端口能连上就算通」的弱验证：

1. `StartupMessage`（user/database）
2. 收到 `AuthenticationRequest`，**auth_type=10（SASL）**，机制列表 `['SCRAM-SHA-256']`
3. 完成 SCRAM-SHA-256 四步交换（client-first / server-first / client-final / server-final），**server-final 校验通过**
4. 收到 `ReadyForQuery`，连接就绪；`SELECT version()` → `PostgreSQL 18.6 ...`

结论：不仅端口可达，**口令鉴权完整通过**。`framework_test` 库创建成功。

### 2.3 Redis

```js
// ioredis（@fw/cache 的 devDependency）直连
redis://:redis1234@106.55.32.251:6379
```

| 探针 | 结果 |
|---|---|
| `PING` | `PONG` |
| `SET k v PX 5000` → `GET` | `v1`（TTL 生效：`PTTL` = 4965ms） |
| `SET NX PX` 二次调用 | 首次 `OK`、二次 `null`（**分布式锁原语正确**） |
| `SADD` / `SMEMBERS` | `k1,k2,k3`（标签失效用的集合可用） |
| `EVAL`（Lua） | 返回预期值（解锁脚本可用） |
| `DBSIZE` 清理后 | `0` |

## 3. 数据库可切换实测（T-M2-07 三库一致性矩阵）

### 3.1 证明方式

ADR-0002 / ADR-0007 承诺：**切换数据库只改 `datasource` 两行，业务代码 diff = 0**。
本轮把该承诺变成可执行的自动验证：

1. 为 sqlite 之外的两种方言各建一份 schema 变体（`prisma/test-schema.mysql.prisma` / `...postgresql.prisma`）；
2. 用 `prisma migrate diff --from-empty --to-schema-datamodel <schema> --script` 生成**方言建表 SQL**，经 `prisma db execute --file` 应用；
3. 把 PRD-002 的功能用例抽为与驱动无关的 `defineRepositorySuite()`，**由三个驱动共用同一份断言**；
4. 按 `DB_DRIVER` 选择目标库复跑；未设置时整文件跳过（保证离线单测与覆盖率门禁不被远端依赖阻塞）。

### 3.2 切换改动量取证

三份 schema 的差异（`diff` 实测输出）：

```
  output   = "../prisma/test-client"          →  "../prisma/matrix-client-<driver>"
  provider = "sqlite"                          →  "mysql" / "postgresql"
  url      = env("TEST_DATABASE_URL")          →  env("DATABASE_URL")
（其余差异仅为文件头注释）
```

模型段三方**完全一致**（MD5 逐一比对相同）：

```
1ac10d3941e93741e7f60cb28e048792  test-schema.prisma 模型段
1ac10d3941e93741e7f60cb28e048792  test-schema.mysql.prisma 模型段
1ac10d3941e93741e7f60cb28e048792  test-schema.postgresql.prisma 模型段
```

**业务源码零改动**（`git status --short packages/db/src/`）：

```
 M packages/db/src/__tests__/prisma-repository.integration.test.ts   ← 仅测试
?? packages/db/src/__tests__/prisma-repository.matrix.test.ts        ← 新增测试
?? packages/db/src/__tests__/repository-suite.ts                     ← 新增测试
```

`prisma-repository.ts` / `db.module.ts` / `types.ts` / `repository.interface.ts` **均未修改** —— 可切换性成立。

### 3.3 矩阵结果

同一套 11 项断言（CRUD 与软删 4 / 分页 3 / 事务 3 / upsert 1）：

| 驱动 | 目标库 | 结果 | 耗时 |
|---|---|---|---|
| sqlite | 本地 `prisma/test-int.db` | **11/11 通过** | 5.0s |
| mysql | `framework_test@106.55.32.251:3306` | **11/11 通过** | 3.5s |
| postgres | `framework_test@106.55.32.251:5432` | **11/11 通过** | 2.3s |

关注的方言差异点在三库上行为一致：
- **upsert**：MySQL 走 `ON DUPLICATE KEY`、PG 走 `ON CONFLICT`、SQLite 走 `INSERT OR CONFLICT`，
  由 Prisma 映射，业务层零分支（`repo.upsert()` 同一调用）；
- **分页稳定性**：同 `createdAt` 记录的 `id` tie-breaker 在三库均不跨页重复（128 条翻 7 页取全集恰好 128 个唯一 id）；
- **游标分页**：`id > cursor` 在 MySQL `VARCHAR(191)` 与 PG `TEXT` 上语义一致；
- **软删过滤**：`deletedAt IS NULL` 在 MySQL `DATETIME(3)` 与 PG `TIMESTAMP(3)` 上均正确；
- **事务回滚/提交**：三库 `$transaction` 交互式事务行为一致（含事务内软删不可见）。

复现命令：

```bash
# 1) 生成两个方言客户端（一次性）
DATABASE_URL=<url> pnpm --filter @fw/db exec prisma generate --schema prisma/test-schema.mysql.prisma
DATABASE_URL=<url> pnpm --filter @fw/db exec prisma generate --schema prisma/test-schema.postgresql.prisma

# 2) 建表（生成方言迁移 SQL 并应用）
cd packages/db
DB_DRIVER=mysql    DB_URL="mysql://root:mysql1234@106.55.32.251:3306/framework_test"      node scripts/matrix-db-setup.mjs
DB_DRIVER=postgres DB_URL="postgresql://user:123456cs@106.55.32.251:5432/framework_test" node scripts/matrix-db-setup.mjs

# 3) 复跑同一套用例
DB_DRIVER=mysql    DB_URL="mysql://..." ./node_modules/.bin/vitest run --no-file-parallelism
DB_DRIVER=postgres DB_URL="postgresql://..." ./node_modules/.bin/vitest run --no-file-parallelism
```

## 4. 缓存层对接真实 Redis

原 M4 冒烟仅覆盖 `memory` 驱动与「redis 不可达降级」，**未验证真实 Redis**。本轮新增**阶段 D**（`SMOKE_REDIS_URL` 门控）：

| 断言 | 结果 | 说明 |
|---|---|---|
| D1 redis 驱动真实读写 | PASS | `driver=redis`，写入后读回一致 |
| D2 `/ready` → 200 / `cache=ok` | PASS | **关键**：证明连接真实建立，而非静默降级 |
| D3 `@Cacheable` 命中（第二次不回源） | PASS | 与 memory 驱动行为一致 |
| D4 标签失效（重新回源） | PASS | `removed=1 loads=2` |
| D5 分布式锁 `SET NX PX` | PASS | 持锁互斥 + TTL 到期自动释放 |
| D6 全程零降级 + `/metrics` `driver=redis` | PASS | `degradations=0`，命中率 > 0 |

**独立核验**：冒烟结束后用 ioredis 直连远端扫描键空间，确认数据真实落库（而非仅内存假象）：

```
fw:dev:demo:kv:redis-k1                  type=string  pttl=46054    value="redis-v1"
fw:dev:CacheDemoService:findUser:dlquuc  type=string  pttl=46880    value={"id":"177","name":"user-177"}
fw:dev:CacheDemoService:findUser:n04wey  type=string  pttl=45219    value={"id":"188","name":"user-188"}
fw:dev:__tag__:demo:user:177             type=set     pttl=86384582
fw:dev:__tag__:demo:user:188             type=set     pttl=86384927
```

键前缀、TTL、标签集合、序列化信封均符合 PRD-004 设计。

## 5. 回归结果（改动后全量复跑）

| 项 | 结果 |
|---|---|
| 逐包构建 | **8/8 通过**（config / logger / core / db / auth / cache / cli / example-api） |
| 逐包单测 | **266 项通过**（config 10 / logger 13 / core 12 / db 45 / auth 89 / cache 73 / cli 24） |
| 三库矩阵 | sqlite 11 / mysql 11 / postgres 11 全通过（默认离线运行时 11 项跳过，不计入失败） |
| M1+M2 冒烟 | **13/13** |
| M3 冒烟 | **25/25** |
| M4 冒烟（默认） | **12/12**（阶段 D 未设置 `SMOKE_REDIS_URL` 时跳过） |
| M4 冒烟（真实 Redis） | **18/18** |

## 6. 本轮发现与修复

| 编号 | 问题 | 定位 | 处理 |
|---|---|---|---|
| D-01 | 三库矩阵 `128 条分页` 用例在 MySQL 上超时（默认 5s），**超时后残留的造数循环继续写库**，污染后续用例（表现为计数偏高、游标多取） | 逐条 `create` 128 次跨公网 ≈ 5.2s | 造数改 `createMany` 批量；`vitest.config.ts` 增设 `testTimeout/hookTimeout = 60s` |
| D-02 | 受限宿主下同步 `spawn(cmd.exe)` 返回 `EBUSY`，建表脚本不可用 | 沙箱禁止同步 spawn | 建表脚本改**异步** `execFile` |
| D-03 | `prisma db execute --stdin` 在该宿主下被管道注入拦截（进程被 SIGTERM） | stdin 管道不可用 | 改用 `--file <临时文件>` |
| D-04 | 生成产物 `matrix-client-*` 可能误入版本库 | — | `.gitignore` 增补 `matrix-client-mysql/`、`matrix-client-postgresql/`、`.tmp-dbtest/` |

顺带发现（非缺陷，记录备查）：MySQL 服务端 `lower_case_table_names` 生效，`CREATE TABLE \`TestUser\`` 落库后表名显示为 `testuser`；
Prisma 引用一致，不影响查询，但**自写原生 SQL 时需注意大小写归一**（已在方言白名单逃逸口条款下）。

## 7. 遗留

| 编号 | 遗留项 | 说明 / 闭环路径 |
|---|---|---|
| T-01 | 矩阵**未接入 CI** | 本地已可一键复现；需在 `.github/workflows/ci.yml` 增 job，用 Secret 注入 `DB_URL`，按 `DB_DRIVER` 跑两次 |
| T-02 | `mysql` / `postgres` 两种驱动**并发矩阵**未做 | 当前为串行两次运行，CI 中可并行 |
| T-03 | **Redis Cluster** 未对真实集群实跑（本轮为 standalone 8.10.2） | `redis-cluster` 驱动仍由 fake 客户端验证命令序列；M8 演练时补真实集群 |
| T-04 | 矩阵**只覆盖 `TestUser` 单模型** | `jsonContains` 三库分支未纳入矩阵（需 schema 加 JSON 字段）；建议 M6 生成器落地后随业务模型补齐 |
| T-05 | 测试库为**共享实例明文凭证** | 已在 `92-test-databases.md` 标注；生产严禁复用；建议改走 `.env.test` / CI Secret |

## 8. 结论

- 远程 MySQL / PostgreSQL / Redis **连通性与鉴权真实通过**（PG 为 SCRAM-SHA-256 完整握手）。
- **「数据库可切换」不再只是文档承诺**：同 11 项断言在 sqlite / MySQL 8.4 / PostgreSQL 18 三库全绿，业务代码 diff = 0，
  切换改动量收敛为 `provider` + `url` 两行。
- 缓存层 `redis` 驱动对接真实实例可用，且以「零降级 + `/ready cache=ok` + 键空间独立核验」三重证据排除「静默降级假绿」。
- 验收总纲遗留的 **R-01（三库矩阵与数据库切换演练）**、**R-07（真实 Redis 未实跑）** 在本轮完成实测闭环
  （R-07 仅 Redis **standalone** 部分闭环，Cluster 仍留待 M8，见 §7 T-03）；
  新增遗留 T-01（接 CI）为工程化收尾项，不影响 0.1.0 代码层判定。
