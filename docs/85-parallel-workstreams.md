# 并行开发工作线划分

> 版本 v0.1 ｜ 状态：草案（待周计划评审确认） ｜ 更新：2026-10-12
>
> 关联：[项目计划与任务板](./80-project-plan.md) ｜ [架构设计](./20-architecture.md) ｜ [PRD 索引](./prd/README.md) ｜ [编码/Git/PR 规范](./70-engineering-standards.md) ｜ [验收标准](./10-acceptance-criteria.md)
>
> 本文解决一个问题：**把 80 计划里串行的 M1→M8 拆成可同时推进的多条工作线**，谁负责哪块、线之间靠什么解耦、什么时候合到一起。任务编号沿用 80 计划的 `T-Mx-nn`。

## 1. 结论速览

| 项 | 串行计划（80） | 并行划分（本文） |
|---|---|---|
| 组织方式 | 里程碑依次推进，M1→M2→M3→M5→M6→M7→M8 | **7 条工作线并行**，里程碑作为集成点而非排队条件 |
| 开工条件 | 前序里程碑验收通过 | 前序**契约**冻结即可开工，实现未就绪用 stub 顶上 |
| 关键路径 | 15 周 | **10 周**（M1–M7），M8 顺延 3 周且可全线并行切割 |
| 解耦手段 | 无 | 契约先行 + 目录所有权 + 内存/stub 实现 + 固定合并窗口 |

**核心思路**：先把 8 份「契约」冻结成类型文件（W0，约 1.5 天），之后各线只依赖契约不依赖彼此的实现；每条线独占自己的包目录，物理隔离避免 Git 冲突；每周五一次集成，里程碑门禁作为强制合流点。

## 2. 开工前基线（现状）

M1 骨架已落地，无需重做：

| 包 | 现状 | 说明 |
|---|---|---|
| `@fw/config` | 已实现 | `envSchema`、`ConfigService`、`loadEnv`、枚举取值表 |
| `@fw/logger` | 已实现 | `Logger`、脱敏 `redact`、异步上下文 `requestContextStorage` |
| `@fw/core` | 已实现 | `bootstrap`、错误码 `ErrorCode`、响应拦截器、全局异常过滤、健康检查、优雅停机、trace 中间件 |
| `@fw/cli` | 已实现 | `fw new / dev / build / check` |
| `apps/example-api` | 可运行 | 有 demo 模块，作为集成验证载体 |
| `packages/orm`、`auth`、`cache`、`queue` | **未开工** | 本文划分的主要对象 |
| `apps/admin-web`（前端） | **未开工** | L4 线新建 |

因此 **W0 只做三件事**：冻结契约、建目录所有权与分支约定、补齐 CI 与 mock server。之后 6 条线同周开工。

## 3. 工作线总表

下表是全文的主索引，每条线的细节见 §6。

| 线 | 名称 | 负责范围 | 独占目录（所有权） | 主里程碑 | 人日 | 依赖契约 | 被谁依赖 |
|---|---|---|---|---|---|---|---|
| **L0** | 契约与集成 | 契约文件、工程基线、跨线仲裁、集成日主持 | `docs/contracts/**`、根目录工程文件、`turbo.json`、`tsconfig.base.json` | 全程 | 6 | — | 全线 |
| **L1** | 数据访问 | `@fw/orm`：Repository 抽象、三驱动、方言白名单、迁移、CI 矩阵 | `packages/orm/**` | M2 | 16.5 | C-01 C-02 C-03 C-07 | L2 L5 |
| **L2** | 鉴权与权限 | `@fw/auth`：五表、登录/双 token、RBAC、审计、安全加固 | `packages/auth/**`、`apps/example-api/src/modules/auth/**` | M3 | 17.5 | C-01 C-03 C-04 C-05 C-06 | L4 L5 |
| **L3** | 缓存与队列 | `@fw/cache` + `@fw/queue`：缓存三防护、分布式锁、降级、Job/cron/死信 | `packages/cache/**`、`packages/queue/**` | M4 + M7 | 21.5 | C-01 C-02 C-04 C-08 | L2 L4 |
| **L4** | 管理后台前端 | `apps/admin-web`：工程布局、request 层、登录、动态路由、管理页、`<CrudTable>` | `apps/admin-web/**` | M5 | 20 | C-06（+ mock server） | L5 |
| **L5** | CLI 与代码生成 | `@fw/cli` 收尾、`templates/**`、生成器（元信息→后端/前端代码） | `packages/cli/**`、`templates/**` | M1-07 + M6 | 15 | C-03 C-05 C-07 | — |
| **L6** | 质量与交付 | 测试用例落地、CI 流水线、门禁脚本、文档同步、部署模板 | `.github/**`、`scripts/**`、`docs/**`（各线自管 PRD 除外）、`apps/example-api` 集成验证 | 全程 | 12 | 全部 | 全线 |

人日合计 ≈ 108（不含缓冲，缓冲按 80 计划每里程碑 20% 另计）。

## 4. 契约先行（W0 必做）

契约是并行能跑起来的前提：**一条线只要拿到契约，就能用 stub 开工，不必等对方实现**。契约文件由 L0 独占维护，落地在 `docs/contracts/*.ts`（类型即契约，实现方照抄签名）。

| 契约 | 名称 | 落地文件 | 冻结内容 | 消费方 | 现状 |
|---|---|---|---|---|---|
| C-01 | 统一响应与错误码 | `packages/core/src/errors/error-codes.ts` + `docs/40-api-spec.md` | `{ code, message, data, traceId }` 结构、错误码表与 HTTP 映射、新增错误码流程 | 全线 | 已存在，需 L0 冻结并禁止随意增码 |
| C-02 | 日志与请求上下文 | `packages/logger` | `Logger.for()`、字段集、脱敏规则、`getTraceId()` | 全线 | 已实现，冻结即可 |
| C-03 | `Repository<T>` | `docs/contracts/repository.ts` | `findById/list/page/create/update/softDelete/count/withTransaction`、分页入出参、软删语义、事务边界 | L1（实现） L2 L5（消费） | **新建** |
| C-04 | `CacheService` / `Lock` | `docs/contracts/cache.ts` | `get/set/del/has/wrap/mget/expire/invalidateTag`、锁 API、降级语义 `CACHE_FAIL_OPEN` | L3（实现） L2 L4 | **已冻结（M4，2026-10-13）** |
| C-05 | 权限契约 | `docs/contracts/auth.ts` | `RequestUser` 结构、权限码 `资源:操作`、菜单树 JSON、`@Permissions` 语义、守卫失败返回码 | L2（实现） L4 L5 | **已冻结（M3，2026-10-13）** |
| C-06 | 前端 API 契约 | `docs/contracts/api-web.ts` + `apps/admin-web/mock/` | 登录/刷新/登出/`me`/菜单/字典/审计/通用 CRUD 的请求响应结构 + mock 数据 | L2 L4（共同遵守，L4 先建 mock） | **新建** |
| C-07 | 元信息接口 | `docs/contracts/introspector.ts` | 表/字段元信息结构（类型映射以数据字典 1.3 为准）、`SchemaIntrospector` 接口 | L1（实现） L5（消费） | **新建** |
| C-08 | Job 契约 | `docs/contracts/queue.ts` | `name/payload/options(attempts, backoff, delay, idempotencyKey)`、`@Cron`、`@JobHandler` 语义 | L3（实现） L4 | **新建** |

**契约变更规则**

1. 契约文件属 L0 独占，其他线只读；需要变更 → 在任务板建 `contract` 类型卡片并 @L0，L0 在 24 小时内裁决。
2. 破坏性变更（改签名/改字段语义）必须：写 ADR 或追加变更记录 → 全群通知 → **当天内全线 rebase** → L0 在集成日验收同步结果。
3. 实现方（如 L1 实现 C-03）不得私自改契约签名；实现与契约不符以**契约为准**，实现改。
4. 契约未覆盖的临时约定，一律先用 stub，禁止口头约定后各写各的。

**stub 策略**：每条线为自己依赖但尚未就绪的契约提供内存实现，上线时只改 DI 注册，业务代码不动。

| stub | 由谁提供 | 替代谁 | 切换时机 |
|---|---|---|---|
| `MemoryRepository` | L1（W1 交付） | `@fw/orm` 真实驱动 | I2 集成点（W6） |
| `NullCache` | L3（W1 交付） | `CacheService` | I2 集成点（W6） |
| `MockServer`（msw 或 vite 中间件） | L4（W1 交付） | 真实后端 API | I2 集成点（W6） |
| `InProcessQueue` | L3（W2 交付） | bullmq | M7 验收前 |

## 5. 目录所有权矩阵（防冲突）

并行最大的敌人是同一文件被两线同时改。按目录划所有权，**越界改文件一律打回**。

| 路径 | 归属线 | 他线权限 |
|---|---|---|
| `packages/orm/**` | L1 | 只读；需要能力通过 C-03/C-07 提契约变更 |
| `packages/auth/**`、`apps/example-api/src/modules/auth/**` | L2 | 只读 |
| `packages/cache/**`、`packages/queue/**` | L3 | 只读 |
| `apps/admin-web/**` | L4 | 只读 |
| `packages/cli/**`、`templates/**` | L5 | 只读 |
| `.github/**`、`scripts/**`、`docs/**` | L6 | 各线可改自己 PRD，其余需 L6 评审 |
| `docs/contracts/**` | L0 | **全线只读** |
| `apps/example-api/**`（除 `modules/auth`） | L6（集成验证载体） | 各线在此挂演示模块需 L6 同意 |

**共享文件（高风险，需 L0 审批）**：`package.json`（根）、`pnpm-lock.yaml`、`turbo.json`、`tsconfig.base.json`、`pnpm-workspace.yaml`、`CHANGELOG.md`、`README.md`。

处理规则：

1. 共享文件改动**由 L0 代改**，其他线把需求写进 PR 描述或提给 L0，不自己动手。
2. 确需自改时，先在任务板建 `chore` 卡片并声明，改动 **≤ 30 分钟**内合并，合并后立即在群里广播，各线当日 rebase。
3. `pnpm-lock.yaml` 只允许在**每日合并窗口**（12:00 / 18:00）内变更，避免互相覆盖。

## 6. 各线详解

### L1 数据访问线（`@fw/orm`，M2）

- **目标**：一套 `Repository<T>` 接口跑通 mysql / postgres / sqlite，切换只改 `.env`，业务代码 diff = 0。
- **不做**：业务表、鉴权、缓存（缓存由 L3 通过 C-04 接入）。
- **任务**：`T-M2-01`（ADR-0002 定稿，**第一优先，3 人日时间盒**）→ `T-M2-02`（Repository 接口）→ `T-M2-03`（三驱动）→ `T-M2-04`（方言白名单 + lint）→ `T-M2-05`（迁移/seed）→ `T-M2-06`（连接池/慢查询/探针）→ `T-M2-07`（CI 三库矩阵）→ `T-M2-08`（切换演练）。
- **必须先做并先交付**：W1 结束前交出 `MemoryRepository`（基于 C-03），解阻塞 L2 与 L5。
- **自测**：`pnpm --filter @fw/orm test`（SQLite 单测）+ CI 双库矩阵 + `TC-ORM-001/005/006/007/008`。
- **完成判定**：ADR-0002 已采纳；三库切换演练记录归档；`Repository` 接口冻结评审通过。

### L2 鉴权与权限线（`@fw/auth`，M3）

- **目标**：登录/登出/改密、双 token 轮换与重放检测、RBAC 守卫、审计日志、登录限流与锁定。
- **不做**：前端页面（L4）、权限缓存实现（用 C-04 接口，L3 未就绪时走 `NullCache`）。
- **任务**：`T-M3-01`（五表迁移，先按数据字典落地，存储用 C-03 接口）→ `T-M3-02`（密码策略 + Argon2）→ `T-M3-03`（双 token/黑名单）→ `T-M3-04`（RBAC 守卫 + `@Permissions`）→ `T-M3-06`（审计）→ `T-M3-07`（限流锁定/密钥轮换）→ `T-M3-05`（Passport 多策略）→ `T-M3-08`（验收含越权用例）。
- **必须先做并先交付**：W2 结束前按 C-06 交出**接口清单与响应样例**（供 L4 mock），并在 `apps/example-api` 挂可调用端点。
- **自测**：越权用例必测，`TC-AUTH-001~014`。
- **完成判定**：M3 门禁全绿；越权用例通过；权限码清单与菜单树同步给 L4/L5。

### L3 缓存与队列线（`@fw/cache` + `@fw/queue`，M4 + M7）

- **目标**：缓存三防护（穿透/击穿/雪崩）+ 标签失效 + 分布式锁 + 降级；Job 抽象 + cron + 重试退避 + 死信 + 幂等。
- **不做**：业务缓存使用方；队列管理页（L4 出页面，L3 出接口与指标）。
- **任务（两段）**：M4 段 `T-M4-01`（接口 + memory 驱动，**W1 交付 `NullCache` 解阻塞 L2**）→ `T-M4-03`（`@Cacheable`）→ `T-M4-04`（标签失效）→ `T-M4-05`（三防护）→ `T-M4-02`（redis/cluster）→ `T-M4-06`（分布式锁）→ `T-M4-07`（降级 + `/metrics`）；M7 段 `T-M7-01`→`T-M7-02`→`T-M7-03`→`T-M7-04`→`T-M7-05`。
- **注意**：M7 依赖 M4 的 redis 驱动，两段同线串行；M7 段不占关键路径，可在 M5 之后接。
- **自测**：`TC-CACHE-001~009`、`TC-JOB-001~007`。
- **完成判定**：缓存降级演练通过；队列积压与死信可视化（配合 L4 管理页）。

### L4 管理后台前端线（`apps/admin-web`，M5）

- **目标**：Vue3 + Vite + Element Plus 后台模板，登录、动态路由与按钮权限、四个管理页、字典、审计页、`<CrudTable>`。
- **不做**：后端接口实现；生成器前端模板（L5 负责模板，L4 提供 `views/` 范例与组件 API）。
- **任务**：`T-M5-01`（工程 + 布局，**同时建 mock server**）→ `T-M5-02`（request 层 + 无感刷新）→ `T-M5-03`（登录页/个人中心）→ `T-M5-04`（动态路由 + `v-permission`）→ `T-M5-08`（`<CrudTable>`，**尽早做，L5 模板要复用**）→ `T-M5-05`（用户/角色/权限/菜单四页）→ `T-M5-06`（字典页 + `useDict`）→ `T-M5-07`（审计页）→ `T-M7-06`（队列管理页，M7 阶段）。
- **并行要点**：**完全不等后端**——按 C-06 自建 mock，W1 起即可开工，是启动最早、阻塞最小的线。
- **自测**：`TC-WEB-001~004` + E2E 登录；切真实 API 时只改 `VITE_API_BASE_URL`。
- **完成判定**：构建产物可托管；新业务页 ≤ 80 行；mock 与真实接口契约零差异（集成日比对）。

### L5 CLI 与代码生成线（`@fw/cli` + 模板，M1-07 + M6）

- **目标**：`fw new/dev/build/check/gen` 可用，模板项目 30 分钟跑通；CRUD 生成器产出可读可改源码。
- **不做**：orm 元信息来源（消费 C-07）、前端页面实现（生成模板，范例由 L4 提供）。
- **任务**：`T-M1-07`（CLI 收尾 + templates 补全）→ `T-M6-01`（元信息解析 + 类型映射，**用 fixture 驱动，不等 L1 真实实现**）→ `T-M6-05`（dry-run/diff/覆盖策略，**尽早做，是安全底线**）→ `T-M6-02`（后端模板）→ `T-M6-04`（权限点与菜单 seed）→ `T-M6-03`（前端页面模板，消费 L4 的 `<CrudTable>`）→ `T-M6-06`（模板定制与文档）。
- **自测**：`TC-GEN-001~007`；`fw gen crud order --dry` 必须可离线运行（fixture 模式）。
- **完成判定**：生成物 `*.base.ts` 与业务类分离；`--force` 才覆盖；生成代码通过 lint + 文件头校验。

### L6 质量与交付线（横切）

- **目标**：CI 流水线、门禁脚本、测试用例落地、文档同步、部署模板、每里程碑验收记录。
- **任务**：CI 骨架与缓存（W1）→ 用例录入与门禁（W1–W2）→ 各里程碑验收演示与记录（`T-M1-08`/`T-M2-08`/`T-M3-08`）→ `T-M8-07`（Helm Chart）→ `T-M8-08`（三大演练与终验）；文档同步按「硬规则」执行。
- **特殊职责**：**集成日主持人**——每周五拉齐各线、跑全量 CI、出集成报告、标记阻塞。
- **熔断权**：集成点 CI 不绿时，L6 有权要求全线暂停新功能，只修 CI 与集成缺陷。

### L0 契约与集成线（架构负责人）

- W0 产出：8 份契约文件、目录所有权表（§5）、分支与合并窗口（§8）、CI 就绪检查。
- 全程：契约变更裁决、跨线阻塞仲裁、集成点评审、共享文件代改。
- 投入约 6 人日，分散在全程（W0 集中 1.5 天，之后每周约 0.5 天）。

## 7. 时间轴与集成点

以周为单位，各线并行推进；`I1/I2/I3` 为强制集成点，未通过不得开新任务。

| 周 | L0 | L1 数据 | L2 鉴权 | L3 缓存队列 | L4 前端 | L5 CLI/生成 | L6 质量 |
|---|---|---|---|---|---|---|---|
| W0 | 冻结 8 契约、所有权表、CI 就绪 | 读文档、搭环境、写 ADR-0002 草稿 | 读文档、出接口清单草稿 | 读文档、出 C-04/C-08 草稿 | 读文档、选 UI 基线 | 读文档、盘点 CLI 缺口 | CI 骨架、用例录入 |
| W1 | 契约答疑、首批变更裁决 | **ADR-0002 定稿** + C-03 接口 + `MemoryRepository` | 五表迁移 + 密码策略 | C-04 接口 + memory 驱动 + `NullCache` | Vite 工程 + 布局 + request + **mock server** | CLI 收尾 + templates 补全 | CI 跑通、门禁脚本 |
| W2 | 集成准备 | 三驱动适配（上） | 双 token + 黑名单 | `@Cacheable` + 标签失效 | 登录页 + 个人中心 + 动态路由 | 元信息解析 + 类型映射（fixture） | 用例批量落地 |
| W3 | **I1 集成点** | 三驱动适配（下） | RBAC 守卫 + 审计 | 三防护 + 分布式锁 | `<CrudTable>` + `v-permission` | dry-run/diff/覆盖策略 | 首轮全量 CI + 集成报告 |
| W4 | 契约冻结评审 | 方言白名单 + lint | 限流锁定 + 密钥轮换 | redis/cluster 驱动 | 用户/角色/权限/菜单四页 | 后端代码模板生成 | M2 门禁准备 |
| W5 | — | 迁移工具 + seed | Passport 多策略 | 降级 + `/metrics` | 字典页 + 审计页 | 权限点/菜单 seed 生成 | **M2 验收** |
| W6 | **I2 集成点**（切真实实现） | 连接池/慢查询 + 切换演练 | 联调真实 orm + 越权用例 | 联调 L2/L4 | 切真实 API + E2E | 前端页面模板生成 | **M3 + M4 验收** |
| W7 | — | M2 收尾支持 | M3 收尾 + 支持 L4 | M7 段：Job 抽象 + 驱动 | M5 收尾 + E2E 全量 | 模板定制 + 文档 | **M5 验收** |
| W8 | — | C-07 元信息实现 | 支持生成器权限点 | cron + 重试退避 + 死信 | 队列管理页 | 生成器联调（真实元信息） | **M6 验收** |
| W9 | — | — | — | 幂等/限速/优雅停机 | 支持 M7 页面 | 生成器验收 | **M7 验收** |
| W10+ | M8 拆分（见下） | 租户上下文支持 | 数据权限四档 | transport 切换 | — | — | OTel + Helm + 终验 |

**M8 的多线切法**（W10 起，同样并行）：`T-M8-01/02/03`（租户隔离，L1+L2）｜`T-M8-04`（组织架构与数据权限，L2）｜`T-M8-05`（transport，L3）｜`T-M8-06`（OTel，L6）｜`T-M8-07`（Helm，L6）｜`T-M8-08`（三大演练，L6 主持）。

**集成点定义**

| 集成点 | 时间 | 通过条件 | 不通过的处理 |
|---|---|---|---|
| I1 | W3 末 | 契约零未决项；各线 stub 可互换；全量 CI 绿；前端 mock 与 C-06 一致 | 冻结新功能，只修契约与 CI，顺延 3 天再评 |
| I2 | W6 末 | L2/L4 切真实实现后 E2E 通过；M2/M3/M4 门禁全绿 | 回滚到 stub 模式，L0 组织联合调试 |
| I3 | W9 末 | M5/M6/M7 门禁全绿；三大演练预演通过 | 未通过的里程碑单独延期，不拖其他线 |

## 8. 分支与合并策略（多线并行版）

沿用 [70 规范](./70-engineering-standards.md) 的主干开发 + 短分支，针对多线补充：

| 项 | 规则 |
|---|---|
| 分支命名 | `feat/<lane>-<任务ID>-<短名>`，例：`feat/l1-orm-T-M2-03-pg-adapter`；契约分支 `contract/<C-xx>-<短名>` |
| 生命周期 | ≤ 1 周；跨周任务拆子分支，禁止长分支 |
| 同步频率 | **每日至少 1 次 `git rebase main`**；契约合并当日必须 rebase |
| 合并窗口 | 每日 12:00 与 18:00 两个窗口；`pnpm-lock.yaml` 只允许窗口内变更 |
| WIP 限制 | 每线同时进行 ≤ 2 个任务（对应 80 计划「每人 ≤ 2」） |
| 合并前置 | `pnpm lint && pnpm test && pnpm build && pnpm run check:headers` 全绿；跨目录改动需对应归属线评审 |
| PR 关联 | 描述里必须写：`线号` + `任务 ID` + `涉及契约` + `是否改共享文件` |
| 评审 | 普通包 1 人；框架包 2 人（含 L0）；契约变更必须 L0 审 |

## 9. 同步机制

| 节奏 | 时间 | 内容 | 主持 |
|---|---|---|---|
| 每日站会 | 每工作日 10:00，10 分钟 | 昨天完成 / 今天计划 / 阻塞；阻塞当场指认责任线 | L0 |
| 合并窗口 | 每日 12:00、18:00 | 各线合并已 rebase 的分支，广播共享文件改动 | 各线 |
| 周计划 | 每周一 30 分钟 | 认领任务、确认依赖与契约变更、调整优先级 | L0 |
| 集成日 | 每周五 30 分钟 | 演示已完成项、过 `In Review`、跑全量 CI、更新燃尽 | L6 |
| 里程碑验收 | 里程碑结束半天 | 逐条过门禁与 AC、跑关键演练、填验收记录 | L6 |

**阻塞升级路径**：卡片打 `blocked` 标签并注明解除条件 → 24 小时未解除上升 L0 仲裁 → 48 小时未解除由 L0 决定是否调整线归属或拆任务。被阻塞的线**不允许干等**，必须切换到本线无依赖的任务（每条线都应常备 1 个无依赖后备任务）。

## 10. 人力映射（两种配置）

### 方案 A：小团队（后端 2 + 前端 1 + 测试 0.5，80 计划基线）

| 角色 | 主责线 | 兼线 | 说明 |
|---|---|---|---|
| 架构负责人 | L0 | 评审全员 PR | 约 0.5 人日/周 |
| 后端 A | L1 数据访问 | L3 缓存队列（W4 起） | 两段在本线内串行，避免上下文切换 |
| 后端 B | L2 鉴权权限 | L5 CLI 与生成（W3 起） | L2 接口清单交付后转 L5 |
| 前端 | L4 | — | 全程最独立的一条线 |
| 测试 0.5 + 运维兼 | L6 | — | 集成日主持 + 门禁 |

### 方案 B：AI 会话并行（一线一个独立会话，推荐用于加速）

每条线开一个独立工作副本，会话之间互不干扰，日终由 L0 统一合入：

```bash
# 为每条线建独立工作副本（在 F:/WorkBuddy/TY 下执行）
mkdir -p ../TY-wt
git worktree add ../TY-wt/l1-orm   -b lane/l1-orm
git worktree add ../TY-wt/l2-auth  -b lane/l2-auth
git worktree add ../TY-wt/l3-cache -b lane/l3-cache
git worktree add ../TY-wt/l4-web   -b lane/l4-web
git worktree add ../TY-wt/l5-cli   -b lane/l5-cli
```

详细的 AI 编排方式（波次、prompt 模板、冲突处理、防造假）见 [86-ai-parallel-execution.md](./86-ai-parallel-execution.md)。

给每个会话的边界指令（可直接作为会话开场词）：

> 你是 **L1 数据访问线**。工作目录 `F:/WorkBuddy/TY-l1-orm`，分支 `lane/l1-orm`。
> **只允许修改** `packages/orm/**` 与 `docs/prd/prd-002-*.md`；其他目录一律只读，需要改动请写进待办汇报，不要动手。
> 契约以 `docs/contracts/*.ts` 为准（只读），实现签名必须与契约一致。
> 开工第一件事：读 `docs/85-parallel-workstreams.md` §6 L1 与 `docs/prd/prd-002-database-abstraction.md`，按 W1 排期交付 `MemoryRepository`。
> 提交前跑 `pnpm lint && pnpm test && pnpm build && pnpm run check:headers`，文件头注释按 `docs/70-engineering-standards.md` §1.6（中文、`@author donttemo`、`@created` 当天）。

其余线把线号、目录、W1 首个交付物替换即可。日终 L0 在 `main` 上依次 rebase + 合入，跑全量 CI。

## 11. 风险与对策

| 风险 | 影响 | 对策 | 责任线 |
|---|---|---|---|
| ADR-0002（ORM 选型）久拖不决 | 阻塞 L1 全线与 L5 元信息 | 3 人日时间盒，W1 末必须定稿；超时由 L0 直接裁定并补 ADR | L0 + L1 |
| 契约漂移（实现与契约不符） | 集成点大面积返工 | 契约只读 + 实现不符以契约为准 + I1/I2 强制比对 | L0 |
| 前端 mock 与后端接口不一致 | I2 集成失败 | C-06 双方共同签署；集成日做 mock/真实响应结构自动比对 | L2 + L4 + L6 |
| 三库 CI 矩阵拖慢反馈 | 全线排队等 CI | 本地 SQLite 单测、PR 只跑受影响包、每日一次全矩阵 | L6 |
| 生成器依赖链长（等 orm + 前端） | L5 空转 | 用 fixture 驱动元信息、前端模板后做，把 `dry-run/diff` 提前 | L5 |
| 共享文件互相覆盖 | 构建随机失败 | 窗口制 + L0 代改 + 合并后立即广播 | L0 |
| 单线阻塞导致空等 | 并行度下降 | 每线常备 1 个无依赖后备任务；阻塞 24h 上升 L0 | 全线 |
| 集成地狱（攒到里程碑才合） | 一次性冲突爆炸 | 每日合并窗口 + 每周集成日，禁止攒批 | L6 |

## 12. 今日开工清单（W0）

按先后顺序执行，全部完成后各线即可开工：

| # | 事项 | 责任线 | 产出 |
|---|---|---|---|
| 1 | 建 `docs/contracts/`，写 C-03（Repository）、C-04（Cache）、C-05（Auth）、C-06（API-Web）、C-07（Introspector）、C-08（Queue）六份契约类型文件 | L0 | 6 个 `.ts` 契约文件 |
| 2 | 冻结 C-01 错误码表与 C-02 日志接口（标注「已冻结」并锁定变更流程） | L0 | `40-api-spec.md` 错误码表状态更新 |
| 3 | 建 `apps/admin-web/` 骨架 + `mock/` 目录（L4 接手） | L0 → L4 | Vite 工程可启动 |
| 4 | 建 `packages/orm`、`packages/auth`、`packages/cache`、`packages/queue` 空包骨架（含 `package.json`、`tsconfig.json`、`src/index.ts` 文件头） | L0 | 4 个包 `pnpm build` 通过 |
| 5 | CI 流水线骨架（lint / test / build / check:headers）+ 缓存 | L6 | 首次全绿 |
| 6 | 建 6 条线的工作副本（方案 B）或在任务板建线标签（方案 A） | L0 | worktree 或看板泳道 |
| 7 | 本文在各线周计划过一遍，确认人日与归属 | L0 | 任务板快照更新 |

## 13. 修订记录

| 日期 | 作者 | 摘要 |
|---|---|---|
| 2026-10-12 | donttemo | 初版：7 条工作线划分、8 份契约、目录所有权矩阵、W0–W10 并行时间轴、两种人力映射 |
