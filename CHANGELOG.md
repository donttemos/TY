# 变更日志

本文件记录项目的所有重要变更。格式遵循 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本 2.0](https://semver.org/lang/zh-CN/)。

> **当前状态：v0.2.0 已发布（2026-10-14）** —— 在 v0.1.0（M1 核心骨架 / M2 数据库抽象层 / M3 鉴权与权限 / M4 缓存层）之上，本次发布**一次性纳入 M5 管理后台前端（PRD-005）、M6 CRUD 代码生成器（PRD-006）、M7 队列与定时任务（PRD-007）、M8 多租户与规模化演进（PRD-008）**，至此 **M1–M8 全部交付**：管理后台模板、CRUD 生成器、队列与定时任务（含真实 Redis 失速恢复演练 TC-JOB-008）、租户三级回退与 dedicated 独立库路由、数据权限四档、transport 双驱动、OpenTelemetry 链路追踪、Helm Chart 与部署模板；三大关键演练 **25/25**、Helm 清单校验 **63/63**、M8 终验判定「条件通过」。运行时为 NestJS 11 / Express 5，dev 工具链 vitest 4 / vite 8，**`pnpm audit` 生产与 dev 全量零漏洞**。验收结论与证据见 [v0.2.0 发布验收报告](./docs/90-release-v0.2.0.md) 与 [M8 三大关键演练与终验](./docs/96-m8-drills.md)。

## 版本与变更规则

- **版本号**：`主版本.次版本.修订号`。`0.x` 阶段次版本可含破坏性变更；`1.0.0` 之后严格按 semver。
- **API 版本**：接口版本走 URL（`/api/v1`），与框架版本号解耦；一个 API 版本废弃前至少并行保留 90 天。
- **变更类型**：`Added` 新增 ｜ `Changed` 变更 ｜ `Deprecated` 即将废弃 ｜ `Removed` 移除 ｜ `Fixed` 修复 ｜ `Security` 安全相关。
- **来源**：需求变更先记入对应 PRD 的「变更记录」，发布时汇总到本文件。本文件只记**对外可见**的变更，内部重构不在此记录。
- **频率**：每个发布版本一条记录；`Unreleased` 区间持续累积，发布时转为版本条目并清空。

## [Unreleased]

### Fixed（真机部署验证：2C2G 云服务器 + 1Panel + PostgreSQL，2026-10-14）

> 在腾讯云 2C2G4M（Ubuntu 22.04 + 1Panel + PostgreSQL 18.6 + Redis 8.10）上完整跑通部署与端到端冒烟，
> 期间暴露 5 个**本地单测与 CI 均为绿、只有走完整真机流程才会出现**的缺陷。实测数据与复现要点见
> [1Panel 真机部署验证报告](./docs/63-1panel-real-deploy-verification.md)。

- **队列管理功能面对任何角色都不可达（功能级）**：M7 的 `/api/v1/admin/queue/*` 共 11 个端点由 `system:queue:list` / `system:queue:manage` 守卫，但 `example-api` 的种子从未创建这两个权限点，故连持有全部已建权限的 `admin` 也返回 `3002 无操作权限`。现随 `FRAMEWORK_PERMISSIONS` 建出并自动授予 admin（权限点 26 → 28）。真机复验：不施加任何手工 SQL，`list` 全部端点与 cron 手动触发均 `code:0`，`alice` 仍被正确拒绝。
- **`dedicated` 独立库租户的连接串写死为 SQLite 路径**：`seed.ts` 的 `DEDICATED_DB_URL` 固定为 `file:./tenant-dedicated.db`，在 PostgreSQL/MySQL 部署下会写入一个 `provider` 与连接串不匹配、**永远连不上**的密文（Prisma 的 provider 在 `generate` 时已固定，故障只会在真正访问该租户时爆发）。现优先取 `SEED_DEDICATED_DB_URL`，未配置时仅当 `DB_DRIVER` 为 `sqlite`（或未设置）才回退本地文件，其他驱动留 `NULL`。
- **`fw` CLI 的 bin 链接缺失，导致迁移与种子不可用**：pnpm 在 install 阶段创建 workspace bin，而那一刻 `packages/cli/dist/index.js` 尚未构建 → `.bin/fw` 被静默跳过（仅一条 WARN），且此后 `pnpm install` 与 `pnpm install --force` 都判 `Already up to date` **不再补建**，`pnpm run db:migrate` 直接报 `fw: not found`（先有鸡还是先有蛋的时序问题）。发版脚本现于构建后删掉应用自身 `node_modules` 重装一次（工作区内该目录只是一组软链，重建约 1.6 s）并断言 `.bin/fw` 可执行。
- **`fw db:migrate` 的迁移数量取自错误目录（误导排障）**：`listMigrations()` 固定读 `prisma/migrations`、忽略 `--schema`，故 `--schema=prisma/pg/schema.prisma` 时打印「共 4 个迁移」而实际只应用 1 个（Prisma 侧行为本就正确，错的是数字）。现由 schema 路径推导迁移目录，`db:rollback` 的目标目录与临时 SQL 路径同步修正。
- **`server-bootstrap.sh` 未配置依赖镜像**：实测该机器上 `registry.npmjs.org` 约 0.86 MB/s（单包元数据 18 s）、`registry.npmmirror.com` 约 18.7 MB/s，**相差约 20 倍**——不换源时 `pnpm install` 会从分钟级拖成小时级。现写入 Node 前缀 / `root` / `fw` 三处 `npmrc`，并给 corepack 指定 `COREPACK_NPM_REGISTRY`；同时在脚本注释中注明**不要依赖镜像的 `latest-v22.x` 索引**（实测陈旧，仍指向 `22.0.0`，而 pnpm 11 要求 Node ≥ 22.13）。

### Added（真机部署验证报告，2026-10-14）

- **`docs/63-1panel-real-deploy-verification.md`**：真机实测记录（**非估算、非设计推演**）。含：被测环境逐项勘察结果；`pnpm install`（415 包 / 1m12s，swap 峰值 197 MB）、`prisma generate`（150 ms，产物 `libquery_engine-debian-openssl-3.0.x.so.node`）、前后端构建（1.74 s）、单 release 体积（612 MB）等实测数字；`/health` `/ready` `systemctl` 记账与各容器内存占用；**回滚实测 6.07 s 且数据完好**；三条容器跨界约束的实测结论（OpenResty `host` 网络、`/opt/fw` 不可见、数据库容器回环可达）与手册未覆盖的三处环境适配（**1Panel Redis 的 `requirepass`**、`.env` 权限对 `fw` 身份读取的影响、**`docker exec -i` 会吞掉远程脚本 stdin 导致静默截断**）；端到端冒烟结果（含真实 Redis 缓存链路、真实 BullMQ 队列链路、多租户 fail-closed）；以及结清后**仍然未验证**的诚实清单（HTTPS 签发、跨进程 worker、Redis Cluster、面板 UI 建档、发版脚本端到端自动执行）。
- **`docs/62-1panel-real-deploy.md` §12 / §4.1**：原「待真机确认」7 项逐条补上实测结论（6 项已结清），并补充手册未覆盖的三处环境适配与更新后的遗留清单。

### Added（云服务器裸机部署资产，2026-10-14）

> 补齐「不用容器」的部署路径：容器档位（单机 Docker / compose / Helm）此前只有编排模板，没有进程托管与宿主侧发版能力。
> 新增资产使云服务器可用 systemd 直接托管 Node 进程，发版以 release 目录 + 软链原子切换 + 健康检查兜底实现可回滚。

- **`docs/61-bare-metal-deploy.md`**：云服务器裸机部署手册——架构与目录布局、服务器与安全组准备、Node/pnpm 安装、配置与 **Prisma provider 约束**（schema 与迁移为 SQLite 方言，切云 RDS 需重建迁移）、构建位置选择（**Windows 本地构建产物不可用于 Linux**：query engine 为平台相关二进制）、首次部署、systemd 托管、nginx 与 HTTPS、备份监控、安全加固、排障速查。
- **`deploy/systemd/fw-api.service`**：应用主服务单元。直连 `node dist/main.js`（不经 pnpm 包装层，保证 SIGTERM 直达）、`Restart=always` 自愈、`TimeoutStopSec=30` 对接优雅停机、`SuccessExitStatus=0 143`、`ProtectSystem=strict` + `ReadWritePaths=/opt/fw/shared/data` 最小权限加固。
- **`deploy/systemd/fw-worker@.service`**：队列消费者模板单元，`TRANSPORT_ROLE=handler`；因应用启动即监听 HTTP，用 **端口隔离**（实例名即端口尾号，`@01` → 3001）避免与主服务争用 3000。
- **`deploy/systemd/fw.env.example`**：裸机 EnvironmentFile 样例，含语法差异提示（不支持 `export`/变量插值、`$` 会被展开）、密钥生成命令、SQLite 与云 RDS 两档配置，以及 OTel 可选依赖在 `--prod` 安装下会缺失的提醒。
- **`deploy/scripts/bare-metal-deploy.sh`**：宿主侧发版脚本。常驻 clone + `git archive` 导出（只出被跟踪文件）→ 装依赖 → `prisma generate` → 拓扑序构建（`pnpm --filter "example-api..."`）→ 前端构建 → **迁移先行** → `mv -Tf` 原子切换软链 → 重启 systemd → 健康检查轮询；失败自动切回上一 release 并重启，保留最近 5 份历史版本；`--rollback` 支持秒级回退。
- **`deploy/nginx/fw-host.conf`**：裸机 nginx 配置，与容器版 `fw.conf` 职责一致，差异为上游改 `127.0.0.1:3000`、静态根指向 `current` 软链；补 `/assets/` 长缓存 + `index.html` 不缓存（发版即时生效）与基础安全响应头。

### Added（1Panel 真机部署适配与 PostgreSQL schema 变体，2026-10-14）

> 面向「已有 1Panel 面板的云服务器」补齐落地路径：应用仍以 systemd 跑在宿主机（不用容器），复用面板托管的 PostgreSQL/Redis 与 OpenResty 反向代理。
> 与上一段的裸机资产共享同一套 systemd 单元与发版脚本，差异集中在反代与静态托管（见 `docs/62-1panel-real-deploy.md` §13 对照表）。

- **`apps/example-api/prisma/pg/schema.prisma` + `prisma/pg/migrations/`**：**PostgreSQL 生产变体**。Prisma 的 `datasource.provider` 是编译期字面量、迁移 DDL 依方言生成，仓库默认 schema 及其四个迁移均为 SQLite 方言，**不能直接应用到 PostgreSQL**。本变体与默认 schema 的模型段**逐字节一致**（12 个模型，`md5` 相同，校验命令见手册 §4.2），仅 `provider` 与迁移目录不同，用 `--schema` 显式切换。初始迁移由 `prisma migrate diff --from-empty --to-schema-datamodel` 生成：**12 表 / 29 索引**，`TIMESTAMP(3)` / `JSONB` / `BIGINT`，零 SQLite 残留。**刻意不改编默认 schema**，故本地开发与 CI base 作业（依赖 sqlite + `dev.db`）完全不受影响。
- **`docs/62-1panel-real-deploy.md`**：1Panel 真机部署手册。核心是把三条**容器跨界约束**讲清并给出做法——① 1Panel 的 OpenResty 是**容器但 host 网络**，反代可用 `127.0.0.1:3000` 命中宿主上的 systemd 服务；② 其**文件系统隔离**，容器内看不到 `/opt/fw`，故前端产物必须同步到面板站点目录，**不能**像宿主 nginx 那样 root 到 release 软链；③ MySQL/PG/Redis 均为**容器**，应用在宿主机侧必须用 `127.0.0.1:<宿主映射端口>`，写容器名必然 `ECONNREFUSED`。另含 2C2G 内存取舍、验收清单、排障速查与**未验证项清单**（明确区分「已静态校验」与「待真机确认」）。
- **`deploy/scripts/server-bootstrap.sh`**：服务器初始化脚本（幂等）。Node 22 LTS 从 npmmirror 取官方二进制直解（不走 NodeSource，国内带宽更稳）→ `corepack` 激活 `pnpm@11.6.0` → 创建系统用户 `fw` 与 `/opt/fw/*` 目录骨架 → 创建 2G swap 与内核参数（`vm.swappiness=10` / `vm.overcommit_memory=1`）。**swap 是 2C2G 全量构建的硬前提**：`pnpm install` + `tsc` 峰值内存约 1.2~1.6G。
- **`deploy/scripts/probe-env.sh`**：部署前**只读**环境勘察。探测 1Panel 版本与安装目录、容器网络模式与端口映射、数据库宿主可达性、80/443/3000 占用、外网可达性，并**自动判定 OpenResty 是否为 host 网络**（直接决定反代地址该怎么写）、给出构建可行性结论。输出不含任何密码。
- **`deploy/nginx/fw-1panel-locations.conf`**：1Panel 站点接入片段。因面板自己管理 `server_name` / `listen` / 证书指令（整份覆盖会被面板改回），本文件只提供可粘贴进既有 `server { }` 的 `location` 块（静态长缓存、SPA 回退、`/api` 反代、登录限流、`/health`）与 http 层级片段，并明确「HTTPS 走面板 Acme 流程，不要手写 443 块」。
- **`deploy/scripts/bare-metal-deploy.sh`**：新增三个可覆盖变量——`PRISMA_SCHEMA`（切换 schema 变体，`prisma generate` 与 `db:migrate` 同时生效）、`WEB_SYNC_DIR`（前端产物 rsync 到 1Panel 站点目录，带 `--delete` 与目标目录存在性校验）、`COREPACK_HOME`（复用 bootstrap 预热的 pnpm 缓存，避免重复下载）。
- **`deploy/systemd/fw-api.service` / `fw-worker@.service`**：针对小内存机器补资源约束——`NODE_OPTIONS=--max-old-space-size`（API 640 / worker 512）与 `MemoryHigh`/`MemoryMax`（API 768M/1024M，worker 384M/512M）。作用是让内存压力由 **cgroup OOM killer 只杀本进程**（systemd 随即按 `Restart=always` 拉起），而非整机 OOM 时内核按 `oom_score` 误杀 PostgreSQL/MySQL 把数据库一并带走；`ExecStart` 路径同步为 bootstrap 创建的 `/usr/local/bin/node`。
- **`deploy/systemd/fw.env.example`**：数据库段落改写为「两套 schema 如何选 + `PRISMA_SCHEMA` 归位」，并补 1Panel 本机容器 PostgreSQL 的连接串样例（host 必须写 `127.0.0.1`、端口取面板的宿主映射端口）。

### Fixed（工程门禁扫描范围与跨平台行尾，2026-10-14）

- **`scripts/check-file-headers.mjs` 的 `SCAN_DIRS` 未包含 `deploy`**：该目录下的 `.sh` / `.yml` / `.yaml` **从未被文件头门禁覆盖**——既有的 `deploy/helm/fw-app/**`、`deploy/docker-compose.prod.yml`，以及上一轮新增的 `deploy/scripts/bare-metal-deploy.sh` 全都在扫描范围之外。这违反「每源文件强制文件头」的仓库规范，却不会让门禁变红，属**静默失效的检查**。现将 `deploy` 纳入扫描（受检文件 347 → 366），并补齐 `docker-compose.prod.yml`、`helm/fw-app/Chart.yaml`、`helm/fw-app/values.yaml`、`helm/fw-app/values-prod.yaml` 四个文件的头注释（`@created` 取各自首次提交日期）。`pnpm run check:helm` 回归 **63/63**，未受影响。
- **仓库缺 `.gitattributes`，在 `core.autocrlf=true` 下 shell 脚本存在 CRLF 风险**：本项目是「Windows 开发 + Linux 部署」的混合环境。本机 `core.autocrlf=true`，checkout 会把文本文件转成 CRLF；而带 CRLF 的 `.sh` 上传到 Linux 会直接报 `bad interpreter: /usr/bin/env bash^M`——文件内容看起来完全正常，编辑器也不显示 `^M`，属最难排查的一类部署故障。现新增 `.gitattributes` 显式声明：文本文件与脚本（含 `.sh`/`.prisma`/`.conf`/systemd 单元）一律 **LF**，仅 `*.bat` / `*.cmd` 保留 CRLF；并把 `.db` / `.node` / `.so` / 字体等标记为 `binary`，防止行尾转换损坏文件。`git add --renormalize .` 验证仓库内既有文本文件本已是 LF，故本次为纯加固、**无任何内容变更**。

### Fixed（v0.2.0 推送后首次真实 Actions 运行排障，2026-10-14）

> 仓库首次推送 GitHub 后 CI 在真实 Actions 上连续暴露 6 处**只在干净环境（无本地 `.env`、无既有 `node_modules`/`dist`）才复现**的缺陷，逐层修复后 [run 38513416509](https://github.com/donttemos/TY/actions/runs/38513416509) 四大作业（基础门禁 24 步 + 三库集成矩阵）全绿，耗时 4m28s。以下修复均不改变已发布产物的运行期行为。

- **流水线无法启动：`pnpm/action-setup@v4` 与 `packageManager` 版本双指定**：action 配了 `version: 11`，根 `package.json` 又有 `packageManager: pnpm@11.6.0`，第 3 步即抛 `ERR_PNPM_BAD_PM_VERSION`，后续步骤全 skipped。移除 action 的 `version` 输入，统一以 `packageManager` 为准（两处 job）。
- **`pnpm install --frozen-lockfile` 中断：`allowBuilds` 存在自动写入的占位值**：`pnpm-workspace.yaml` 中 `msgpackr-extract` / `protobufjs` 的值为占位串 `"set this to true or false"`（非布尔），在 pnpm 11 默认 `strictDepBuilds=true` 下抛 `ERR_PNPM_IGNORED_BUILDS`。改为显式 `false`（二者构建脚本非运行期必需：msgpackr-extract 缺失时 msgpackr 回退纯 JS，protobufjs 的 postinstall 仅服务其 CLI）。
- **构建失败：缺少 example-api 的默认 `@prisma/client` 生成**：流水线只为 `@fw/db` 生成自定义输出的 `prisma/test-client`，从未生成默认 client；干净环境下该包仅为 postinstall 空壳，`example-api` 的 `tsc` 报 `Prisma.InputJsonValue` / `Prisma.DbNull` 不存在。构建步骤中补 `example-api` 的 `prisma generate`。
- **构建失败：`example-api` 的 `.env` 必须早于 `prisma generate`**：生成的 client 会把「生成时 `.env` 是否存在」固化进运行期环境解析；原先 `.env` 在 M3 步骤才创建，导致运行期读不到 `DB_URL`（`seed.ts` 报 `PrismaClientInitializationError`）。新增前置步骤「准备 example-api 环境文件」，在构建前生成 `.env`。
- **M5 门禁失败：`admin-web` 单测隐式依赖被 gitignore 的 `.env.test`**：`src/utils/token.ts` 的存储启停以 `import.meta.env.VITE_API_BASE_URL` 是否定义判断，而该变量只来自 `apps/admin-web/.env.test`（被 `.env.*` 规则忽略），干净环境下 3 个「无感刷新」用例必挂。在 `vitest.config.ts` 的 `test.env` 中显式注入，单测不再依赖本地 env 文件。
- **集成矩阵失败：作业缺框架包构建**：`integration` 是与 `base` 平行的独立 runner，拿不到 `base` 的 `dist`，而集成用例经 vitest 从源码运行却 import `@fw/*` 的包入口，三库同时报 `Failed to resolve entry for package "@fw/logger"`。新增「构建框架包」步骤（`pnpm --filter "@fw/db..." run build`，自动覆盖 `@fw/db` 全部依赖，避免再维护易漏的手写列表）。

## [0.2.0] - 2026-10-14

> 本次发布纳入 **M5–M8** 四个里程碑的完整交付（M1–M4 已于 [`[0.1.0]`](#010---2026-10-13) 发布）。以下条目按里程碑倒序排列；M8 与 M7 的验证证据、演练记录与压测基线见对应文档。

### Added（M8 多租户与规模化演进，2026-10-14）

> PRD-008 进行中：T-M8-01（租户上下文与 shared 隔离）、T-M8-02（dedicated 独立库路由）、T-M8-04（组织架构与数据权限四档）、T-M8-05（transport 切换）与 T-M8-06（OpenTelemetry 链路追踪）已完成实现与验证，未发版。

- **`@fw/tenant`（新框架包）**：三级回退租户解析（子域名 → 请求头 `X-Tenant-Id` → JWT claim，顺序与各级开关可配，PRD-008 §9 定稿）+ TTL 缓存 + fail-closed（缺失/不存在/停用/过期租户 → 403/4001 `TENANT_INVALID`）。
  - **上下文透传**：解析结果经 `@fw/logger` AsyncLocalStorage 传递（`tenantId` / `tenantIsolation` / `tenantDbUrl`），日志自动携带 `tenantId`；dedicated 连接串仅进程内传递，禁入日志/审计。
  - **express 级中间件**：经 `@fw/core` bootstrap 新增的 `beforeListen` 钩子以 `app.use` 注册（Nest 模块级 `forRoutes` 在 Express 5 下不覆盖其他模块路由）；运维路径（`/health`、`/ready`、`/metrics`）豁免。
  - **配置**：`@fw/config` 新增 `TENANT_ENABLED` / `TENANT_ORDER` / `TENANT_HEADER_NAME` / `TENANT_BASE_DOMAIN` / `TENANT_JWT_CLAIM` / `TENANT_CACHE_TTL` / `TENANT_DB_KEY` 共 7 键。
- **`@fw/db` 租户数据源路由（T-M8-02）**：`TenantDataSource` 按请求上下文选路——`tenantVerified` + `isolation=dedicated` + `dbUrl` 三者齐备才路由到独立库 client（懒创建、按租户缓存），shared / 未认证 / `@IgnoreTenant` 一律回退默认数据源；LRU 上限（默认 32）+ 空闲淘汰（默认 10 分钟）双策略，淘汰即断开；`onModuleDestroy` 全量断开。`PrismaRepository` 新增 `options.dataSource`，每次调用按上下文选路（读/写/事务同一语义），未注入时行为与旧版逐字节一致。
- **`@fw/auth` 越权防护（T-M8-03 地基）**：守卫校验「登录用户归属当前租户」，不匹配即 403/4001；`@IgnoreTenant()` + `system:tenant:ignore` 权限的跨租户维护记审计（`action='grant'`）；`toAuthUser` 补 `tenantId` 映射（bigint → 十进制字符串）。
- **组织架构与数据权限四档（T-M8-04，PRD-008 FR-04/FR-05）**：在 PRD-003「仅本人」之上落地 **`all` / `org_below`（本部门及全部下级）/ `org`（本部门）/ `self`** 四档数据范围，多角色取最宽。
  - **`@fw/auth` 框架层**：新增 `DataScopeOrgPort`（部门查询端口，框架不感知表结构）与 `org-tree.ts` 的 `collectDescendantIds`（BFS 闭包：防环 / 去重 / 容忍悬空父）；`resolveDataScopeFilter(user, org?)` 四档完整解析，**fail-closed 收敛**——无组织端口 / 用户无部门归属 / 范围无法识别一律收敛 `self` 并标记 `pendingScopes`，绝不放宽；`assertWithinDataScope(user, targetOwnerId, org?)` 详情越权校验，范围外目标抛 403/3002（先于存在性查询，不泄露存在性）。
  - **数据模型**：`departments`（UUID 主键 + `parentId='0'` 顶级 + `tenantId` 逻辑隔离列 + 软删）与 `user_department`（多对多 + `isPrimary`）两张表及迁移 `20261014090000_add_departments`。
  - **查询过滤注入**：`UserQuery.departmentIds` / `AuditQuery.userIds` **仅由服务端数据范围解析注入，禁止客户端传参**（防越权放宽）；与 `roleId` 同时传入取交集；空集合匹配不到记录。用户列表、角色分配、状态变更、审计列表全链路生效。
  - **DI 适配**：`PrismaAuthStore` 同时实现 `AuthStore` + `DataScopeOrgPort`，经 `DATA_SCOPE_ORG` 令牌工厂适配（启动期方法存在性 fail-fast 校验）。
  - **example-api 种子**：hq → rd → {rd-fe, rd-be}、hq → mkt 五部门树 + `dept_leader`（org_below）/ `dept_member`（org）/ `self_updater`（self）三角色 + 7 个示范账号（bob/carol/dave/erin/frank/grace/selfscope）。
- **example-api**：`tenants` 模型 + 迁移 + 种子（legacy / acme / off / dedicated 四租户，dedicated 的 `db_url_enc` 为 AES-256-GCM 密文）；`PrismaTenantStore` 解密独立库连接串；`/api/v1/demo/tenant-items` 鉴权验证端点；M3 遗留④ refresh 过期记录定时清理（`auth.refresh-cleanup`，分布式锁 + 快照端点）。
- **`@fw/transport`（新框架包，T-M8-05，PRD-008 FR-06 / TC-TNT-005）**：微服务调用语义的传输层——业务模块经端口接口相互调用，`TransportModule.forRoot()` 按 `TRANSPORT_DRIVER` 装配 **in-process**（进程内直连，单体零依赖）或 **redis**（跨进程 RPC）双驱动，**切换只改配置，调用方代码 diff = 0**。
  - **双驱动端口模式**（沿用 M7 `@fw/queue` 先例）：`TransportDriverPort`（register / start / call / ping / handledCount / close）两种实现；`TransportService` 只依赖端口，承载统计埋点（calls / successes / failures / timeouts）与启动/停机编排。
  - **redis RPC 协议**：调用方 `LPUSH <prefix>:req:<address>` 投递信封（含 replyTo / callerId / timeoutMs）→ `BLPOP <prefix>:rpl:<id>` 等应答（按秒粒度循环保证超时精度）→ 读到后 `DEL`；处理方每地址一条阻塞连接 `BRPOP` 1s 轮询消费，执行后 `LPUSH` 应答 + `EXPIRE 60s` 兜底；连接分工（caller 与 worker 分离）防阻塞命令互堵，`maxRetriesPerRequest: 2` 保证 Redis 不可达快速失败。
  - **对等语义**：处理器异常经 `serializeTransportError` 过线、`deserializeTransportError` 按 `ERROR_CODE_META` 重建 BizError——两种驱动下调用方 catch 到同一错误类；处理方执行上限取信封内调用方超时（`withTimeout`），双方超时语义一致。
  - **角色语义**（`TRANSPORT_ROLE`）：`caller` 只发起调用（不起消费循环、本地不解析）/ `handler` 只处理请求 / `both`（默认）两者兼顾——单体部署保持 both，微服务拆分后按进程职责裁剪。
  - **声明式注册与客户端代理**：`@TransportHandler('demo-transport.echo')` 类装饰器 + 启动期 `scanTransportHandlers` 扫描 Nest 容器（对齐 `@JobHandler`）；`createTransportProxy<T>(transport, prefix)` 以 Proxy 把端口方法映射为 `<前缀>.<方法名>` 调用（NON_METHOD_PROPS 黑名单 + 哑构造器，防生命周期钩子与序列化误触发）。
  - **配置**：`@fw/config` 新增 7 个 `TRANSPORT_*` 键（driver / url / prefix / timeoutMs / role / instanceId / shutdownTimeout）；`tcp` / `kafka` 仅预留不入枚举（非法值启动即失败）；redis 缺 `TRANSPORT_URL` 时回退 `CACHE_URL`，两者皆缺**启动即失败**（配置守卫，与 M7 一致）；ioredis 为 optional peerDependency 懒加载，in-process 驱动零 Redis 依赖。
- **example-api 传输演示模块**（`demo-transport`）：`EchoPort` 端口契约 + `ECHO_PORT` 代理工厂（`@TransportHandler('demo-transport.echo')` 提供方）+ `/api/v1/demo-transport/echo`（返回 callerId，冒烟据此判定跨进程）与 `/api/v1/demo-transport/stats`（driver / role / 地址 / 调用与处理计数）；错误映射：BizError 原样 / 超时与驱动不可用→9002 / 未注册→1002 / 其它→9001。
- **`@fw/telemetry`（新框架包，T-M8-06，PRD-008 FR-07 / TC-TNT-006）**：OpenTelemetry 链路追踪——traceId 贯穿 HTTP/DB/缓存/队列/传输，导出 OTLP，日志自动注入 traceId/spanId。
  - **双轨依赖模式**（沿用 M7 ioredis 先例）：`@opentelemetry/api` 为轻量硬依赖（未装 SDK 时全局 no-op，span 非记录态零开销）；`@opentelemetry/sdk-node` + `@opentelemetry/exporter-trace-otlp-http` 为 optional peerDependency 懒加载。**插桩点与框架包解耦**：db / cache / queue / transport 各自只 `import { trace, propagation } from '@opentelemetry/api'`，与负责 SDK 装配的 `@fw/telemetry` 经全局 tracer provider 解耦。
  - **`TelemetryModule.forRoot()`**：按 `OTEL_ENABLED` 装配 SDK（未启用全短路，零开销）；`register({ propagator })` 显式注册 W3C traceparent + baggage 组合传播器（`register()` 不装默认传播器，不注册则跨进程 inject/extract 静默变 no-op）；资源含 `service.name`（缺省 `fw-<APP_ENV>`）与 `service.version`；`onModuleDestroy` flush 在途 span 后 shutdown。
  - **尾采样处理器**（`RatioErrorSamplingProcessor`）：SDK sampler 保持 AlwaysOn（全记录），`onEnd` 决策导出——错误 span（status=ERROR 或 exception 事件）全采；其余按 traceId 低 8 位十六进制归一化与 `sampleRatio` 比较，**同一 traceId 决策恒定**（同链路跨服务不出现半链路）。默认采样率 10%。
  - **HTTP 中间件**：每请求一个 SERVER span，父上下文三级解析（标准 `traceparent` → 框架自有 `X-Trace-Id` 合成远端父 → 根）；span 的 traceId/spanId 回写 `@fw/logger` ALS 与 `X-Trace-Id` 响应头（日志 / trace / 响应头三者同 ID），响应 finish 时按路由模板刷新 span 名（`HTTP GET /:id`），5xx 记 ERROR（4xx 不记，错误全采据此生效）。工厂 `createOtelExpressMiddleware({ enabled })` + `OTEL_MIDDLEWARE` 令牌（对齐 `@fw/tenant` 模式），经 bootstrap `beforeListen` 钩子无条件注册。
  - **日志 span 桥接**：`registerLoggerSpanBridge()` 使 `@fw/logger` 输出的每条日志自动带当前活跃 span 的 traceId/spanId。
  - **跨进程传播（transport）**：调用方 `call` 包 CLIENT span，redis 驱动把活跃上下文 inject 成 `traceparent` 写入 `TransportEnvelope`，处理方 extract 后包 SERVER span——父子跨进程成立（in-process / redis 同一语义）。
  - **异步传播（queue）**：`dispatch` 包 PRODUCER span 并把 traceparent 写入 `JobRecord.traceparent`（随任务过线），`invoke` 从记录提取父上下文包 CONSUMER span——任务执行续接派发链路（跨进程 / 跨重试亦可关联）。
  - **DB / 缓存插桩**：`@fw/db` 的 `$allOperations` 漏斗包 CLIENT span（`db.query <Model>.<op>`，属性 db.system/db.operation/db.collection.name/db.query.duration_ms）；`@fw/cache` 的 `guarded` 守卫点包 CLIENT span（`cache.<op>`，属性 db.system=cache/cache.operation/cache.driver）——均只依赖 api 的 no-op 语义，未启用追踪时零行为变化。
  - **配置**：`@fw/config` 新增 5 个 `OTEL_*` 键（enabled / serviceName / exporterUrl / sampleRatio / sampleErrors）；`OTEL_ENABLED=true` 但缺 `OTEL_EXPORTER_URL` 时**启动即失败**（不静默丢 span），与 M7/M8 配置守卫一致。导出形态为 OTLP/HTTP JSON（`content-type: application/json`）。
- **example-api 追踪装配**：`TelemetryModule.forRoot()` 接入 `AppModule`；bootstrap `beforeListen` 按 `OTEL_MIDDLEWARE` → `TENANT_MIDDLEWARE` 顺序注册（追踪 span 先建立，租户解析并入链路）；`demo.module` 的租户数据源默认路径改用插桩 client（避免 dedicated 路由旁路 DB span）。
- **部署模板（T-M8-07，PRD-008 FR-09）**：新增 `deploy/` 部署资产——`deploy/helm/fw-app/` 标准 Helm Chart（`Chart.yaml` + `values.yaml` + `values-prod.yaml` + 14 个模板：Deployment / Service / HPA / PDB / Ingress / ConfigMap / Secret / ServiceAccount / NetworkPolicy / 迁移 Job / Worker / admin-web / `_helpers.tpl` / `NOTES.txt`），`deploy/docker-compose.prod.yml`（中档：app + worker + postgres + redis + nginx + migrate 六服务，应用无状态、迁移为一次性服务），`deploy/nginx/fw.conf`（SPA history 回退 + `/api` 反代 + traceparent 透传 + 登录限流 + 运维端点内网白名单）。
  - **Chart 语义要点**：三档探针分指（`startupProbe`→`/health`、`readinessProbe`→`/ready`、`livenessProbe`→`/health`）；滚动更新 `maxUnavailable=0` / `maxSurge=1`；`resources` requests+limits 必填；`runAsNonRoot` + 禁提权 + `drop: ALL` + `readOnlyRootFilesystem`；HPA（默认 3~12 / CPU 60%）、PDB（`minAvailable=2`）；**密钥默认不渲染 Secret 对象**，容器经 `secretRef` 取用，生产用 `secrets.existingSecret` 外部注入；迁移以 `helm.sh/hook: pre-install,pre-upgrade` 独立 Job 执行（失败即阻断发布）；Worker 与 API 同镜像不同角色（`TRANSPORT_ROLE=handler`）且选择器按 `component` 区分；Pod 模板带 `checksum/config` 注解，配置变更自动触发滚动。
  - **离线校验**：新增 `scripts/check-helm-chart.mjs`（+ `scripts/lib/mini-yaml.mjs` 零依赖极简 YAML 解析器）——实现 Helm 模板子集渲染（`include` / `if` / `range` / `with` / `default` / `toYaml` / `nindent` / `sha256sum` 等），对默认档 / 生产档 / 最小档三套 values 渲染结果做 K8s 清单语义断言，共 **63/63** 通过；本机与 CI 无 helm 时的门禁兜底（不替代真实集群 `helm install`）。
- **三大关键演练与终验（T-M8-08）**：新增 `apps/example-api/scripts/drill-m8.mjs`（可复跑，远程段落门控）与 `apps/example-api/scripts/bench.mjs`（压测基线）；产出 `docs/96-m8-drills.md`（演练记录 + PRD-008 §7 七条 AC 判定 + 遗留）、`docs/97-bench-baseline.md`（登录/列表/写入三类场景 QPS 与 P95）、`docs/98-scale-checklist.md`（规模化上线自检清单，FR-10）。

### M8 验证（2026-10-14，全量实跑）

- 多租户冒烟 `smoke-tenant.mjs` **48/48**：阶段 A fail-closed 与三级回退（16 项，含跨租户越权拦截）+ 阶段 B 单租户回归（2 项）+ 阶段 C dedicated 独立库路由（11 项）——dedicated 租户读写落在 `prisma/tenant-dedicated.db`（独立库列表 total=1），共享库查无此数据、主库 tenants 元数据仍在，缺失租户标识仍 403/4001，共享库租户不受影响 + **阶段 D 数据权限四档（19 项）**——四档精确集合（all 11 账号 / self 仅本人 / org={bob,carol}、org={alice,dave,erin} / org_below 六人闭包）、三类详情越权 403+3002、范围内禁用恢复、审计收敛。
- 传输层冒烟 `smoke-transport.mjs` **17/17**（T-M8-05，PRD-008 FR-06 / TC-TNT-005）：**阶段 A in-process**（连续 5 次往返 / 本进程处理 handledBy=callerId / 统计快照 / `/ready` transport 探针 / 空消息 BizError 1001 原样传播）+ **阶段 B redis 单进程**（真实 Redis 连续 5 次往返 / 空消息跨进程序列化→重建错误码仍为 1001）+ **阶段 C redis 双进程**（A=caller / B=handler 同前缀，A 调用时 handledBy ≠ callerId 证明由另一进程处理；B 主动调用自证往返；caller 进程 handled=0）+ **阶段 D 超时 fail-fast**（无处理方 1500ms 窗口内 503/9002，耗时 2.26s 而非挂死）+ **阶段 E 配置守卫**（redis 缺连接串启动即失败 exit=1）。redis 阶段由 `SMOKE_REDIS_URL` 门控，CI 未设置则跳过。
- `@fw/transport` 单测 **78/78**，覆盖率 **lines 95.09% / functions 93.82% / statements 94.33% / branches 90.54%**（门禁 85/85/65/85）：fake redis 经 `createClient` 注入驱动，覆盖 in-process 本地分发与角色语义、redis 协议往返（键命名/信封字段/应答清理/60s 兜底 TTL）、错误跨进程重建、无处理方与处理方双路径超时、启动后注册补起消费循环、坏消息丢弃、启动期 URL 守卫、装配与探针绑定。
- `@fw/db` 单测 **67/67**（新增 `TenantDataSource` 14 项：选路回退 / 缓存复用 / LRU 与空闲淘汰 / 创建失败重试 / 停机断开 / Repository 三条路径选路）；`@fw/logger` 17/17、`@fw/tenant` 19/19 全绿；**`@fw/auth` 108/108**（新增四档解析 / 越权校验 / 闭包算法 14 项）；`@fw/config` 10/10。
- 回归：队列冒烟 22/22、缓存冒烟 12/12、鉴权冒烟 25/25、多租户冒烟 48/48、传输冒烟 17/17；文件头门禁 313、裸 SQL 门禁 225。
- 链路追踪冒烟 `smoke-telemetry.mjs` **14/14**（T-M8-06，PRD-008 FR-07 / TC-TNT-006）：**阶段 A 未启用**（服务正常、`X-Trace-Id` 响应头与响应信封 traceId 一致）+ **阶段 B 启用全采**（本地 mock OTLP 收集器收到 SERVER span，traceId 与响应头一致、资源 `service.name` 生效、DB 操作产生 `db.query` 子 span）+ **阶段 C 跨服务同 traceId**（上游 `traceparent` 请求，服务端 SERVER span 复用其 traceId 且父 spanId = 上游 spanId，父子跨进程成立）+ **阶段 D 采样门控**（ratio=0 时普通链路 0 导出且服务不报错）+ **阶段 E 错误全采**（ratio=0 下 5xx 的 ERROR span 仍被导出）+ **阶段 F 配置守卫**（启用但缺 `OTEL_EXPORTER_URL` 启动即失败 exit=1）。使用本地 mock 收集器，无需外部采集端。
- `@fw/telemetry` 单测 **50/50**，覆盖率 **lines 92.56% / functions 80.18% / statements 97.05% / branches 93.12%**（门禁 85/85/65/85）：options 解析、尾采样（确定性 traceIdRatio / 错误全采 / 边界）、SDK 懒加载形状、span 桥接（有/无 SDK）、HTTP 中间件（根 span / traceparent / X-Trace-Id 归一化与非法回退 / 数组头 / 5xx vs 4xx / 同步异常 / ALS 回写 / 工厂开关）、模块装配（成功 / 失败路径不 close）、服务生命周期（本地 http 收集器端到端 + 部分 mock loader）。
- 插桩回归（T-M8-06c）：`@fw/db` **70/70**（12 skipped 为三库矩阵，未设 DB_DRIVER 时跳过）、`@fw/cache` **77/77**、`@fw/queue` **138/138**，三包覆盖率均远超门禁、`tsc`/文件头全过；新增 `trace.test.ts`（db 3 例 / cache 4 例 / queue 3 例）验证 DB/缓存/队列 span 名与属性、跨 async 边界父子续接、异常记 ERROR。
- **Helm Chart 离线校验（T-M8-07）**：`node scripts/check-helm-chart.mjs` **63/63**——默认档 / 生产档（ingress + worker + admin-web + 反亲和 + 拓扑分布）/ 最小档（autoscaling / PDB / migrateJob / ingress 全关）三套渲染全部成功；断言覆盖探针分指 `/ready` 与 `/health`、`maxUnavailable=0`/`maxSurge=1`、`resources` requests+limits、非 root + 禁提权 + `drop: ALL`、优雅停机 ≥ 30s、镜像 tag 回退 appVersion、HPA 副本与 CPU 目标、HPA 启用时 Deployment 不设 replicas、PDB `minAvailable≥2`、Service 端口映射、ConfigMap 七类关键键且值均为字符串、未渲染明文 Secret、`secretRef`/`configMapRef` 取用、迁移 Job 为 pre-upgrade 钩子且指令 `db:migrate`、`checksum/config` 注解、组件开关生效；另校验 `Chart.yaml` 元信息、必备模板齐备、compose 六服务与无状态性、Nginx SPA 回退与反代与登录限流。
- **三大关键演练（T-M8-08）**：`node scripts/drill-m8.mjs` **25/25，0 跳过**（含远程 MySQL 8.4 / PostgreSQL 18.6 / Redis 8.10，总耗时 80s）：
  - **演练一 · 数据库切换**：sqlite / postgresql / mysql 三库均 `ready.db=ok` + 写后读全通（`listCount=4`），三库结果一致；`git diff --stat -- apps/example-api/src packages` 为空（**业务代码零改动**）；耗时 47s ≤ 3600s。
  - **演练二 · 规模演进**：单体 in-process（`handledBy === callerId`）→ redis 双进程（`handledBy ≠ callerId`、caller `handled=0`）**同一端点同一请求体，仅环境变量不同**；链路追踪跨进程贯通（固定 `traceparent` → 同一 traceId 下 3 span / 2 服务）；compose → Helm 演进路径与 Chart 校验 63/63。
  - **演练三 · 依赖故障降级**：Redis 不可达时业务接口仍返回 200（降级直查 DB）且 `/ready` 503 + `checks.cache=fail` + `degradations=5` + `/metrics` 暴露降级指标；真实 Redis 恢复后读写一致（`healed`）且 `cache=ok`、`degradations=0`；远程库注入 `DB_SLOW_MS=10` 产生「慢查询告警」（`durationMs=40`、带 `traceId`）；队列限速下派发 12 个任务积压 `waiting=10` 且 `/metrics/queue` 暴露 `fw_queue_backlog`，等待后**消化归零**。
- **压测基线（T-M8-08，FR-11）**：`node scripts/bench.mjs` 三类场景——登录 `QPS 10.2 / P50 191.62ms / P95 255.65ms`（第 11 次返回 429，登录限流 60s/10 次生效）、列表查询 `QPS 561.8 / P50 16.17ms / P95 27.69ms`、写入 `QPS 37.5 / P50 26.46ms / P95 434.09ms`（SQLite 写锁串行长尾）；报告见 `docs/97-bench-baseline.md`，原始数据 `docs/bench/bench-latest.json`。
- 文件头门禁 **345** 文件通过。


### Added（M7 队列与定时任务，2026-10-13）

> PRD-007 全量交付：统一 Job 抽象 + 双驱动 + cron 调度 + 死信/幂等/限速 + 运维面。C-08 Job 契约冻结于 `docs/contracts/queue.ts`。

- **`@fw/queue`（新框架包）**：`QueueModule.forRoot()` 按 `MQ_DRIVER` 装配 **memory**（进程内零依赖，小系统直接可用）或 **bullmq**（Redis，懒加载 + optional peer，未安装时给出可操作报错）双驱动，业务代码零改动切换（AC-001）。
  - **统一 Job 抽象**：`dispatch(name, payload, options)`（attempts 含首次 / 退避序列 / delay / runAt / priority / idempotencyKey / timeoutSeconds），执行上下文含 `attempt / maxAttempts / traceId / 结构化日志器`。
  - **声明式注册**：`@JobHandler('name')` 标注类、`@Cron('0 2 * * *', { lock: true })` 标注方法、`@Idempotent()` 标注类或方法——启动期自动扫描，无需手写注册（AC-003）。
  - **重试与死信**：普通异常按退避序列重试（默认 `1000,5000,30000`，双驱动同一语义——bullmq 经 `settings.backoffStrategy` 复用任务内序列）；抛 `PermanentJobError` 即终态失败不重试；死信可查询 / 单条重放 / 批量清理，可插拔告警回调。
  - **幂等**：`idempotencyKey` 窗口期内重复 dispatch 直接跳过并计数（成功才置位，失败任务可重试）。
  - **并发与限速**：每队列并发上限 + 令牌桶限速（`MQ_RATE_LIMIT`，0 = 不限）。
  - **cron 调度**：自研 5/6 段表达式解析（`Intl` 时区、月份/星期别名、防夏令时死循环），集群内经分布式锁**单实例执行**；锁复用 `@fw/cache` 的 `CacheService`（redis 驱动天然分布式），进程内守卫时启动期显式告警（AC-002）。
  - **优雅停机**：先停调度再等在途任务，超时后 memory 未完成任务重新入队 / bullmq 交由失速检测恢复。
  - **可观测**：`/metrics/queue` Prometheus 文本（入队/成功/失败/死信/幂等跳过/超时/cron 触发与抢锁失败/成功率/平均耗时/积压 gauge）+ 队列就绪探针（`/ready` 的 `queue` 检查项）。
  - **管理面**：`/api/v1/admin/queue/*`（状态 / 指标 / 处理器 / cron 快照与手动触发 / 死信列表·重放·清理 / 暂停·恢复·清空），查看需 `system:queue:list`、变更需 `system:queue:manage`。
- **配置**：新增 12 个 `MQ_*` 环境变量（driver / url / prefix / concurrency / max-attempts / backoff / job-timeout / cron-enabled / rate-limit / dead-letter-max / shutdown-timeout / **stalled-ms**）；bullmq 缺 `MQ_URL` 时回退 `CACHE_URL`，两者皆缺时启动即失败（AC-001 配置守卫）。
- **example-api 接入**：`demo-queue` 模块（echo / flaky / permanent / slow / idempotent 五类任务 + 每 5 秒与每日两条 cron）+ `scripts/smoke-queue.mjs`（六阶段冒烟：memory 全能力、并发上限、令牌桶限速、bullmq 真实 Redis、**失速恢复演练（TC-JOB-008，SMOKE_REDIS_URL 门控）**、配置守卫）。
- **refresh 过期记录定时清理（M3 遗留项④）**：example-api `auth.refresh-cleanup` 定时任务（`@Cron('0 3 * * *')` 加分布式锁，按数据字典 §3.9 清理过期 30 天以上的 `refresh_tokens` 记录），`/api/v1/auth-maintenance/refresh-cleanup` 暴露注册与最近运行快照。
- **admin-web 队列管理页**（`/system/queue`）：积压总览卡 + 队列明细 + 死信列表（重放/清理/详情抽屉）+ 定时任务快照（手动触发），mock `/admin/queue/*` 端点与权限点同步补齐；C-06 契约新增 §3.8。

### M7 验证（2026-10-13，全量实跑）

- `@fw/queue` 单测 **135/135**，覆盖率 **lines 94.96% / functions 90.83% / statements 93.14% / branches 86.57%**（门禁 85/85/85/65）；TC-JOB-001~007 全覆盖（双驱动行为一致、cron 三实例共享锁只跑一次、退避序列、死信重放、幂等、限速）。
- `apps/example-api` 队列冒烟 **31/31**：memory 20（含 refresh 清理 cron 注册与手动触发 2 项）+ 并发 1 + 限速 1 + **bullmq 真实 Redis 7** + **失速恢复演练 2（TC-JOB-008）** + 配置守卫 1；未设置 `SMOKE_REDIS_URL` 时 bullmq 阶段按设计跳过。
- `apps/admin-web`：vue-tsc 通过、单测 **29/29**、mock 全链路冒烟 **57/57**（新增队列管理 17 项断言，含 `system:queue:*` 双向越权拦截）、bundle gzip **311.5 kB**（门禁 ≤ 600 kB）。
- CI 已纳入 M7：构建与覆盖率循环新增 `@fw/queue`，新增「M7 队列端到端冒烟（SQLite）」步骤。
- **TC-JOB-008 已通过（2026-10-13）**：真实 Redis 失速恢复演练通过并固化进冒烟阶段 F；演练暴露并修复两个 `@fw/queue` 缺陷（`register` 未建消费器导致新进程无失速检查器、`ensureWorker` 自递归死锁与同队列重复建），记录见 `docs/94-queue-stall-drill.md`。

### Changed（dev 工具链大版本升级，2026-10-13）

> 闭环 v0.1.0 发布验收遗留项 **R-05**（dev 工具链 13 项漏洞），并使**全仓 `pnpm audit` 归零**。

- **主版本升级**：`vitest` 2.1.9 → **4.1.11**（`@vitest/coverage-v8` 同步）、`vite` 5.4.21 → **8.3.4**、`happy-dom` 15.11.7 → **21.0.1**、`@vitejs/plugin-vue` 5.2.4 → **6.0.10**、`vue-tsc` / `@vue/language-core` 2.2.12 → **3.3.13**、`unplugin-vue-components` 0.27.5 → **32.1.0**；`@vue/test-utils` 2.4.6 → 2.5.1。**`tinypool` 随 vitest 4 退出依赖树**（原 1.1.1），`braces` 亦不再被引入。
- **vite 8 换用 rolldown + oxc** 的两处破坏性适配：
  - **8 个 `vitest.config.ts` 新增顶层 `oxc.decorator = { legacy: true, emitDecoratorMetadata: true }`**。oxc 只在「文件被某个 tsconfig 覆盖」时才启用 legacy 装饰器，而本仓 tsconfig 普遍 `exclude` 掉 `src/__tests__` → 测试中声明的 `@Module/@Injectable` 会被原样保留，Node 直接判 `SyntaxError: Invalid or unexpected token`（core / cache / db 各有一个测试文件因此无法收集，且 cache 表现为「文件计为失败但用例数照旧」的**静默漏跑**）。显式声明后与 tsc 行为一致。
  - **`apps/admin-web/vite.config.ts` 的 `manualChunks` 由对象形式改为函数形式**：rolldown 只接受函数（对象形式被忽略并告警），分包会静默失效。
- **覆盖率统计更精确带来的真实缺口**（vitest 4 的 v8 函数映射修正了 vitest 2 的漏计，非本次引入的回归）：`@fw/logger` 的 `trace/warn/fatal` 包装、默认 stdout sink、`redactValue` 数组分支；`@fw/core` 优雅停机的超时强退、关闭钩子异常、stdout drain、信号注册与重复信号。**补真实用例而非下调阈值**（logger 13 → 16、core 12 → 17）。
- **Node 要求**：dev 工具链下限为 **Node ≥ 20.19**（vite 8 / `@vitejs/plugin-vue` 6 要求 `^20.19.0 || >=22.12.0`），根 `engines.node` 由 `>=20` 收紧为 **`>=20.19`**；应用运行时要求不变（Nest 11 为 Node ≥ 20）。

### Security（dev 工具链升级）

- **全仓依赖漏洞归零**：`pnpm audit`（含 devDependencies）由 **13 项（critical 4 / high 4 / moderate 5）** 转为 **No known vulnerabilities**（0 项）。其中 `happy-dom` VM 逃逸 RCE、`tinypool` 原型污染 RCE、`vitest` UI 任意文件读取/执行三项 critical 与 vitest/@vitest/mocker、vite、esbuild 等 moderate/high 全部消除。至此 R-05、R-06 一并归零。

### Fixed（dev 工具链升级顺带修复的既有缺陷）

- **`apps/admin-web/scripts/smoke-mock.mjs` 的 bundle 门禁统计缺陷**：`vendor-element-plus` 体积由「取最后一个匹配文件」改为**累加**。rolldown 产物顺序变化后，该门禁此前只量到 CSS（29.9 kB）而漏掉 208.3 kB 的 JS chunk，**等于失效**；修正后实测 231.6 kB（门禁 ≤ 360 kB）。
- **`packages/db/tsconfig.json` 缺 `experimentalDecorators` / `emitDecoratorMetadata`**：TS 5 会把 `@Global()/@Module()` 按**标准（TC39）装饰器**编译（dist 内 `__esDecorate`）。当前只因 @fw/db 恰好没有方法/参数装饰器而未暴露，一旦新增 `@Get`/`@Inject` 即会静默失效（Nest 方法/参数装饰器依赖 legacy 语义）——属潜在缺陷。已与 core/cache/auth 对齐，dist 产物恢复 `__decorate`。
- **`apps/admin-web/src/views/system/users/index.vue` 的模板内联表达式**：模板中直接调用 `ElMessage.info(...)` 在 vue-tsc 3 下被解析为组件实例类型（TS2339），改为具名 `handleExport`（同时更易测试）。

### 升级验证（2026-10-13，dev 工具链，全量实跑）

- 框架包单测 **366/366** 且覆盖率门禁全过：config 10/10、logger 16/16（函数 100%）、core 17/17（函数 100%）、db 45/45（另 11 项三库矩阵按设计跳过）、cache 73/73、auth 89/89、cli 116/116。
- `apps/example-api` 冒烟 **50/50**（M1+M2 13、M3 25、M4 12）；`apps/admin-web` 单测 **29/29** + mock 全链路冒烟 **40/40**（bundle gzip 总量 307.8 kB）。
- `vue-tsc` 3 通过、`vite build`（rolldown）通过、逐包 `tsc` 零错误、文件头门禁 **222** 文件通过、`pnpm install --frozen-lockfile` 通过。

### Changed（NestJS 10 → 11 升级，2026-10-13）

> 闭环 v0.1.0 发布验收遗留项 **R-06**（生产依赖 3 项 moderate）。

- **依赖主版本升级**：`@nestjs/common` / `core` / `platform-express` / `testing` **10.4.22 → 11.2.7**，覆盖 `@fw/core`、`@fw/auth`、`@fw/cache`、`@fw/db`、`apps/example-api`，以及 **`templates/api`（`fw new` 新项目模板同步升级）**；`@types/express` 4.17.21 → **5.0.6**。
- **随之传递的大版本**：Express 4.22 → **5.2.1**（路由解析换 `path-to-regexp` 8）、`file-type` 20.4.1 → **21.3.4**（`@nestjs/common` 生产依赖，经 `load-esm` 动态加载，本仓全 ESM 工程原生可用）、`multer` → 2.4.0（`platform-express` 已直接依赖，overrides 转为下界保护）。
- **破坏性变更影响面：路由语法 0 处改动** —— 全仓无通配符路由（未触及 `*` → `*splat`）与 `:param?` 可选段；`req.ip` 未被直接使用（`auth.controller` 自解析 `x-forwarded-for`，不受 Express 5 的 trust proxy 语义影响）；`@Res({ passthrough: true })` 用法不变。
- **DI 装配改显式注入（唯一的代码适配）**：`AuthModule.forRoot` 的 `APP_GUARD` / `APP_INTERCEPTOR` 由 `useClass` 改为 `useFactory` + `inject` 令牌。Nest 11 收紧了「构造函数依赖解析为 undefined」的报错，暴露出测试环境（vitest 经 esbuild 转译，不产出 `design:paramtypes` 元数据）下 `useClass` 装配不可靠；显式注入后生产与测试行为一致，且不再依赖转换器能力。
- **Node 要求**：Nest 11 要求 Node ≥ 20，与本仓 `engines.node >= 20`（实测 22.x）一致，无变更。

### Security

- **生产依赖漏洞清零（R-06 闭环）**：`pnpm audit --prod` 由「3 项 moderate（`@nestjs/core <=11.1.17`、`file-type`）」转为 **No known vulnerabilities**；全量审计 16 → 13 项（critical 4 / high 4 / moderate 5），剩余全部位于 dev 工具链（vitest / tinypool / happy-dom / vite / esbuild / braces / launch-editor），见发布报告 §6 R-05。

### Fixed

- **`@fw/cli` 内置模板清单误把文档当模板**：`listBuiltinTemplates` 将 `templates/codegen/README.md` 计入模板清单（M6 收尾新增 README 时未同步该断言），现只收集 `.tpl` 文件，cli 单测恢复 **116/116**。

### 升级验证（2026-10-13，全量实跑）

- 框架包单测 **358/358** 且覆盖率门禁全过：config 10/10（98.3%）、logger 13/13（92.7%）、core 12/12（92.8%）、db 45/45（97.7%）、cache 73/73（96.2%）、auth 89/89（95.8%）、cli 116/116（94.7%）。
- `apps/example-api` 冒烟 **50/50**：M1+M2 13/13、M3 鉴权 25/25、M4 缓存 12/12；`apps/admin-web` 单测 29/29 + mock 全链路冒烟 40/40。
- 文件头门禁 221 文件通过；逐包 `tsc` 与 example-api 生产构建零错误。

### Added（M6 CRUD 代码生成器，2026-10-13）

**`@fw/cli gen crud <model>`（PRD-006，未发版）**

- **五层可测架构**（`packages/cli/src/gen/`）：`schema-parser`（解析 Prisma 的 model/enum/字段属性/文档注释/块属性）→ `type-map`（类型/控件/校验唯一映射，`bigint`/`decimal` 强制 `string` 防精度丢失，未命中类型直接报错）→ `template-engine`（轻量 `{{var}}` / `{{#if}}` / `{{#each}}` 引擎，Vue `{{ }}` 字面量以 `{{ '{' }}` 转义）→ `writer`（dry-run / diff / 默认不覆盖 / 失败回滚）→ `gen`（编排：范围、批量、交互、自检清单）；全部 IO 可注入，单测 **116 用例全绿 / 覆盖率 94.7%**（门禁 ≥80%）。
- **后端生成**：`entity` / `repository`（继承 `@fw/db` 的 `PrismaRepository`，无原生 SQL）/ `dto` / `service` / `controller`（`/api/v1/<模型复数>` 标准 CRUD）/ `module` 六文件。
- **前端生成**：`api/<model>.ts` 请求封装 + `views/<model>/index.vue`（`<CrudTable>` 配置：列宽/对齐/slot 按字段类型推导）+ `views/<model>/form.vue`（独立弹窗，控件与校验规则同源）；外键自动生成带责任人与日期的 `TODO` 提示绑定数据源。
- **权限点与菜单 seed**：`prisma/seed/<model>.seed.ts` 幂等 upsert 4 个权限点（`<kebab>:create/read/update/delete`）+ 菜单记录，与 PRD-003 RBAC 对齐；单条命令一次产出 10 个文件（后端 6 + 前端 3 + seed 1）。
- **安全写入（FR-07/08）**：默认跳过已存在文件并提示 `--force`；`--dry` 与真实生成共用同一渲染路径，输出保证一致；生成前 `git status` 脏工作区告警（不阻断）；后端 `tsc` 校验失败即回滚本次全部写入（含删除新建文件与空目录），不留半成品。
- **模板可定制（FR-06）**：内置模板外置 `templates/codegen/{backend,frontend,seed}/`，项目根同名模板优先覆盖；`codegen.config.json` 提供自定义变量 `vars` 与类型映射 `typeOverrides`；定制说明见 `templates/codegen/README.md`。
- **中文文件头（FR-11）**：产物统一带 `@file/@description/@author/@created` 文件头与 `@generated` 标注；署名取 `git config user.name`，缺失时回退 `donttemo` 并告警。
- **批量与筛范围**：`--all`（schema 全部可生成模型，自动排除复合主键模型）、`--only=backend|frontend|seed|all`、`--app`/`--web`/`--schema` 显式指定、无位置参数时交互式选择。
- **端到端验证**：以仓库真实 schema 的 `DemoItem` 为载体验证——`fw gen crud demo-item` 产物零手改即通过 `apps/example-api` `tsc --noEmit` 与 `apps/admin-web` `vue-tsc --noEmit`；`app.module.ts` 接入 `DemoItemModule`、`prisma/seed.ts` 引用生成的权限种子，均作为生成器可用性的活体证据。
- **CI 纳入**：单测覆盖率循环新增 `@fw/cli`；`base` job 增加「M6 生成器 dry-run 冒烟」步骤。

### Added（M5 管理后台前端，2026-10-13）

**`apps/admin-web`（v0.1.0，PRD-005 / C-06 契约）**

- **工程与主题**：Vite 5 + Vue3 + TypeScript + Element Plus（按需引入，vendor gzip 291.6 kB）+ Pinia + Vue Router；布局（侧边栏 / 顶栏 / 面包屑 / 多标签页）、主色切换、暗色模式、紧凑模式、响应式折叠；`.env.*` 四环境（dev/test/production/example）。
- **mock server（C-06 内存实现）**：`mock/db.ts` 种子 + `handlers.ts` 全量端点 + vite 插件中间件，非 production 模式自动挂载；切真实后端只改 `VITE_API_BASE_URL`，业务代码零改动。冒烟脚本 `scripts/smoke-mock.mjs` 以真实 HTTP 走完全链路（**40/40 通过**：登录 / me / 错误码 / 禁用账号 / 菜单 / 字典 / 用户 CRUD / 越权 3002 / 无感刷新轮换与旧 token 失效 / 角色 / 菜单树 / 审计 / 订单 / 登出）。
- **请求层**：统一信封解包、Bearer 注入、traceId 透传、错误码 → 用户可读提示；3001/3003 无感刷新（并发共用同一刷新 Promise，刷新成功自动重放原请求）；access token 仅存内存、refresh token 按「记住我」存 local/sessionStorage。单测覆盖重放、跳登录、防递归与并发合并（TC-WEB-003）。
- **登录与个人中心**：账号密码 + 验证码钩子 + 记住我；3001/3004/9003 错误码提示；资料修改、改密、登录设备查看与下线。
- **动态路由与按钮权限**：菜单树由 `/auth/menus` 下发并二次过滤生成路由（静态路由仅登录 / 403 / 404 / 工作台 / 个人中心）；`v-permission` 指令 + CrudTable 按钮级权限（无权限不渲染，服务端仍独立校验）；未授权路径直输 URL 落 403/404。
- **标准 CRUD 组件 `<CrudTable>`**：columns / searchForm / api / permission 四要素配置即得完整列表页（查询区含字典下拉与展开收起、工具栏、排序 / 多选 / 列设置本地持久化 / 导入导出钩子、加载 / 空 / 错误 / 无权限四态、内置表单弹窗含服务端字段级错误回显）；新业务列表页 ≤ 80 行（演示页 `views/demo/orders` 65 行）。
- **系统管理页**：用户（列表 / 新建 / 编辑 / 启用禁用 / 重置密码 / 分配角色）、角色（权限树勾选 / 数据范围 / 复制角色）、菜单（树形维护）、字典（分类 + 项，`useDict` 按编码消费、禁止枚举硬编码）、审计日志（按人 / 时间 / 模块查询，详情抽屉展示字段级 diff）。
- **测试**：vitest + happy-dom 单测 **29/29**（错误码语义、无感刷新重放、权限路由生成含 component 解析与相对路径拼接、CrudTable 四态与权限按钮）；`vue-tsc --noEmit` 全量类型检查通过；构建产物 gzip 总量 434.9 kB（门禁 600 kB）。
- **CI 纳入**：`.github/workflows/ci.yml` 构建列表新增 `admin-web`，`base` job 增加「M5 管理后台前端门禁」步骤（vitest 单测 + mock 全链路冒烟 + bundle 门禁）；`test` 脚本移除 `--passWithNoTests`，无测试文件即失败，门禁真实生效。

**契约与文档**

- `docs/contracts/api-web.ts`：C-06 前端 API 契约冻结（类型即契约；用户列表项 `roleIds` 为 Web 契约新增要求，供分配角色弹窗预选）。
- `docs/60-deployment-ops.md` §3：新增管理后台前端环境变量清单（`VITE_API_BASE_URL` 等，构建期注入）。

### Added（数据库联通性与三库切换实测，2026-10-13）

**`@fw/db` 三库一致性矩阵（T-M2-07，可执行化）**

- 新增方言 schema 变体 `prisma/test-schema.mysql.prisma` / `prisma/test-schema.postgresql.prisma`：与 SQLite 版**模型段逐字节一致**（MD5 相同），仅 `provider` + `url` + client 输出目录不同——把 ADR-0002「切换只改 datasource 两行」变成可 `diff` 的事实。
- 新增建表脚本 `packages/db/scripts/matrix-db-setup.mjs`（npm: `matrix:setup`）：`prisma migrate diff --from-empty --to-schema-datamodel --script` 生成方言 SQL → `prisma db execute --file` 应用，跨平台，不依赖 mysql/psql 客户端。
- 新增共享断言套件 `src/__tests__/repository-suite.ts`（`defineRepositorySuite()`）与矩阵测试 `prisma-repository.matrix.test.ts`：**sqlite / mysql / postgres 三个驱动共用同一份 11 项断言**；`DB_DRIVER` 未设置时整文件跳过，保证离线单测与覆盖率门禁不被远端依赖阻塞。
- 实测结论：三库 11/11 全绿；`packages/db/src` 业务源码（`prisma-repository.ts` 等）**零改动**，符合 ADR-0007。
- **修复 CI 矩阵潜伏缺陷**：`.github/workflows/ci.yml` 的 `integration` job 原用 `sed` 改 provider 后再 `prisma migrate deploy`，而 `prisma/migrations/` 是 **SQLite 方言** SQL，在 MySQL/PG 上无法执行（该 job 从未触发过 Actions，缺陷一直潜伏）；改为方言 schema 变体生成客户端 + `migrate diff` 产出方言 DDL 建表，测试改用共用断言套件。两条腿已按 CI 命令顺序本地复跑，各 11/11。
- `vitest.config.ts` 增设 `testTimeout` / `hookTimeout` = 60s（远端矩阵单用例含批量造数，默认 5s 不足）。

**`@fw/cache` 真实 Redis 驱动联调**

- `apps/example-api/scripts/smoke-cache.mjs` 新增**阶段 D**（`SMOKE_REDIS_URL` 门控）：真实实例的读写 / `@Cacheable` 命中 / 标签失效 / 分布式锁 / 指标，并以「零降级 + `/ready cache=ok`」排除静默降级假绿。带真实 Redis 时 M4 冒烟 **18/18**。

**文档**

- 新增 [`docs/93-db-connectivity-switch-test.md`](./docs/93-db-connectivity-switch-test.md)：连通/鉴权实测（含 PG SCRAM-SHA-256 完整握手）、三库矩阵结果、键空间独立核验、发现与修复、遗留 T-01~T-05。
- [`docs/92-test-databases.md`](./docs/92-test-databases.md) 增补 §5 执行记录（实测服务端版本、`framework_test` 创建、大小写归一与批量造数注意事项）。
- 验收总纲遗留 **R-01（三库矩阵与数据库切换演练）** 完成实测闭环、**R-07（真实 Redis）** 完成 standalone 部分闭环（Cluster 留待 M8）。

### Fixed

- 修复动态路由子路径拼接缺陷：菜单全路径（如 `/system/users`）曾直接作为子路由相对路径，导致 `/system` 下的用户页拼成 `/system/system/users` 无法命中；现按父级前缀换算相对路径（单测回归护栏）。
- 修复 CrudTable 非分页接口响应兼容：接口约定返回裸数组，现兼容误包 `{ items }` 的响应，避免 el-table 拿到非数组崩溃。

### Fixed（v0.2.0 发布前验收修复，2026-10-14）

- **CI 纳入 `@fw/tenant`**：M8 T-M8-01 新增该包时漏加构建与覆盖率循环（`@fw/transport` / `@fw/telemetry` 已纳入），干净环境下 `example-api` 取不到其 `dist` 会构建失败；同时补入「M8 多租户端到端冒烟」步骤（`smoke-tenant.mjs`）。详见 [v0.2.0 发布验收报告](./docs/90-release-v0.2.0.md) §5 F2-01/F2-03。
- **`@fw/tenant` 覆盖率补齐**：`tenant.middleware.ts`（9.52%）与 `tenant.module.ts`（46.15%）原仅由端到端冒烟覆盖，包整体 lines 71.42% / functions 56% 低于 85% 门禁；补中间件 9 项 + 模块装配 5 项单测后达 **99% statements / 98.9% lines**（用例 19 → 33）。
- **应用自报版本**：`apps/example-api` 的 `/api/v1/demo/ok` 返回值由 `framework: 'v0.1.0'` 更新为 `'v0.2.0'`。

## [0.1.0] - 2026-10-13

> 首个可运行版本。含 M1 核心骨架、M2 数据库抽象层、M3 鉴权与权限、M4 缓存层。
> 门禁与验证证据见 [v0.1.0 发布验收报告](./docs/90-release-v0.1.0.md)。

### Added（M4 缓存层，2026-10-13）

**框架包**

- `@fw/cache`（v0.1.0）：缓存层（PRD-004）。
  - **统一接口**：`get / set / del / has / wrap / mget / mset / expire / invalidateTag`；`wrap(key, ttl, loader)` 为推荐用法（自动回源 + 单飞 + 空值占位一体）。
  - **多驱动**：`CACHE_DRIVER=memory`（零依赖，LRU 容量上限 + TTL 惰性淘汰）/ `redis` / `redis-cluster`（ioredis **懒加载**，仅在选用时解析；作为**可选 peerDependency** 不强制安装）。业务代码切换驱动 diff = 0。
  - **存储抽象**：自研 `CacheStore` 端口（`get/set/del/has/mget/mset/expire/sadd/srem/smembers/setNx/delBySet/ping/close`），memory 与 redis 两驱动共用同一套用例验证行为一致性（TC-CACHE-001）；详见 ADR-0012（**不引入 cache-manager**，ADR-0004 存储抽象部分被取代）。
  - **Key 规范**：全局前缀（`CACHE_PREFIX`，缺省 `fw:<APP_ENV>`）+ `前缀:模块:标识`，字符白名单与长度校验，非法键抛 `CacheKeyError`（1001）。
  - **标签化失效**：`set(..., { tags })` 登记「标签→key」集合映射（`CACHE_TAG_TTL` 防幽灵缓存）；`invalidateTag(tag)` 批量失效并清理映射。
  - **三防护**：防穿透（空值占位，`CACHE_NULL_TTL`，用 JSON 信封区分「未命中」与「命中空值」）、防击穿（单飞 `wrap`，同 key 并发只回源一次）、防雪崩（TTL 叠加 ±`CACHE_TTL_JITTER` 随机抖动）。
  - **降级**：`CACHE_FAIL_OPEN=true`（默认）时依赖故障读直查、写忽略并记录降级日志与指标；`false` 时抛 `CacheUnavailableError`（9002 / HTTP 503）。降级次数与错误数暴露到 `/metrics`。
  - **分布式锁**：`Lock`（`SET NX PX`，memory 驱动退化为进程内锁）；安全释放（校验持有者标识，Lua 原子删除）、自动续期、可重入标记。
  - **可观测**：`/metrics` 暴露 `fw_cache_hit_rate` / `fw_cache_hits_total` / `fw_cache_misses_total` / `fw_cache_degradations_total` / `fw_cache_errors_total` / `fw_cache_avg_latency_ms` / `fw_cache_info{driver=...}`；慢操作（>`CACHE_SLOW_MS`）告警日志。
  - **大 key 防护**：单值超 `CACHE_MAX_VALUE_BYTES`（默认 1MB）拒绝写入抛 `CacheValueTooLargeError`。
  - **装配**：`CacheModule.forRoot()`（`@Global`）+ `@Cacheable({ ttl, key, tags, condition, nullTtlSeconds, jitter })` 装饰器 + `CacheService` 就绪探针（Redis 不可达时 `/ready` 报 `cache: fail`，业务接口不受影响）。
- `@fw/config`：新增 9 个缓存配置键与校验——`CACHE_PREFIX` / `CACHE_TTL` / `CACHE_MAX_ITEMS` / `CACHE_FAIL_OPEN` / `CACHE_NULL_TTL` / `CACHE_TTL_JITTER` / `CACHE_LOCK_TTL` / `CACHE_TAG_TTL` / `CACHE_SLOW_MS` / `CACHE_MAX_VALUE_BYTES`。
- `apps/example-api`：接入 `@fw/cache`——`CacheModule.forRoot`（默认 memory）、`/api/v1/demo-cache/*` 演示端点（put-and-pick / find-user / wrap / wrap-miss / invalidate / lock / stats）；`CacheBackedAuthCache` 把 M3 的 `AUTH_CACHE` 端口从 `MemoryAuthCache` 换成 `CacheService`，**鉴权业务代码 diff = 0**（验证 ADR-0004 的可切换性承诺）。
- `docs/contracts/cache.ts`：C-04 缓存契约冻结（`CacheService` 接口 / `Lock` API / `CacheStore` 端口签名 / 指标快照 / 降级语义），供 L2 鉴权与 L4 前端消费。
- ADR-0012：缓存存储抽象自研 `CacheStore` 端口，不引入 cache-manager（ADR-0004 部分取代）。

**修复**

- 修复 `@fw/db` 构建缺陷：`packages/db/tsconfig.json` 未排除 `src/__tests__/**`，`build` 会把测试文件一并编译，在未按 `test-schema.prisma` 重新生成客户端时因 `ID` 类型（number vs string）与 `providers` 可选性报错而**中断整个构建**。现与 `@fw/auth` / `@fw/cache` 对齐，统一排除测试与 `dist`。

**测试**

- `@fw/cache` 单测 8 文件全通过；覆盖率 **96.23% lines / 94.45% branch / 98.37% funcs / 96.23% stmts**（阈值 85/65/85/85）。
- 新增 `apps/example-api/scripts/smoke-cache.mjs`：M4 端到端 12 项断言（TC-CACHE-002/003/004/005/007/009 + AC-008），分三阶段——memory 全能力 / redis 不可达降级 / 配置守卫（缺 `CACHE_URL` 启动即失败）。
- CI 纳入 `@fw/cache`（构建 + 覆盖率门禁），并新增「M4 缓存层端到端冒烟」步骤。
- 回归：全包单测 242 项通过（config 10 / logger 13 / core 12 / db 45 / auth 89 / cache 73）；M1+M2 冒烟 13/13、M3 冒烟 25/25（鉴权缓存切 `CacheService` 后无回归）。

### Added（M3 鉴权与权限 RBAC，2026-10-13）

**框架包**

- `@fw/auth`（v0.1.0）：鉴权与权限（PRD-003）。
  - **双 token**：access（`AUTH_ACCESS_TTL`，默认 2h）+ refresh（`AUTH_REFRESH_TTL`，默认 7d）；refresh 每次刷新轮换，旧令牌立即失效；复用旧 refresh 在宽限窗口（`AUTH_REFRESH_GRACE_SECONDS`，默认 10s）内按并发刷新处理，超窗口判定泄漏 → 撤销整族 + 撤销该用户全部 refresh + 告警日志。宽限通道额外要求「族内仍存在有效令牌」，防止整族撤销后旧令牌借窗口继续换发。
  - **令牌失效**：access 精确黑名单（按 `jti`）+ 用户级水位（`setUserCutoff`，改密 / 强制下线后该用户此前签发的 access 全部失效）；黑名单 TTL = 令牌剩余有效期。
  - **RBAC**：五表模型（`users/roles/permissions/user_role/role_permission`）+ `menus`；权限码 `资源:操作`，类型 `menu|button|api`；`PermissionService` 聚合角色权限并缓存（默认 60s），变更后按 `user:<id>` 标签主动失效。
  - **守卫与装饰器**：`RbacGuard`（`APP_GUARD`）实现认证 + 授权合一；`@Public()` / `@Permissions(...codes)`（与关系）/ `@AuthStrategy(name)` / `@Audit(meta)` / `@CurrentUser()`；失败语义 3001 / 3002 / 3003 / 3004，权限判定先于处理器，不泄漏资源存在性。
  - **可插拔策略**：`StrategyRegistry` 内置 `jwt` / `apikey` / `session` / `oauth2` 四种策略，由 `AUTH_STRATEGY` 或路由元数据选择；API Key 用定长时间比较防时序侧信道；OAuth2 提供方未注册时明确报错（不静默降级）。落地方式为「Passport 语义、不引入 passport 包」（见 ADR-0011）。
  - **口令**：`@node-rs/argon2` Argon2id（19MiB / 2 轮 / 单并行）为主，`bcryptjs` 校验历史哈希并在 `needsRehash` 时静默升级；`low|medium|high` 三档强度策略；自助注册**默认关闭**（`AUTH_ALLOW_REGISTER` 默认 `false`），开放注册须显式开启。
  - **登录加固**：同 IP + 账号失败 5 次锁定 15 分钟（`AUTH_MAX_FAILED` / `AUTH_LOCK_MINUTES`）、登录接口固定窗口限流（60s/10 次，触发返回 9003）；账号禁用即拒绝（3004）。
  - **审计日志**：`@Audit()` + `APP_INTERCEPTOR` 自动落 `after` 与目标 ID，业务层用 `AuditService.record({ before, after })` 补 `before`；异步落盘不阻塞主流程、失败降级为日志兜底；敏感字段（口令 / 令牌 / 密钥等）按字段名脱敏为 `***`，深度 6 层截断；`audit_logs` 只写不改不删。
  - **端口与解耦**：`AuthStore`（持久化端口，提供 `MemoryAuthStore` 与业务侧 `PrismaAuthStore` 两种实现）与 `AuthCachePort`（缓存端口，M3 用 `MemoryAuthCache`，M4 换 Redis 只改 DI）。
  - **数据权限**：`dataScope` 四档中 M3 实现 `self`，`org` / `org_below` 在 `resolveDataScope` 收敛为 `self` 并进入 `pendingScopes`（M8 扩展）。
- `@fw/config`：新增 11 个配置键与校验——`AUTH_ACCESS_TTL` / `AUTH_REFRESH_TTL` / `AUTH_MAX_FAILED` / `AUTH_LOCK_MINUTES` / `AUTH_REFRESH_GRACE_SECONDS` / `AUTH_PASSWORD_POLICY` / `AUTH_ALLOW_REGISTER` / `JWT_SECRET`（无默认值）/ `JWT_SECRET_PREV` / `AUTH_API_KEYS`；布尔键用 `boolString` 预处理，避免 `z.coerce.boolean('false') === true`。
- `@fw/core`：`bootstrap` 的 `NestFactory.create` 显式传 `abortOnError: false`——默认 `true` 配合 `logger: false` 会让模块装配失败**无任何输出直接退出**，现由 `main.ts` 的 catch 打印可读错误。
- `@fw/cli`：`fw db:migrate` / `db:rollback` / `db:seed` 改为**异步执行外部命令**（原 `execFileSync` 在受限宿主返回 `EBUSY` 且阻塞事件循环），并把 stderr 透出到错误信息。
- `apps/example-api`：接入 `@fw/auth`——`prisma/schema.prisma` 新增 8 张表 + 迁移 `20261012165848_add_auth_rbac`；`PrismaAuthStore` 适配器；4 个控制器（`/api/v1/auth` 登录/注册/刷新/登出/me/菜单/改密，`/api/v1/users` 列表与角色分配、状态启停，`/api/v1/roles` `/permissions`，`/api/v1/audit-logs`）；seed 写入 22 权限点 / 2 角色 / 7 菜单 / 2 账号（Argon2id）。
- `docs/contracts/auth.ts`：C-05 权限契约冻结（`RequestUser` / 权限码 / 菜单树 / `@Permissions` 语义 / 守卫失败码），供 L4 前端与 L5 生成器消费。
- ADR-0011：自实现策略注册表替代 passport 包（保留 Passport 语义）。

**测试**

- `@fw/auth` 单测 89 项 / 11 文件全通过；覆盖率 96.86% lines / 91.13% branch / 96.05% funcs / 96.86% stmts（阈值 85/65/85/85）。
- 新增 `apps/example-api/scripts/smoke-auth.mjs`：M3 端到端 25 项断言（TC-AUTH-001~014），覆盖未登录/无效令牌 3001、越权 3002、双 token、`dataScope=self`、菜单按权限过滤、refresh 轮换与泄漏族撤销、禁用强制下线、审计前后值、登出失效、连续失败锁定 3004。
- CI 纳入 `@fw/auth`（构建 + 覆盖率门禁），并新增「M3 鉴权端到端冒烟」步骤。
- `@fw/db` 集成测试（TC-ORM-001/002/003/004，11 项）**恢复可在本地实跑**（原因同步 spawn 报 `EBUSY` 被记为「环境限制不可验证」，实际是可用异步执行绕开的代码问题）；全量 45 项通过。

**修复**

- 修复「refresh 泄漏处置可被绕过」：宽限通道除时间窗外新增族存活校验（`AuthStore.hasActiveRefreshTokenInFamily`），整族撤销后旧令牌不再可用。
- 修复「启动装配失败静默退出」（`abortOnError`）。
- 修复「DI 元数据退化」：`RbacGuard` / `AuditInterceptor` 的依赖由类型导入改为值导入 + `@Inject` 令牌。
- 修复 CLI 数据库命令与 `@fw/db` 集成测试准备步骤在受限宿主不可用（同步 spawn → 异步 `execFile`）。
- 修复 `AUTH_ALLOW_REGISTER` 默认值与既有文档/测试不一致（代码为 `true`、测试与部署手册为 `false`）→ 统一为 `false`（框架「默认安全」，开放注册须显式开启）。

**已知限制**

- `apikey` / `session` / `oauth2` 策略仅有单测证据，example-api 未挂对应路由；端到端仅覆盖 `jwt`（M5 补）。
- 权限缓存为进程内实现，多实例部署前需接 M4 Redis（否则角色变更在其它实例上最多 60s 延迟）。
- `dataScope` 的 `org` / `org_below` 与 refresh 过期记录定时清理均移至 M8；M7 仅提供 cron 能力。

### Added（M2 数据库抽象层，2026-10-12）

**框架包**

- `@fw/db`（v0.1.0）：数据库抽象层（PRD-002）。
  - `Repository<T>` 契约冻结：`findById/findOne/list/page/pageByCursor/create/update/softDelete/hardDelete/count/withTransaction`；软删（`deletedAt`）与审计字段（`createdAt/updatedAt/createdBy/updatedBy`）为通用约定；`upsert()` / `jsonContains()` 方言差异下沉适配器。
  - `PrismaRepository<T>` 实现：查询强制软删过滤、审计字段自动填充（操作人取 `@fw/logger` 请求上下文，缺失 `system`）、排序主键 tie-breaker、页码/游标双分页（`pageSize` 上限 100）、交互式事务共享连接、隔离级别三档（read-committed/repeatable-read/serializable）。
  - `DbModule.forRoot({ client, provider, slowQueryThresholdMs?, readinessProbe? })`：慢查询插桩 client 全局注入；`DbModule.readinessProbe()` 生成 `/ready` 的 db 探针（经 `FwCoreModule.forRoot({ readinessProbes })` 注册）。
  - `withSlowQueryLog`：Prisma Client 扩展挂 query 事件，超阈值（默认 `DB_SLOW_MS`=500ms）输出 warn 日志（model/operation/durationMs/SQL 摘要/traceId，TC-ORM-006）。
  - `DIALECT_WHITELIST.md`：方言能力白名单/黑名单（禁用 `ON DUPLICATE`/`ON CONFLICT`/`INSERT OR REPLACE`/jsonb 操作符/全文检索/窗口函数/自增主键等），原生 SQL 逃逸口必须带 `@sql('<dialect>')` 标注。
- `@fw/config`：新增 `DB_SLOW_MS` 配置键（慢查询阈值，默认 500）。
- `@fw/cli`：新增 `fw db:migrate`（幂等应用迁移）/ `fw db:rollback`（migrate diff 反向 SQL + `_prisma_migrations` 记录清理，TC-ORM-007）/ `fw db:seed`（执行 package.json 的 `prisma.seed`）；均支持 `--schema=<路径>`。
- `scripts/check-no-raw-sql.mjs`：原生 SQL 静态检查门禁（无方言标注的 `.$queryRaw/.$executeRaw` 直接失败，TC-ORM-005）。
- `.github/workflows/ci.yml`：CI 三库矩阵（SQLite/MySQL 8/PostgreSQL 15 service 容器，fail-fast: false，任一失败阻断）；含构建、四包覆盖率门禁、文件头门禁、方言白名单门禁。
- `apps/example-api`：接入 `@fw/db`——`DemoItemRepository`（业务层零 ORM 细节）+ `/api/v1/demo/items` CRUD 端点（分页/创建/局部更新/软删）；`/ready` 暴露 `db` 探针；`prisma/schema.prisma` + seed。
- `templates/api`：新增 `prisma/schema.prisma`（Dict 示例模型）+ `prisma/seed.ts` + `db:migrate/rollback/seed/reset` 脚本 + `@fw/db`/`@fw/cli` 依赖。
- `scripts/check-file-headers.mjs`：跳过 Prisma 生成目录（`test-client`/`migrations`）。

**测试**

- `@fw/db` 单测 45 项：逻辑层（fake delegate）22 项 + 真实 SQLite 集成 11 项（TC-ORM-001/002/003/004）+ 慢查询观测 6 项（TC-ORM-006）+ DbModule 装配 6 项；覆盖率 97.7% stmts / 83.9% branch / 97.0% funcs / 97.7% lines（阈值 85/65/85/85）。
- 端到端冒烟扩至 13 项（新增 db 探针/items 分页/CRUD/软删断言）。
- 迁移回滚演练：`db:rollback` → `phone` 列消失 + 记录清理 → `db:migrate` 重入恢复（TC-ORM-007 闭环）。

**决策**

- ADR-0002 定稿：选 **Prisma 6.19.3**（spike 实测：多 provider 切换只改 datasource 两行 + generate + migrate，业务 diff=0；方言 SQL 自动生成；SQLite 集成 11 项全过）。

**已知限制（环境）**

- MySQL/PG 集成矩阵需容器，本地沙箱未执行；CI 配置就位后可复现（`TEST_DATABASE_URL` 切库）。
- Windows 沙箱 turbo 管道限制不变（构建逐包直跑）。

### Added（M1 核心骨架，2026-10-12；待发布为 v0.1.0）

**框架包（`packages/`）**

- `@fw/config`（v0.1.0）：zod 校验 `.env`、多环境覆盖（`.env` → `.env.{APP_ENV}` → `process.env` → `overrides`）、空串等价未设置、`ConfigService.get('db.driver')` 类型安全读取、`ConfigValidationError` 逐项中文说明。
- `@fw/logger`（v0.1.0）：结构化 JSON 日志（字段 `time/level/traceId/spanId/module/msg/ctx`）、按模块级别覆盖、敏感键脱敏（`password/token/idcard/secret/authorization` 变体 + 消息文本 key=value 替换为 `***`）、单条 8KB 字节截断、`AsyncLocalStorage` 请求上下文。
- `@fw/core`（v0.1.0）：错误码表（与 `docs/40-api-spec.md` §2 同源：`OK` / 1xxx 通用 / 2xxx 业务 / 3xxx 鉴权 / 4xxx 租户 / 9xxx 系统）、`BizError`、`ResponseInterceptor`（统一包装 `code:0, data, traceId`；`/health/ready/metrics` 跳过）、`GlobalExceptionFilter`（BizError / Nest HttpException / 未知异常归一化）、`traceMiddleware`（生成或透传 `X-Trace-Id`）、`HealthController`（`/health` 存活 + `/ready` 逐项探针）、`runGracefulShutdown` + `setupGracefulShutdown`（SIGTERM/SIGINT 等在途请求 → `app.close` → drain stdout → `exit(0)`）、`FwCoreModule.forRoot()`（动态模块，`@Global`）、`bootstrap(rootModule, options?)`。
- `@fw/cli`（v0.1.0）：`fw new <name> --template=<api|admin|cms>`（admin/cms 在 M5/M6 交付，给出明确里程碑提示）、`fw dev` / `fw build`（透传 pnpm 脚本）、`fw check`（用 `loadEnv` 自检并打印配置摘要）。
- `apps/example-api`（v0.1.0）：M1 验证载体，演示 6 个端点（`/api/v1/demo/ok|biz-error|biz-error-with-details|boom|log-sensitive` + 运维端点）。
- `templates/api`：`@fw/cli new` 脚手架，结构与 `example-api` 一致，`__APP_NAME__` 占位符在 `pnpm run new` 时被替换。
- `apps/example-api/scripts/smoke.mjs`：M1 端到端冒烟（9 项断言：health/ready/统一响应/bizError/details/boom/log-sensitive/404/traceId 贯通）。
- `apps/example-api/scripts/send-sigterm.mjs`：跨进程发 SIGTERM 工具，配合 `FW_PID_FILE` 环境变量验证优雅停机。

**测试**

- `vitest` 单测覆盖 `@fw/config`（97.58% 行）、`@fw/logger`（92.72% 行）、`@fw/core`（92.82% 行），分支/函数/语句阈值在 `vitest.config.ts` 强制（lines/funcs/stmts ≥ 80%，branches ≥ 60%）。
- `scripts/check-file-headers.mjs` 增强：跳过 vitest tsx 编译产生的 `*.timestamp-*.mjs` 临时文件；扫描 `packages/`/`apps/`/`templates/`/`scripts/` 共 40 个文件全部通过。

**已知限制（环境）**

- Windows 沙箱下 `taskkill //IM node.exe` 会误杀 WorkBuddy 宿主进程；停用 `apps/example-api` 进程需 `taskkill /PID <pid> //F` 或经 Node `process.kill(pid, 'SIGTERM')`。
- Windows 沙箱下 `pnpm turbo run build` 触发「os error 231 所有的管道范例都在使用中」（turbo 并行 spawn 撞 Windows 命名管道上限）；构建通过 `cd <pkg> && pnpm run build` 逐包完成，构建产物一致。
- `pnpm run build` 的 turbo 编排在 Windows 沙箱下不可用是环境问题，不影响各包构建本身。

### Added（文档基线，2026-10-09）

**规划与验收**

- 项目愿景与范围文档（`docs/00-vision-scope.md`）：5 项目标、7 条非目标、范围内外边界、小/中/大三档规模承诺、成功指标、M1–M8 里程碑。
- 验收标准（`docs/10-acceptance-criteria.md`）：完成定义（DoD）、里程碑门禁、性能/安全/可观测基线、三大关键演练、P0 阻断红线、验收记录模板。

**设计**

- 架构设计与技术方案（`docs/20-architecture.md`）：分层架构、模块职责、请求链路、七项能力技术方案、三档部署架构、演进路径、**10 条 ADR 摘要**、风险对策。
- 原型与 UI 规范（`docs/25-ui-prototype.md`）：设计令牌、页面清单与路由、布局与关键页线框、组件与交互规范、响应式、与 PRD-005 验收映射。
- ER 图与数据字典（`docs/30-data-dictionary.md`）：建模约定、权限域与系统租户域 ER 图、15 张表字段字典、迁移与数据治理。
- API 文档（`docs/40-api-spec.md`）：通用约定、错误码表、10 类接口清单、限流与幂等、版本与废弃策略。
- 测试用例（`docs/50-test-cases.md`）：测试策略与环境矩阵、M1–M8 共 60+ 条用例、非功能用例、CI 门禁、易漏用例清单。
- 部署与运维手册（`docs/60-deployment-ops.md`）：三档部署、配置清单、备份恢复、监控告警、故障 Runbook、升级回滚、值班清单。
- 架构决策记录 ADR-0001 ~ 0010（`docs/adr/`）：NestJS、ORM 待定、monorepo、缓存抽象、鉴权、前端、数据库可切换性、测试策略、代码生成、可观测。
- 编码 / Git / PR 规范（`docs/70-engineering-standards.md`）、贡献指南（`CONTRIBUTING.md`）与 PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`）。
- 项目计划与任务板（`docs/80-project-plan.md`）：15 周甘特、M1–M8 WBS（40+ 任务）、任务板列与标签、风险与度量。

**PRD（按功能/迭代各一份）**

| PRD | 里程碑 | 名称 |
|---|---|---|
| PRD-001 | M1 | 核心骨架：配置 / 日志 / 错误 / 健康检查 |
| PRD-002 | M2 | 数据库抽象层与多库切换 |
| PRD-003 | M3 | 鉴权与权限（RBAC） |
| PRD-004 | M4 | 缓存层 |
| PRD-005 | M5 | 管理后台模板 |
| PRD-006 | M6 | CRUD 代码生成器 |
| PRD-007 | M7 | 队列与定时任务 |
| PRD-008 | M8 | 多租户与规模化演进 |

- 项目 `README.md`：定位、设计原则、技术栈、目录规划、CLI 目标体验、能力矩阵、文档索引、路线图、开发规范。
- 文档一致性核对报告（`docs/95-doc-audit.md`）：全量 25 份文档交叉核对，修复 13 处冲突，记录 5 项遗留待定。
- 注释规范（`docs/70-engineering-standards.md` §1.6，2026-10-09）：注释一律简体中文；每个源文件强制文件头（`@file` / `@description` / `@author` / `@created`，日期 `YYYY-MM-DD`），语义变更追加 `@modified`；JSDoc、`TODO(作者, 日期)` 格式、各文件类型（Vue / SQL / YAML）头写法、`@generated` 约束、禁止事项。
- 文件头校验脚本 `scripts/check-file-headers.mjs`：扫描 `packages/`、`apps/`、`templates/`、`scripts/`，校验文件头与 TODO 格式，`--fix` 自动补头（作者取 `git config user.name`），失败阻断 CI。

### Added（并行分工，2026-10-12）

- 并行开发工作线划分（`docs/85-parallel-workstreams.md`）：把 80 计划的串行里程碑拆为 7 条工作线（L0 契约与集成 / L1 数据访问 / L2 鉴权权限 / L3 缓存队列 / L4 管理后台前端 / L5 CLI 与生成 / L6 质量交付）；8 份先行契约（C-01 错误码、C-02 日志、C-03 `Repository<T>`、C-04 `CacheService`、C-05 权限、C-06 前端 API、C-07 元信息、C-08 Job）；目录所有权矩阵与共享文件窗口制；stub 策略（`MemoryRepository` / `NullCache` / MockServer / `InProcessQueue`）；W0–W10 并行时间轴与 I1/I2/I3 集成点；小团队与 AI 会话并行两种人力映射。
- README 目录索引新增 `85-parallel-workstreams.md`。
- AI 多线程开工执行手册（`docs/86-ai-parallel-execution.md`）：编排者（主会话，兼 L0+L6）+ 5 个执行 agent 的拓扑；Wave 0（主会话独写契约与骨架）→ Wave 1–4 并行，并发上限 4–5；agent 名额表（worktree `F:/WorkBuddy/TY-wt/<lane>`、分支 `lane/<lane>`、目录白名单、首个任务、验收命令）；关键解阻塞项（MemoryRepository / NullCache / mock server / ADR-0002）；上下文包五件套；prompt 模板（新建 / resume / 交接摘要）；主会话每日节奏；冲突处理与防造假四道闸；第一天启动命令。
- README 目录索引与文档表新增 `86-ai-parallel-execution.md`；`85-parallel-workstreams.md` §10 的 worktree 路径统一为 `F:/WorkBuddy/TY-wt/<lane>`。

### Changed

- 编码规范版本 v0.1 → v0.2：新增注释规范章节；反模式清单加第 9 条（缺中文文件头 / 英文注释 / 批量刷新他人作者日期）；PR 提交前与评审清单加入注释检查项。
- 完成定义（DoD）新增「注释」条目；PR 模板（`.github/PULL_REQUEST_TEMPLATE.md`）与 `CONTRIBUTING.md` 同步 `pnpm run check:headers` 与署名要求。
- PRD-001 新增 AC（模板项目与框架包文件头校验通过）；PRD-006 新增 FR-11（生成文件自动写入中文文件头与 `@generated` 标记）及对应 AC。
- 署名统一为 `donttemo`（2026-10-09）：文件头 `@author` 与 `git config user.name` 保持一致；规范示例（文件头 / `@modified` / TODO / SQL 迁移）、`CONTRIBUTING.md`、脚本文件头与 PRD-006 全部对齐；`check-file-headers.mjs` 在 git 未配置署名时回退默认 `donttemo` 并告警。

### Deprecated / Removed / Fixed / Security

- 无（首个版本）。

## 待记录（后续版本的预期变更）

| 预期版本 | 内容 | 关联 |
|---|---|---|
| `v0.1.0`（已发布 2026-10-13） | M1–M4：核心骨架 / 数据库抽象与三库切换 / 鉴权与 RBAC / 缓存层 | PRD-001 ~ PRD-004 |
| `v0.2.0`（已发布 2026-10-14） | M5–M8：管理后台模板 / CRUD 生成器 / 队列与定时任务 / 多租户与规模化演进（OTel、Helm、三大演练） | PRD-005 ~ PRD-008 |
| 待规划 | 内容/门户模板、文件存储抽象、消息通知、开放平台网关、国际化 | PRD 索引「待规划」 |

> 版本号随里程碑推进可能合并或拆分，以实际发布内容为准。
