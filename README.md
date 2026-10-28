# 通用应用框架（代号 `fw`）

> 一套「框架之上的框架」：用它在 1 天内搭出任意业务系统的可运行骨架，小到内部工具站、大到多租户 SaaS，规模升级时业务代码零重写。
>
> **当前状态：v0.7.5 已发布（2026-10-20）** —— 本次 **v0.7.5 交付 M14（PRD-014）Admin Web 产品化与 SaaS 运营体验升级 B1~B3**：B1 正确性修复（操作原因端到端落库 / 写按钮权限渲染 / 生命周期真实状态驱动 / 查询状态隔离）+ B2 运营 API 闭环（`/api/v1/saas/*` 十四端点：套餐创建与版本发布、订阅分页列表与历史、生命周期状态查询，存储端口 Fake/Prisma 双实现）+ B3 页面产品化（`ConfirmWithReason` 统一原因收集 / `TenantPicker` 租户选择器 / 订阅页列表优先重构 / 套餐页创建+发布+差异预览闭环）。**零迁移 / 零 seed 变更 / 零新错误码**，存量环境纯代码更新即用。发版记录见 [v0.7.5 发布记录](./docs/90-release-v0.7.5.md)，上一版见 [v0.7.0 发布记录](./docs/90-release-v0.7.0.md)（M13 SaaS 运营基础 + 主线 B，真机验收通过）。
>
> v0.6.0（2026-10-17）交付 M11 五阶段（认证核心强化，ADR-0020~0024：轮换 CAS / 生命周期完整性 / Client Fingerprint / 双 Key Ring / Key 可观测）与 M12 W1~W3（可观测与统一契约，ADR-0025~0027：错误三类治理 / requestId-traceId 双 ID 分层 / 运维端点三层边界），外加 **cache 缺陷清单 13 项修复**（标签原子协议 / 锁共享深度 / WRONGTYPE 对齐，Cluster 兼容策略见 ADR-0028）。
>
> **仓库与流水线**：[`donttemos/TY`](https://github.com/donttemos/TY)（private）。CI（GitHub Actions）**四作业全绿**（构建 / 单测 / 静态门禁 + sqlite/postgres/mysql 三库集成矩阵 + M13 端到端冒烟 `smoke-saas-ops` 22/22），版本冻结与可复现构建见 [docs/48](./docs/48-reproducible-builds.md)。

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
| 异步任务 | 进程内存任务中心 `JobCenterService` + `/jobs/:id/*` 任务面（ADR-0013） |
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
    config-center/            # M9 配置中心（端口 + file 适配 + 白名单热更管道）
    db/ cli/                  # M2 数据库抽象 + 脚手架（含 db:migrate/rollback/seed）
    auth/                     # M3 鉴权与权限
    cache/                    # M4 缓存
    queue/                    # M7 队列与调度
    tenant/ transport/ telemetry/  # M8 多租户 / 传输层 / 链路追踪
    saas/                     # M13 SaaS 运营领域（套餐/订阅/配额/用量/生命周期，端口驱动 ADR-0029~0031）
  templates/
    admin/ api/ cms/          # 项目模板（M5 起）
  apps/
    example-api/              # 示例应用（每里程碑的验证载体）
    admin-web/                # M5 管理后台前端（Vue3 + Vite + Element Plus，C-06 mock 可独立运行）
  deploy/                     # M8 部署模板（T-M8-07）+ 裸机 / 1Panel 部署资产
    helm/fw-app/              # Helm Chart（探针/HPA/PDB/迁移 Job/worker/admin-web + README）
    docker-compose.prod.yml   # 中档部署编排（app/worker/postgres/redis/nginx/migrate）
    nginx/fw.conf             # 中档 Nginx 配置（SPA 回退 / API 反代 / 登录限流）
    nginx/fw-host.conf        # 裸机 Nginx 配置（上游 127.0.0.1:3000 + release 软链静态根）
    nginx/fw-1panel-locations.conf # 1Panel OpenResty 站点接入片段（粘贴进面板站点 server{} 内）
    systemd/                  # 进程托管（fw-api.service / fw-worker@.service / fw.env.example）
    scripts/                  # server-bootstrap.sh（Node/pnpm/用户/swap 初始化）、probe-env.sh（部署前环境勘察）、
                              # bare-metal-deploy.sh（release 软链切换 + 迁移 + 健康检查 + 自动回滚）
  scripts/
    check-file-headers.mjs    # 文件头注释校验（中文 / 作者 / 日期）
    check-no-raw-sql.mjs      # 原生 SQL 方言标注检查（TC-ORM-005）
    check-helm-chart.mjs      # Helm Chart 离线渲染 + K8s 清单语义校验（T-M8-07，63 项）
    check-api-parity.mjs      # 前后端接口对撞门禁（C-06：admin-web 调用面 ↔ 后端路由面）
    check-no-raw-throw.mjs    # 裸抛检查（ADR-0025 三类治理：②类内部信号行尾标注白名单）
    check-triway-consistency.mjs # 三方一致性门禁（框架包 ↔ example-api ↔ admin 模板，六轴对撞）
    lib/mini-yaml.mjs         # 零依赖极简 YAML 解析器（供上者使用）
    lib/api-parity-core.mjs   # 对撞共享库（路径归一化 / 调用面 / 路由面提取，两个对撞门禁同源）
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
    41-auth-strategies.md     # 认证策略端到端指南（OAuth2 授权码 / API Key 签名约定）
    45-observability-contract.md # 可观测与错误契约手册（M12：错误信封 / 双 ID / 指标段 / 排障样例）
    46-ops-endpoints.md       # 运维端点安全边界矩阵（M12：三层边界 / demo 开关）
    47-saas-foundation-dev-guide.md # M13 SaaS 运营开发指南（领域划分 / ADR-0029~0031 / 任务拆解）
    42-development-environment.md   # 开发环境指南（运行时基线 / 安装步骤 / 端口表 / 环境坑）
    48-reproducible-builds.md       # 可复现构建规范（单一权威 / 版本冻结矩阵 / 构建纪律）
    49-devcontainer.md              # Dev Container 指南（一键同版本开发容器）
    50-test-cases.md          # 测试用例
    60-deployment-ops.md      # 部署与运维手册
    61-bare-metal-deploy.md   # 云服务器裸机部署手册（宿主 nginx，无容器）
    62-1panel-real-deploy.md  # 1Panel 服务器真机部署手册（OpenResty 反代 + 面板托管的数据库）
    63-1panel-real-deploy-verification.md # 上述手册的真机实测记录（2C2G 云服务器完整部署数据 + 5 个真机缺陷）
    70-engineering-standards.md # 编码 / Git / PR 规范
    80-project-plan.md        # 项目计划与任务板
    85-parallel-workstreams.md # 并行开发工作线划分（契约 / 所有权 / 集成点）
    90-release-v0.7.5.md      # v0.7.5 发布记录（M14 B1~B3：正确性修复 + 运营 API 闭环 + 页面产品化）
    90-release-v0.7.0.md      # v0.7.0 发布记录（M13 SaaS 运营基础 + 主线 B + 真机验收结论）
    90-release-v0.6.0.md      # v0.6.0 发布验收报告（M11 五阶段成版 + M12 W1~W3 + cache 修复 13 项）
    90-release-v0.5.5.md      # v0.5.5 发布验收报告（M10 P2/P3 成版：E-08~E-17 + PRD-011 立项 + 驱动修复 26 项）
    90-release-v0.5.0.md      # v0.5.0 发布验收报告（PRD-010 P0+P1：多实例收口 + OAuth2/apikey 端到端）
    90-release-v0.4.0.md      # v0.4.0 发布验收报告（配置中心与热更新 + 管理面补齐）
    90-release-v0.3.0.md      # v0.3.0 发布验收报告（真机可用性收口）
    94-redis-cluster-live-test.md # L-04 收口：Redis Cluster 真机实跑实测记录
    94b-queue-transport-cluster-live-test.md # E-06 收口：bullmq/transport 在 Redis Cluster 上的实跑实测
    95-doc-audit.md           # 文档一致性核对报告
    97-reproducibility-verification.md # 可复现性验证清单（版本矩阵 / 干净构建五步 / 行为抽检）
    96-db-readiness-probe-issue.md # 修复项登记：/ready 的 db 就绪探针为启动期一次性标志（非实时探测）
    99-admin-web-enhancement-and-fixes.md # 管理后台前端功能补充与缺陷修复方案
    adr/                      # 架构决策记录 0001–0015
    prd/                      # 按功能 / 迭代拆分的 PRD
    archive/                  # 已完结的历史记录归档（2026-10-15 起，避免与活动文档混排）
      release/                #   发布验收报告：90-release-v0.1.0.md、90-release-v0.2.0.md
      database/               #   数据库实测记录：92-test-databases.md、93-db-connectivity-switch-test.md
      queue/                  #   队列演练记录：94-queue-stall-drill.md
      m8/                     #   M8 演练与基线：96-m8-drills.md、97-bench-baseline.md
```

## 快速开始（admin 全栈模板，E-08 已交付）

```bash
# 1. 用模板创建全栈管理后台（server + admin-web 两个工作区成员，fw new 自动注册进 pnpm-workspace.yaml）
fw new my-system --template=admin

# 2. 服务端：建库 + 种子 + 启动（首次登录 admin / Admin@123456，立即改密）
cd my-system/server
# 服务端依赖已随仓库根 pnpm i 就位，直接：
pnpm db:migrate && pnpm db:seed
pnpm build && pnpm dev              # http://localhost:3000/health

# 3. 前端（另开终端）
cd ../admin-web && pnpm dev         # http://localhost:5173（dev 代理到 3000）

# 4. 由数据表生成 CRUD（M6 生成 / M16 一条命令到底）
fw gen crud order --dry      # 先看将创建与重写的文件
fw gen crud order            # 生成 + 自动接线 + 建并应用迁移 + 写权限点 + 前后端类型校验
# 只改代码不动库：--no-migrate --no-seed；只校验后端：--fast；放行破坏性迁移：--allow-destructive

# 5. 部署到单机（M16：一条命令，首次问三项，之后零输入）
fw deploy --plan             # 只看计划：镜像标签、新增迁移、迁移风险（无副作用）
fw deploy --seed             # 首次上线：部署并初始化账号/权限（seed 含清场语义，仅空库用）
fw deploy                    # 日常发布：构建 → 备份 → 迁移 → 启动 → 健康检查
fw deploy --rollback         # 回退上一镜像（数据库不回滚）

# 6. 本地可视化工作台（M17：开发者本机工具，与后台平台完全分离）
pnpm --filter @fw/studio-web run build   # 首次需构建工作台前端（未构建时回退内置只读页）
fw studio                    # 在 127.0.0.1:4310 起服务并打开浏览器（--no-open 只起服务）
#   Studio = 开发者用（改模型/生成/部署，只在本机，永不部署）
#   admin-web = 产品后台（业务用户用，随应用部署）；两者互不依赖，边界由 check:studio-separation 门禁
#   「AI 建模」页签：自然语言 → 只读模型草案（生成即校验，不写 schema）；「AI 检查」：审生成物

# 7. AI 能力（模型路由在页面里填：Studio 右上角「AI 路由」）
fw studio                    # 打开后填接口地址 / 密钥；模型名点「从地址获取」下拉选（可手填）；存 ~/.fw/studio-ai.json，不写项目、不回显
#   数据模型页「＋ 从 JSON 导入」可粘贴 {models:[…]} / {Tag:{fields}} 等结构，识别成草稿后再预览写入
#   也可用环境变量（CI 或无界面场景）：FW_AI_API_KEY（必填）/ FW_AI_MODEL（必填）/ FW_AI_BASE_URL（可选）
#   优先级：页面配置 > 环境变量；保存即时生效，无需重启
fw review --dry              # 先看「哪些代码会发出去」，不联网、不需要密钥
fw review order --chunk-kb=12  # 大项目按体积分片（默认 24KB/片，越小越稳、调用次数越多）
#   --split=model：按模型分组（同模型文件一包，shared 接线文件预算内随组发送）
#   --per-file / --split=file：一个文件一次调用（失败隔离、行号准；跨文件问题更难发现）
#   --raw：额外打印模型原文（默认只打印去重后的 P0/P1/P2 汇总）
#   结论格式：[P0|P1|P2] 文件:行 — 问题 → 建议；审查只读，不写盘
#   Studio 生成页同款入口：「AI 检查」；「AI 建模」页：自然语言 → 草案 → 一键导入设计器（草稿，不写盘）

# 8. 黄金链路验收（M16：一条命令看结论，不手工敲几十条验证命令）
fw verify --target=ci        # 仓库内建全新项目 → 建模 → 生成 → 迁移/种子 → 启动 → 浏览器 CRUD
fw verify --target=real --url=https://<域名>   # 验证已部署实例（健康检查 + 浏览器 CRUD）
```

## 能力矩阵

| 能力 | 实现 | 里程碑 | 状态 |
|---|---|---|---|
| 配置 / 日志 / 错误码 / 健康检查 | `@fw/core` `@fw/config` `@fw/logger` | M1 | ✅ 已完成 |
| 数据库抽象与多库切换 | `@fw/db`（Repository 契约 + Prisma 适配 + 方言白名单 + 迁移工具 + 慢查询观测） | M2 | ✅ 已完成 |
| 鉴权与权限 | `@fw/auth`（双 token 轮换 + RBAC 五表 + 多策略 + 审计 + 登录加固） | M3 | ✅ 已完成 |
| 缓存 | `@fw/cache`（统一 CacheService + memory/redis/cluster 驱动 + 三防护 + 标签失效 + 分布式锁 + 降级与指标） | M4 | ✅ 已完成 |
| 管理后台模板 | `apps/admin-web`（Vue3 + Vite + Element Plus：登录、动态路由、按钮级权限、用户/角色/菜单/字典/审计页、`<CrudTable>` 标准组件；mock 全链路冒烟 40/40、单测 29） | M5 | ✅ 已发布 v0.2.0 |
| CRUD 代码生成器 | `@fw/cli gen`（schema 解析 + 类型映射 + 模板引擎 + 后端/前端/seed 生成 + dry-run/diff/回滚；模板外置 `templates/codegen/`；单测 116 / 覆盖率 94.7%） | M6 | ✅ 已发布 v0.2.0 |
| 队列与定时任务 | `@fw/queue`（统一 Job 抽象 + memory/bullmq 双驱动 + `@JobHandler`/`@Cron` 自动扫描 + 重试退避 + 死信重放 + 幂等 + 令牌桶限速 + cron 分布式锁 + 优雅停机 + 队列管理页；单测 135 / 覆盖率 93.1%、example-api 冒烟 31/31 含真实 Redis 失速恢复演练 TC-JOB-008） | M7 | ✅ 已发布 v0.2.0 |
| 多租户与规模化 | `@fw/tenant`（三级回退租户解析 + fail-closed + 上下文透传）+ `@fw/db` TenantDataSource（dedicated 独立库路由：懒创建 + LRU/空闲淘汰 + Repository 按上下文选路）+ `@fw/auth` 数据权限四档（`DataScopeOrgPort` + all/org_below/org/self 解析与详情越权校验 + `departments`/`user_department` 模型）+ `@fw/transport` 传输层（in-process/redis 双驱动端口 + redis RPC 协议 + `@TransportHandler` 声明式注册 + 客户端代理，切换不改调用方代码）+ `@fw/telemetry` 链路追踪（OTel：HTTP 中间件 + 尾采样错误全采 + OTLP 导出 + 日志 span 桥接 + DB/缓存/队列/传输插桩）+ **部署模板（Helm Chart + compose + Nginx）与三大演练**；冒烟 48/48 + 17/17 + 14/14，演练 25/25、Chart 校验 63/63 | M8 | ✅ 已发布 v0.2.0（条件通过） |
| 配置中心与热更新 | `@fw/config-center`（ConfigCenterPort + 本地 file 适配 mtime 轮询 + 原子写 + 单一生效管道：校验→审计→持久化→应用→通知，fail-keep / 先审计后生效）+ 热更新白名单 11 键从 env-schema 键注册表派生（完整性单测防键集漂移）+ 四框架服务订阅热更（Logger / Cache / Queue / OTel / Tenant）+ `/api/v1/configs` 查改端点（5001/5002/5003 错误码段）+ admin 参数配置页与变更历史 + mock 同构；单测 34/34，`smoke-config.mjs` 27/27、`smoke-mock` 119/119 | M9 | ✅ 已发布 v0.4.0 |
| 文件存储端口 | `@fw/storage`（StoragePort + local/s3 双驱动 + `STORAGE_DRIVER` 枚举装配（非法取值启动即失败）+ 类型/大小白名单默认收紧 + 服务端生成存储 key 免疫路径穿越；S3 走 optional peer 懒加载，local 零依赖）+ `/api/v1/files` 三端点（上传 `file:create` / 元数据与下载登录即可）+ codegen 附件字段（`*FileId` → FileUpload 上传控件）+ mock 逐字节同构与 admin 模板收编（决策见 [ADR-0016](./docs/adr/0016-storage-port-fw-storage.md)）；单测 45/45、smoke-mock 140/140、smoke-template-admin 7/7 | M10（PRD-010 E-09） | ✅ 已交付（Unreleased） |
| 认证核心 M11 系列 | refresh 轮换 CAS（单 replacement + AES-GCM grace 恢复 + replay 族撤销）+ 生命周期完整性 + Client Fingerprint + 双 Key Ring + Key 可观测（ADR-0020~0024）；auth 单测 224 | M11（PRD-011） | ✅ 已发布 v0.6.0 |
| 可观测与统一契约 | 错误三类治理 + 判别符 + 审计六列（ADR-0025）+ requestId/traceId 双 ID 分层与 ALS 扩展（ADR-0026）+ 运维端点三层边界（ADR-0027）+ 缓存标签 Cluster 兼容策略与修复 13 项（ADR-0028） | M12（PRD-012 W1~W3） | ✅ 已发布 v0.6.0 |
| SaaS 运营基础 | `@fw/saas` 领域包（套餐版本化 / 订阅 / 生效配额 = 覆盖 ?? 默认 / 用量幂等与硬限额原子扣减 / 五态生命周期，端口驱动 ADR-0029~0031）+ `/api/v1/saas/*` 九端点（ops:saas:* 读写分离）+ 冻结 Guard 4031 + 到期任务（@Cron 分布锁）+ `fw_saas_*` 指标段 + admin-web 运营四页；saas 26/26、smoke-saas-ops 22/22（入 CI）、并发零超发集成 9/9 | M13（PRD-013） | ✅ 已发布 v0.7.0（真机已部署验收） |

## 文档索引

| 文档 | 内容 |
|---|---|
| [愿景与范围](./docs/00-vision-scope.md) | 目标、非目标、边界、规模分档、成功指标（1 页） |
| [验收标准](./docs/10-acceptance-criteria.md) | 完成定义、里程碑门禁、非功能基线、三大演练、验收流程 |
| [架构设计与技术方案](./docs/20-architecture.md) | 分层架构、模块职责、请求链路、各能力技术方案、部署与演进、ADR 摘要 |
| [原型与 UI](./docs/25-ui-prototype.md) | 设计令牌、页面清单与路由、布局与关键页线框、组件与交互规范、响应式 |
| [ER 图与数据字典](./docs/30-data-dictionary.md) | 建模约定、权限/系统/租户三域 ER 图、15 张表字段字典 |
| [API 文档](./docs/40-api-spec.md) | 通用约定、错误码、10 类接口清单、限流与幂等、版本策略 |
| [认证策略端到端指南](./docs/41-auth-strategies.md) | OAuth2 授权码端到端（配置 / 流程 / 反向验证清单）与 API Key 签名约定（算法 / 示例 / 路由声明） |
| [可观测与错误契约手册](./docs/45-observability-contract.md) | 错误信封字段级契约、requestId/traceId 双 ID 分层、日志身份字段、auth/security 指标段、审计检索键与「replay 一次拉全链」排障样例（M12/PRD-012） |
| [运维端点安全边界矩阵](./docs/46-ops-endpoints.md) | 全仓 @Public/公开路径逐条登记（必要性/暴露面/敏感度/环境约束）、三层边界模型、demo 自检面开关（M12/PRD-012） |
| [SaaS 运营基础开发指南](./docs/47-saas-foundation-dev-guide.md) | 套餐/订阅/配额/用量/生命周期领域划分、ADR-0029~0031 契约、M13 任务拆解（PRD-013） |
| [开发环境指南](./docs/42-development-environment.md) | 运行时基线（Node 22.22.2 / pnpm 11.6.0）、安装步骤、常用命令、端口表、已知环境坑 |
| [可复现构建规范](./docs/48-reproducible-builds.md) | 单一权威来源、版本冻结矩阵（.nvmrc/CI/devcontainer/真机脚本）、安装构建纪律、平台差异登记 |
| [Dev Container 指南](./docs/49-devcontainer.md) | 一键同版本开发容器（基镜像/后置命令/端口转发/常见问题） |
| [可复现性验证清单](./docs/97-reproducibility-verification.md) | 工具链版本矩阵逐项核对 + 干净构建五步 + 门禁/行为一致性抽检（升级后必须重跑） |
| [部署与运维手册](./docs/60-deployment-ops.md) | 三档部署、配置清单、备份恢复、监控告警、故障 Runbook、升级回滚 |
| [云服务器裸机部署手册](./docs/61-bare-metal-deploy.md) | 不用容器的服务器部署：systemd 进程托管、release 软链发版与秒级回滚、nginx 静态托管与 HTTPS、数据库档位与 provider 约束、备份监控与排障速查 |
| [1Panel 真机部署手册](./docs/62-1panel-real-deploy.md) | 已有 1Panel 面板的服务器落地：OpenResty host 网络反代、容器化数据库的宿主端口接入、PostgreSQL schema 变体与迁移重建、2C2G 内存约束（V8 堆 + cgroup MemoryMax）、站点目录与 HTTPS |
| [1Panel 真机部署验证报告](./docs/63-1panel-real-deploy-verification.md) | 上述手册在腾讯云 2C2G4M 上的**完整实测记录**：逐项耗时与内存数据、三条约束的实测结论、端到端冒烟结果、**5 个只有真机才会暴露的缺陷**（队列权限缺失、dedicated 租户连接串、pnpm bin 时序、迁移计数、镜像配置）与结清后的遗留清单 |
| [M15 真机验收报告](./docs/64-m15-real-machine-acceptance.md) | M15 审计线在 cs.donttemo.top 的部署与端到端验收：七类事件查库取证、四档 dataScope 与详情越权、租户隔离端到端、导出范围与脱敏扫描、三处同口径；单租户档位/配置中心/归档三项环境限制与 4 条真机缺陷线索，零 AC 勾选 |
| [CHANGELOG](./CHANGELOG.md) | 版本规则与变更记录（**v0.7.0 已发布**：M13 SaaS 运营基础——套餐/订阅/配额/用量/生命周期全链 + 主线 B 文档四件套） |
| [ADR 架构决策记录](./docs/adr/README.md) | 24 条决策（0001–0027，0017–0019 跳号）：NestJS / Prisma / monorepo / 缓存 / 异步任务 / 鉴权 / 前端 / 可切换性 / 测试 / 代码生成 / 可观测 / i18n / 暗色模式 / 存储端口 / 认证核心 M11 系列 |
| [编码 Git PR 规范](./docs/70-engineering-standards.md) | 编码规范、**中文注释规范（文件头含作者与日期）**、反模式清单、分支与提交约定、PR 与评审规则 |
| [项目计划与任务板](./docs/80-project-plan.md) | 15 周甘特、M1–M8 WBS（40+ 任务）、任务板列与标签、当前快照 |
| [增强功能规划](./docs/81-enhancement-roadmap.md) | v0.5.x–v0.6.x 完善项清单：多实例一致性、规模化遗留、模板生态、体验增强（E-01~E-17，含目标/收益/验收口径） |
| [并行开发工作线划分](./docs/85-parallel-workstreams.md) | 多线并行：7 条工作线与负责人、8 份先行契约、目录所有权矩阵、W0–W10 时间轴与 I1/I2/I3 集成点 |
| [先行契约](./docs/contracts/api-web.ts) | 类型即契约（只读）：C-04 缓存、C-05 权限契约、C-06 前端 API 契约、C-08 Job 契约已冻结，其余 C-03/C-07 待落地 |
| [AI 多线程开工执行手册](./docs/86-ai-parallel-execution.md) | 编排者 + 5 个执行 agent 的拓扑、Wave 0–4 波次、agent 名额与目录白名单、prompt 模板、防造假四道闸 |
| [AI 建模助手提示词](./docs/51-ai-model-designer-agent.md) | Model Designer Agent 内部提示词 v1.0：输入/输出 JSON 契约、逐字段字典（含义/类型/必填/异常）、增量修改协议、异常与降级矩阵、参数分层（业务生成参数 vs 调用参数）、自检 D1~D10（M17/PRD-017 FR-17-24） |
| [贡献指南](./CONTRIBUTING.md) | 三步上手与硬性规则入口 |
| [PRD 索引](./docs/prd/README.md) | 迭代清单与 PRD 模板约定 |
| PRD-001 ~ PRD-009 | 见 `docs/prd/`，每个功能 / 迭代一份 |
| [v0.6.0 发布验收报告](./docs/90-release-v0.6.0.md) | 「M11 认证核心强化 + M12 可观测与运维边界 + @fw/cache 缺陷修复」发布记录：M11.1~11.5（ADR-0020~0024）、M12 W1~W3（ADR-0025~0027）、cache 13 项修复与双驱动契约测试、升级影响（三批迁移、reseed `ops:read`、配置键 97→120、CSV 15 列、`@Cacheable` 键升级一次性失效）、验证证据（~1500 例 + 门禁七道 + CI 矩阵）与遗留问题 |
| [修复项：db 就绪探针非实时](./docs/96-db-readiness-probe-issue.md) | 独立登记（P2，不混入 Redis 双节点验收）：`/ready` 的 db 探针是启动期一次性标志，启动失败后恢复仍报 fail、运行期断连仍报 ok；证据、根因（`createDbReadinessProbe`）、建议修法（带超时实时探测 + 防抖）与验收标准 |
| [v0.5.5 发布验收报告](./docs/90-release-v0.5.5.md) | 「M10 P2/P3 在途交付整体成版」发布记录：E-08~E-17 交付清单、驱动审查修复 26 项、PRD-011 立项、升级影响（配置键 80→97、新增表 4 张、新权限点 2 个）、验证证据（1205 例 + 专项冒烟 + 静态门禁）、发布产物（commit/tag/CI）与遗留问题 |
| [v0.5.0 发布验收报告](./docs/90-release-v0.5.0.md) | 「多实例一致性收口 + 认证策略端到端」发布门禁逐条判定（E-01~E-04/E-06/E-07 的 AC 证据）、升级影响（配置键 65→80、契约订正、零迁移零 seed）、验证证据清单（单测 + 冒烟 + 静态 4 项）、遗留问题与发布结论 |
| [v0.4.0 发布验收报告](./docs/90-release-v0.4.0.md) | 「配置中心与热更新 + 管理面补齐」发布门禁逐条判定、升级影响（种子语义变更：新增参数配置/租户菜单与权限点）、验证证据清单（单测 + 冒烟 8 套 + 静态 4 项 + 真机）、遗留问题与发布结论 |
| [v0.3.0 发布验收报告](./docs/90-release-v0.3.0.md) | 「真机可用性收口」发布门禁逐条判定、升级影响（种子语义与标签键变更）、验证证据清单（单测 782 + 冒烟 203 + 静态 4 项 + 真机）、遗留问题与发布结论（通过） |
| [v0.2.0 发布验收报告](docs/archive/release/90-release-v0.2.0.md) | M5–M8 发布门禁逐条判定、验证证据清单、遗留问题与发布结论（条件通过） |
| [v0.1.0 发布验收报告](docs/archive/release/90-release-v0.1.0.md) | M1–M4 发布门禁逐条判定、验证证据清单、遗留问题与发布结论（条件通过） |
| [测试数据库环境](docs/archive/database/92-test-databases.md) | 远程共用测试实例（MySQL / PostgreSQL / Redis）连接登记与测试切换方式（含明文凭证，仅测试用） |
| [数据库联通性与切换实测](docs/archive/database/93-db-connectivity-switch-test.md) | v0.1.0 三库连通/鉴权实测、T-M2-07 三库一致性矩阵、业务代码零改动证明、Redis 真实实例联调与遗留项 |
| [TC-JOB-008 失速恢复演练](docs/archive/queue/94-queue-stall-drill.md) | 真实 Redis 上 BullMQ 失速恢复演练记录：设计、排障（register 未建消费器 / ensureWorker 自递归死锁与竞态）、MQ_STALLED_MS 与证据 |
| [代码生成模板定制](./templates/codegen/README.md) | `fw gen crud` 模板目录结构、标签语法、可用变量清单、项目级同名覆盖与 `codegen.config.json`（vars / typeOverrides） |
| [文档一致性核对报告](./docs/95-doc-audit.md) | 全量文档交叉核对结果、冲突修复记录与遗留项 |
| [M8 三大关键演练与终验](docs/archive/m8/96-m8-drills.md) | 数据库切换 / 规模演进 / 依赖故障降级三大演练的可复现结果（25/25）、PRD-008 §7 AC 逐条判定与遗留项 |
| [压测基线报告](docs/archive/m8/97-bench-baseline.md) | 登录 / 列表 / 写入三类场景的 QPS 与 P50/P95/P99 实测值、复现命令与性能基线对照 |
| [规模化上线自检清单](./docs/98-scale-checklist.md) | 上线前 CheckList：连接池 / 缓存三防护 / 队列积压 / 慢 SQL / N+1 / 日志采样 / 容量与降级 |
| [管理后台功能补充与缺陷修复方案](./docs/99-admin-web-enhancement-and-fixes.md) | 后台前端「文档已交付 vs 真机可用」逐页核对、待新增/完善模块、15 项缺陷（现象/触发条件/根因/修复后预期行为）、交互流程与数据展示规范、兼容性要求与验证证据 |
| [Helm Chart 使用说明](./deploy/helm/fw-app/README.md) | Chart 目录结构、安装升级回滚、关键 values、探针与迁移 Job 语义、离线校验方式 |

## 路线图

| 里程碑 | 交付 | PRD | 状态 |
|---|---|---|---|
| M1 | 核心骨架 | [001](./docs/prd/prd-001-core-skeleton.md) | ✅ 已完成 |
| M2 | 数据库抽象层 | [002](./docs/prd/prd-002-database-abstraction.md) | ✅ 已完成 |
| M3 | 鉴权与权限 | [003](./docs/prd/prd-003-auth-rbac.md) | ✅ 已完成 |
| M4 | 缓存层 | [004](./docs/prd/prd-004-cache-layer.md) | ✅ 已完成 |
| M5 | 管理后台模板 | [005](./docs/prd/prd-005-admin-template.md) | ✅ 已发布 v0.2.0 |
| M6 | 代码生成器 | [006](./docs/prd/prd-006-code-generator.md) | ✅ 已发布 v0.2.0 |
| M7 | 队列与定时任务 | [007](./docs/prd/prd-007-queue-scheduler.md) | ✅ 已发布 v0.2.0 |
| M8 | 多租户与规模化 | [008](./docs/prd/prd-008-multitenancy-scale.md) | ✅ 已发布 v0.2.0（条件通过） |
| M9 | 配置中心与热更新（L-02 / FR-08 收口） | [009](./docs/prd/prd-009-config-center.md) | ✅ 已发布 v0.4.0 |
| M10 | 增强与规模化收口（E-01~E-17） | [010](./docs/prd/prd-010-enhancement-roadmap.md) | ✅ 已发布 v0.5.x |
| M11 | 认证核心强化（轮换 CAS / 指纹 / Key Ring） | [011](./docs/prd/prd-011-auth-core-hardening.md) | ✅ 已发布 v0.6.0 |
| M12 | 可观测与统一契约（W1~W3） | [012](./docs/prd/prd-012-observability-contract.md) | ✅ 已发布 v0.6.0 |
| M13 | SaaS 运营基础 + 主线 B | [013](./docs/prd/prd-013-saas-operations-foundation.md) | ✅ 已发布 v0.7.0（真机已验收） |
| M16 | 开发体验与部署一体化（三条命令 / 零到一次交互） | [016](./docs/prd/prd-016-dev-experience-and-deploy.md) | 开发中（S1 生成 / S2 部署 / S3 验收已交付；镜像构建与真机链路待验证） |
| M17 | TY Studio 本地可视化工作台 | [017](./docs/prd/prd-017-ty-studio.md) | 开发中（S1 只读工作台、S2 写回内核+接口+设计器、S3 生成页与生成物指纹保护已交付；运行/日志与部署待做） |

## 开发规范

- 分支：`main`（可发布）/ `feat/<prd>-<短名>` / `fix/<issue>`；PR 必须关联 PRD 与验收项。
- 提交：Conventional Commits（`feat(auth): ...`）。
- 门禁：`pnpm lint` + `pnpm test` + 覆盖率阈值 + 变更影响到的 PRD 的 AC 全部勾选。
- 静态门禁（CI 阻断）：`pnpm run check:headers`（文件头）、`node scripts/check-no-raw-sql.mjs`（原生 SQL 方言白名单）、`node scripts/check-no-raw-throw.mjs`（裸抛三类治理，ADR-0025）、`pnpm run check:helm`（Helm 离线渲染）、`pnpm run check:api-parity`（前后端接口对撞）、`pnpm run check:triway-consistency`（框架包 / example-api / admin 模板三方一致性：路由×2、权限码、模型、依赖、配置键、错误码表七轴）。
- 可复现性：版本冻结矩阵与构建纪律见 [48](./docs/48-reproducible-builds.md)；升级 Node/pnpm 或新增框架包后必须全项重跑 [97 验证清单](./docs/97-reproducibility-verification.md)（新包推送前必须 `test:coverage` 而非裸 `vitest run`——CI 阈值与本地裸跑口径不同）。
- 部署模板门禁：`pnpm check:helm`（Helm Chart 离线渲染 + K8s 清单语义校验）；有集群时另跑 `helm template` + `kubectl apply --dry-run=server`。
- 里程碑演练：`pnpm --filter example-api run drill`（三大关键演练，远程段落由 `SMOKE_DB_SWITCH` / `SMOKE_REDIS_URL` 门控）；`pnpm --filter example-api run bench`（压测基线）。
- 文档：能力变更必须同步更新对应 PRD 的「变更记录」，禁止静默改需求。
- 兼容性：任何破坏性变更需在 README 与 PRD 中标注迁移步骤。
