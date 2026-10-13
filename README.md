# 通用应用框架（代号 `fw`）

> 一套「框架之上的框架」：用它在 1 天内搭出任意业务系统的可运行骨架，小到内部工具站、大到多租户 SaaS，规模升级时业务代码零重写。
>
> **当前状态：v0.1.0 已发布（M1 核心骨架 + M2 数据库抽象层 + M3 鉴权与权限 + M4 缓存层）**；M5 管理后台前端（PRD-005）与 M6 CRUD 代码生成器（PRD-006）已完成实现与验证，未发版；M7 队列与定时任务（PRD-007）已完成实现与全量验收（含真实 Redis 失速恢复演练 TC-JOB-008，见 docs/94-queue-stall-drill.md），未发版；**M8 多租户与规模化演进（PRD-008）进行中：T-M8-01 租户上下文 / T-M8-02 dedicated 独立库路由 / T-M8-04 组织架构与数据权限四档已完成（冒烟 48/48），未发版**。发布验收记录见 [v0.1.0 发布验收报告](./docs/90-release-v0.1.0.md)。

## 设计原则

| 原则 | 含义 |
|---|---|
| 接口优于实现 | 业务代码只依赖接口（Repository / CacheService / Job），实现由适配器提供 |
| 配置驱动切换 | 数据库、缓存、鉴权、队列的切换只改 `.env`，不改业务代码 |
| 默认安全 | 鉴权、审计、限流、脱敏默认开启，不靠使用者的自觉 |
| 默认可观测 | 结构化日志、traceId、健康检查、指标默认接入 |
| 生成代码，不造黑盒 | 产出可读可改的源码，不做低代码运行时解释 |

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 / 运行时 | TypeScript + Node.js 20.19+（dev 工具链 vite 8 的下限；应用运行时 ≥ 20） |
| 后端框架 | NestJS 11（Express 5；模块化 + 依赖注入，单体与微服务同构） |
| ORM | Prisma 6（ADR-0002 定稿：多 provider 切换 = 改 datasource 两行 + generate + migrate） |
| 缓存 | 自研 `CacheStore` 端口 + memory / ioredis 驱动（ADR-0012） |
| 鉴权 | Passport + JWT + RBAC |
| 前端（后台模板） | Vue3 + Vite + Element Plus |
| 工程 | pnpm workspace + Turborepo |
| 部署 | Docker → docker-compose → Helm / K8s |

> 其它语言栈（Spring Boot 3 / Kratos / Django）仅作备选，不在首版范围。

## 目录结构（规划）

```
framework/
  packages/
    core/ config/ logger/     # M1 骨架
    db/ cli/                  # M2 数据库抽象 + 脚手架（含 db:migrate/rollback/seed）
    auth/                     # M3 鉴权与权限
    cache/                    # M4 缓存
    queue/                    # M7 队列与调度
  templates/
    admin/ api/ cms/          # 项目模板（M5 起）
  apps/
    example-api/              # 示例应用（每里程碑的验证载体）
    admin-web/                # M5 管理后台前端（Vue3 + Vite + Element Plus，C-06 mock 可独立运行）
  scripts/
    check-file-headers.mjs    # 文件头注释校验（中文 / 作者 / 日期）
    check-no-raw-sql.mjs      # 原生 SQL 方言标注检查（TC-ORM-005）
  docs/
    contracts/                # 并行开发先行契约（类型即契约，只读）
      auth.ts                 # C-05 权限契约（RequestUser / 权限码 / 菜单树 / 守卫失败码）
      api-web.ts              # C-06 前端 API 契约（登录/菜单/字典/审计/通用 CRUD/队列管理的请求响应结构）
      queue.ts                # C-08 Job 契约（任务选项 / 队列统计 / 死信 / cron 快照 / 队列权限码）
    00-vision-scope.md        # 愿景与范围（1 页）
    10-acceptance-criteria.md # 验收标准（DoD / 门禁 / 基线 / 演练）
    20-architecture.md        # 架构设计与技术方案
    25-ui-prototype.md        # 原型与 UI 规范
    30-data-dictionary.md     # ER 图与数据字典
    40-api-spec.md            # API 文档
    50-test-cases.md          # 测试用例
    60-deployment-ops.md      # 部署与运维手册
    70-engineering-standards.md # 编码 / Git / PR 规范
    80-project-plan.md        # 项目计划与任务板
    85-parallel-workstreams.md # 并行开发工作线划分（契约 / 所有权 / 集成点）
    90-release-v0.1.0.md      # v0.1.0 发布验收报告
    95-doc-audit.md           # 文档一致性核对报告
    adr/                      # 架构决策记录 0001–0010
    prd/                      # 按功能 / 迭代拆分的 PRD
```

## 快速开始（目标体验，实现中）

```bash
# 1. 用模板创建项目（未全局安装 CLI 时用 npx @fw/cli new）
fw new my-system --template=admin

# 2. 配置能力切换点（.env）
DB_DRIVER=postgres      # mysql | postgres | sqlite
CACHE_DRIVER=memory     # memory | redis | redis-cluster
AUTH_STRATEGY=jwt       # jwt | session | oauth2 | apikey
MQ_DRIVER=memory        # memory | bullmq

# 3. 启动（默认自带登录、权限、健康检查）
pnpm dev                # http://localhost:3000/health

# 4. 由数据表生成 CRUD（M6）
fw gen crud order --dry
fw gen crud order
```

## 能力矩阵

| 能力 | 实现 | 里程碑 | 状态 |
|---|---|---|---|
| 配置 / 日志 / 错误码 / 健康检查 | `@fw/core` `@fw/config` `@fw/logger` | M1 | ✅ 已完成 |
| 数据库抽象与多库切换 | `@fw/db`（Repository 契约 + Prisma 适配 + 方言白名单 + 迁移工具 + 慢查询观测） | M2 | ✅ 已完成 |
| 鉴权与权限 | `@fw/auth`（双 token 轮换 + RBAC 五表 + 多策略 + 审计 + 登录加固） | M3 | ✅ 已完成 |
| 缓存 | `@fw/cache`（统一 CacheService + memory/redis/cluster 驱动 + 三防护 + 标签失效 + 分布式锁 + 降级与指标） | M4 | ✅ 已完成 |
| 管理后台模板 | `apps/admin-web`（Vue3 + Vite + Element Plus：登录、动态路由、按钮级权限、用户/角色/菜单/字典/审计页、`<CrudTable>` 标准组件；mock 全链路冒烟 40/40、单测 29） | M5 | ✅ 已完成（未发版） |
| CRUD 代码生成器 | `@fw/cli gen`（schema 解析 + 类型映射 + 模板引擎 + 后端/前端/seed 生成 + dry-run/diff/回滚；模板外置 `templates/codegen/`；单测 116 / 覆盖率 94.7%） | M6 | ✅ 已完成（未发版） |
| 队列与定时任务 | `@fw/queue`（统一 Job 抽象 + memory/bullmq 双驱动 + `@JobHandler`/`@Cron` 自动扫描 + 重试退避 + 死信重放 + 幂等 + 令牌桶限速 + cron 分布式锁 + 优雅停机 + 队列管理页；单测 135 / 覆盖率 93.1%、example-api 冒烟 27/27 含真实 Redis 的 bullmq 全链路） | M7 | 已实现（重启验收待补，未发版） |
| 多租户与规模化 | `@fw/tenant`（三级回退租户解析 + fail-closed + 上下文透传）+ `@fw/db` TenantDataSource（dedicated 独立库路由：懒创建 + LRU/空闲淘汰 + Repository 按上下文选路）+ `@fw/auth` 数据权限四档（`DataScopeOrgPort` + all/org_below/org/self 解析与详情越权校验 + `departments`/`user_department` 模型）；transport / OTel / Helm 待启动 | M8 | 进行中（T-M8-01/02/04 已完成，冒烟 48/48，未发版） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [愿景与范围](./docs/00-vision-scope.md) | 目标、非目标、边界、规模分档、成功指标（1 页） |
| [验收标准](./docs/10-acceptance-criteria.md) | 完成定义、里程碑门禁、非功能基线、三大演练、验收流程 |
| [架构设计与技术方案](./docs/20-architecture.md) | 分层架构、模块职责、请求链路、各能力技术方案、部署与演进、ADR 摘要 |
| [原型与 UI](./docs/25-ui-prototype.md) | 设计令牌、页面清单与路由、布局与关键页线框、组件与交互规范、响应式 |
| [ER 图与数据字典](./docs/30-data-dictionary.md) | 建模约定、权限/系统/租户三域 ER 图、15 张表字段字典 |
| [API 文档](./docs/40-api-spec.md) | 通用约定、错误码、10 类接口清单、限流与幂等、版本策略 |
| [部署与运维手册](./docs/60-deployment-ops.md) | 三档部署、配置清单、备份恢复、监控告警、故障 Runbook、升级回滚 |
| [CHANGELOG](./CHANGELOG.md) | 版本规则与变更记录（v0.1.0 已发布，M5–M7 尚未发版） |
| [ADR 架构决策记录](./docs/adr/README.md) | 12 条决策：NestJS / Prisma（已定稿）/ monorepo / 缓存 / 鉴权 / 前端 / 可切换性 / 测试 / 代码生成 / 可观测 |
| [编码 Git PR 规范](./docs/70-engineering-standards.md) | 编码规范、**中文注释规范（文件头含作者与日期）**、反模式清单、分支与提交约定、PR 与评审规则 |
| [项目计划与任务板](./docs/80-project-plan.md) | 15 周甘特、M1–M8 WBS（40+ 任务）、任务板列与标签、当前快照 |
| [并行开发工作线划分](./docs/85-parallel-workstreams.md) | 多线并行：7 条工作线与负责人、8 份先行契约、目录所有权矩阵、W0–W10 时间轴与 I1/I2/I3 集成点 |
| [先行契约](./docs/contracts/api-web.ts) | 类型即契约（只读）：C-04 缓存、C-05 权限契约、C-06 前端 API 契约、C-08 Job 契约已冻结，其余 C-03/C-07 待落地 |
| [AI 多线程开工执行手册](./docs/86-ai-parallel-execution.md) | 编排者 + 5 个执行 agent 的拓扑、Wave 0–4 波次、agent 名额与目录白名单、prompt 模板、防造假四道闸 |
| [贡献指南](./CONTRIBUTING.md) | 三步上手与硬性规则入口 |
| [PRD 索引](./docs/prd/README.md) | 迭代清单与 PRD 模板约定 |
| PRD-001 ~ PRD-008 | 见 `docs/prd/`，每个功能 / 迭代一份 |
| [v0.1.0 发布验收报告](./docs/90-release-v0.1.0.md) | M1–M4 发布门禁逐条判定、验证证据清单、遗留问题与发布结论（条件通过） |
| [测试数据库环境](./docs/92-test-databases.md) | 远程共用测试实例（MySQL / PostgreSQL / Redis）连接登记与测试切换方式（含明文凭证，仅测试用） |
| [数据库联通性与切换实测](./docs/93-db-connectivity-switch-test.md) | v0.1.0 三库连通/鉴权实测、T-M2-07 三库一致性矩阵、业务代码零改动证明、Redis 真实实例联调与遗留项 |
| [TC-JOB-008 失速恢复演练](./docs/94-queue-stall-drill.md) | 真实 Redis 上 BullMQ 失速恢复演练记录：设计、排障（register 未建消费器 / ensureWorker 自递归死锁与竞态）、MQ_STALLED_MS 与证据 |
| [代码生成模板定制](./templates/codegen/README.md) | `fw gen crud` 模板目录结构、标签语法、可用变量清单、项目级同名覆盖与 `codegen.config.json`（vars / typeOverrides） |
| [文档一致性核对报告](./docs/95-doc-audit.md) | 全量文档交叉核对结果、冲突修复记录与遗留项 |

## 路线图

| 里程碑 | 交付 | PRD | 状态 |
|---|---|---|---|
| M1 | 核心骨架 | [001](./docs/prd/prd-001-core-skeleton.md) | ✅ 已完成 |
| M2 | 数据库抽象层 | [002](./docs/prd/prd-002-database-abstraction.md) | ✅ 已完成 |
| M3 | 鉴权与权限 | [003](./docs/prd/prd-003-auth-rbac.md) | ✅ 已完成 |
| M4 | 缓存层 | [004](./docs/prd/prd-004-cache-layer.md) | ✅ 已完成 |
| M5 | 管理后台模板 | [005](./docs/prd/prd-005-admin-template.md) | ✅ 已完成（未发版） |
| M6 | 代码生成器 | [006](./docs/prd/prd-006-code-generator.md) | ✅ 已完成（未发版） |
| M7 | 队列与定时任务 | [007](./docs/prd/prd-007-queue-scheduler.md) | 已实现（重启验收待补，未发版） |
| M8 | 多租户与规模化 | [008](./docs/prd/prd-008-multitenancy-scale.md) | 进行中（T-M8-01/02/04 已完成，未发版） |

## 开发规范

- 分支：`main`（可发布）/ `feat/<prd>-<短名>` / `fix/<issue>`；PR 必须关联 PRD 与验收项。
- 提交：Conventional Commits（`feat(auth): ...`）。
- 门禁：`pnpm lint` + `pnpm test` + 覆盖率阈值 + 变更影响到的 PRD 的 AC 全部勾选。
- 文档：能力变更必须同步更新对应 PRD 的「变更记录」，禁止静默改需求。
- 兼容性：任何破坏性变更需在 README 与 PRD 中标注迁移步骤。
