# 变更日志

本文件记录项目的所有重要变更。格式遵循 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本 2.0](https://semver.org/lang/zh-CN/)。

> **当前状态：v0.1.0 已发布（2026-10-13）** —— 含 M1 核心骨架、M2 数据库抽象层、M3 鉴权与权限、M4 缓存层；M5 管理后台前端（PRD-005）与 M6 CRUD 代码生成器（PRD-006）已完成实现与验证，未发版；M7 队列与定时任务（PRD-007）已完成实现与全量验收（含真实 Redis 失速恢复演练 TC-JOB-008，见 docs/94-queue-stall-drill.md），未发版；运行时已升级 NestJS 11 / Express 5，dev 工具链升至 vitest 4 / vite 8，**`pnpm audit` 生产与 dev 全量零漏洞**。验收结论与证据见 [v0.1.0 发布验收报告](./docs/90-release-v0.1.0.md)。

## 版本与变更规则

- **版本号**：`主版本.次版本.修订号`。`0.x` 阶段次版本可含破坏性变更；`1.0.0` 之后严格按 semver。
- **API 版本**：接口版本走 URL（`/api/v1`），与框架版本号解耦；一个 API 版本废弃前至少并行保留 90 天。
- **变更类型**：`Added` 新增 ｜ `Changed` 变更 ｜ `Deprecated` 即将废弃 ｜ `Removed` 移除 ｜ `Fixed` 修复 ｜ `Security` 安全相关。
- **来源**：需求变更先记入对应 PRD 的「变更记录」，发布时汇总到本文件。本文件只记**对外可见**的变更，内部重构不在此记录。
- **频率**：每个发布版本一条记录；`Unreleased` 区间持续累积，发布时转为版本条目并清空。

## [Unreleased]

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
| `v0.1.0` | M1 核心骨架可用：配置校验、结构化日志、错误码、健康检查、优雅停机、CLI | PRD-001 |
| `v0.2.0` | M2 数据库抽象与三库切换；CI 多库测试矩阵 | PRD-002 |
| `v0.3.0` | M3 鉴权与 RBAC（双 token + 审计） | PRD-003 |
| `v0.4.0` | M4 缓存层（memory / redis + 降级） | PRD-004 |
| `v0.5.0` | M5 管理后台模板 | PRD-005 |
| `v0.6.0` | M6 CRUD 代码生成器 | PRD-006 |
| `v0.7.0` | M7 队列与定时任务 | PRD-007 |
| `v0.8.0` | M8 多租户与规模化演进（含 OTel、Helm） | PRD-008 |
| 待规划 | 内容/门户模板、文件存储抽象、消息通知、开放平台网关、国际化 | PRD 索引「待规划」 |

> 版本号随里程碑推进可能合并或拆分，以实际发布内容为准。
