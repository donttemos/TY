# ADR-0002 · ORM 选型：Prisma 或 TypeORM

- 状态：已采纳（Prisma）
- 日期：2026-10-09（提案）／2026-10-12（定稿）
- 关联：PRD-002、[ADR-0007](./0007-database-switchability.md)

## 背景

1. 数据库可切换是头号卖点，ORM 的多 provider 支持能力直接决定实现成本。
2. 需要在开发体验（schema 与类型）、迁移工具、多库方言差异处理之间取舍。
3. 决策一旦落地，所有 Repository 与迁移资产会深度绑定，**后期更换成本极高**。

## 决策

**选定 Prisma**（2026-10-12 定稿，基于 T-M2-01 spike 实测）。

评估项与权重（原提案）：多 provider 切换成本（高）、迁移工具（高）、类型安全与开发体验（中）、事务与连接池控制（中）、原生 SQL 与方言差异处理（高）、生态与维护活跃度（中）。

### Spike 实测记录（2026-10-12，Prisma 6.19.3）

验证环境：`packages/db` 内最小 schema（单模型 `SpikeRecord`，含 `deletedAt` 软删字段），`prisma generate` → `migrate dev` → 运行时脚本四项断言全过：

| 验证项 | 结果 | 证据 |
|---|---|---|
| 引擎下载与 client 生成 | ✅ | `prisma generate` 85ms 生成 typed client |
| CRUD + 软删过滤 | ✅ | create 两条 → `deletedAt` 打点后 `findMany({ where: { deletedAt: null } })` 只剩 1 条 |
| 事务回滚 | ✅ | `$transaction` 内抛错，库内无残留 |
| 分页 + 排序稳定性 | ✅ | `skip/take` + `orderBy([createdAt, id])` tie-breaker，`total=6` 正确 |
| **多 provider 切换成本** | ✅ | 同一 datamodel 切 `postgresql` 仅改 datasource 两行；`validate` 通过；`migrate diff --script` 自动生成 PG 方言 SQL |
| 方言 SQL 自动生成 | ✅ | SQLite：`TEXT NOT NULL PRIMARY KEY` + `DATETIME`；PG：`TEXT` + `TIMESTAMP(3)` + 命名约束 `CONSTRAINT "SpikeRecord_pkey"` + `CREATE SCHEMA IF NOT EXISTS "public"` |

**切换成本量化**：改 `datasource.provider` + `datasource.url` 两行 → `prisma generate` → `prisma migrate dev` 重建迁移 → 业务代码 diff = 0。TypeORM 未实测（依赖装饰器实体与运行时反射，类型安全与迁移回滚能力弱于 Prisma 是已知事实；且生态维护节奏风险已在提案中记录）。

### 选型后的工程约束（落地规则）

1. 切换 provider 后**必须**重新 `prisma generate` 与全量迁移——CI 将该两步列为强制环节，防「缓存旧 client 假绿」（PRD-002 风险 1 的闭环）。
2. `$queryRaw` / `$executeRaw` 为唯一原生 SQL 逃逸口——由 T-M2-04 的 lint 规则静态拦截（无 `@sql('<dialect>')` 标注即失败），方言白名单见 ADR-0007。
3. 慢查询观测用 Prisma Client 扩展（`$extends` + `query` 事件）挂日志，带 traceId（T-M2-06）。
4. 业务层只依赖 `Repository<T>` 接口，禁止 Prisma 实体类型泄漏到 Controller（原约束保留）。

## 备选方案

| 方案 | 优点 | 缺点 |
|---|---|---|
| Prisma | schema 清晰、类型生成强、迁移工具完善、多 provider 支持好 | 切换 provider 需重新生成 client（CI 须强制该步骤，否则假绿）；复杂查询表达力略弱 |
| TypeORM | 装饰器贴近代码、支持数据库更多、可精细控制 SQL | 类型安全弱于 Prisma；维护节奏不稳；装饰器与实体耦合较深 |
| MikroORM | Unit of Work 模式、性能好 | 生态较小，招聘与资料成本高 |
| 自研查询构建器 | 完全可控 | 违背「不自研基础设施」的非目标，成本高 |

## 后果

**正面**：Spike 实测替代口碑决策——多 provider 切换、迁移、事务、分页、软删五项全过，切换成本量化为「改 datasource 两行 + generate + migrate」；Repository 接口先行使选型未阻塞 M1。

**负面 / 代价**：TypeORM 未做对称实测（结论部分基于已知事实）；Prisma 切换 provider 必须重新 generate（已列为 CI 强制环节）；复杂查询表达力弱于手写 SQL（由方言白名单 + 适配器方法兜底）。

**缓解措施**：`Repository<T>` 接口与方言白名单（ADR-0007）先行冻结，ORM 落地是「实现接口」而非「设计架构」；`$queryRaw` 逃逸口由 lint 静态拦截。
