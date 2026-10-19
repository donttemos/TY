# 变更日志

本文件记录项目的所有重要变更。格式遵循 [Keep a Changelog 1.1](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循[语义化版本 2.0](https://semver.org/lang/zh-CN/)。

> **当前状态：v0.7.5 已发布（2026-10-20）** —— 本次 **v0.7.5 交付 M14（PRD-014）Admin Web 产品化与 SaaS 运营体验升级 B1~B3 全量**：B1 正确性修复（操作原因端到端落库 / 写按钮 v-permission 权限渲染 / 生命周期真实状态驱动 `GET /saas/tenants/:id/lifecycle/status` / 查询状态隔离）+ B2 运营 API 闭环（`POST /saas/plans` 创建、`POST /saas/plans/:id/versions` 版本发布、`GET /saas/tenant-subscriptions` 分页列表与 `GET /saas/tenants/:id/subscriptions/history` 历史，存储端口扩展 Fake/Prisma 双实现，**无新增错误码与迁移**）+ B3 页面产品化（ConfirmWithReason 统一原因收集入口 / TenantPicker 可搜索租户选择器 / 订阅页列表优先重构含详情抽屉 / 套餐页创建+发布闭环含差异预览）。发版记录见 [v0.7.5 发布记录](./docs/90-release-v0.7.5.md)，上一版见 [v0.7.0 发布记录](./docs/90-release-v0.7.0.md)。CI 与真机验收见 §docs/90。
>
> v0.5.0（2026-10-15）：M10（PRD-010）的 P0 + P1 阶段整体成版：**多实例一致性收口**（E-01 任务中心驱动化 memory/db/bullmq 三驱动、E-02 配置中心多实例语义 + nacos 驱动转正、E-03 框架级 API 令牌桶限流默认开启、E-04 `/permissions/tree` 权限树契约落地）+ **规模化遗留**（E-06 bullmq/transport Redis Cluster 实测收口、**E-07 OAuth2 授权码端到端 + apikey 签名验签**，`AUTH_STRATEGY` 四策略名实相符）+ 遗留缺陷收口（N-03 整页 403 视图、bullmq rateLimit 热更重建、R4-05 工作台统计口径标注）；配置键 65→80，新文档 [docs/41 认证策略端到端指南](./docs/41-auth-strategies.md)。
>
> **v0.5.5（2026-10-16）**：M10 P2/P3 在途交付整体成版（E-08 admin 全栈模板、E-09 文件存储端口 `@fw/storage`、E-10 审计归档、E-12 SSE 实时推送、E-13 站内信/通知中心、E-14 i18n、E-15 暗色模式、E-16 边界上限配置化、E-17 前端错误监控 RUM）+ **PRD-011 立项（M11 草案）** + **@fw/auth·cache·queue 驱动审查批量修复（26 项）**，全仓测试 1205 例全绿后整合发版（详见下方 0.5.5 条目）。

## 版本与变更规则

- **版本号**：`主版本.次版本.修订号`。`0.x` 阶段次版本可含破坏性变更；`1.0.0` 之后严格按 semver。
- **API 版本**：接口版本走 URL（`/api/v1`），与框架版本号解耦；一个 API 版本废弃前至少并行保留 90 天。
- **变更类型**：`Added` 新增 ｜ `Changed` 变更 ｜ `Deprecated` 即将废弃 ｜ `Removed` 移除 ｜ `Fixed` 修复 ｜ `Security` 安全相关。
- **来源**：需求变更先记入对应 PRD 的「变更记录」，发布时汇总到本文件。本文件只记**对外可见**的变更，内部重构不在此记录。
- **频率**：每个发布版本一条记录；`Unreleased` 区间持续累积，发布时转为版本条目并清空。

## [Unreleased]

## [0.7.0] - 2026-10-19

### M13：SaaS 运营基础全量（六个 Added 批次 + 一个 Fixed 批次，见下）

- 版本升版 17 个 package.json（0.6.0 → 0.7.0）；发版记录见 docs/90-release-v0.7.0.md（部署步骤/验证矩阵/遗留）。
- 真机部署按 release10 范式执行：M13 十表 PG 迁移 + seed 重跑（权限点/菜单，用户需重登）+ backfill 幂等回填 + 原子切换。
- **真机验收通过**（106.55.32.251）：迁移/seed/backfill/切换/HTTPS 全链 ✓；冻结-恢复 E2E 落库与日志 ✓；4031 拦截在单租户模式（TENANT_ENABLED=false）按设计不生效，启用为环境决策项（详见 docs/90 §4）。
- **修复：SaaS 四页真机 404**——四页误挂 /system 目录导致前端嵌套路由拼成 /system/saas/*；seed/mock 改为顶层「SaaS 运营」目录（/saas），真机重跑 seed 已验证（用户刷新/重登即恢复）。附带根治：1Panel 站点 index.html 补 no-cache 头（详见 docs/90 §4）。

## [0.7.5] - 2026-10-20

### M14：Admin Web 产品化与 SaaS 运营体验升级（B1 正确性 + B2 API 闭环 + B3 页面产品化）

- 版本升版 17 个 package.json（0.7.0 → 0.7.5）；发版记录见 docs/90-release-v0.7.5.md。
- **零迁移 / 零 seed 变更 / 零新错误码**：全部沿 M13 数据模型与 M12 错误契约（1001/1002/1003 既有码），存量环境更新代码即用，无需 reseed。
- 本条目同时归档 M13 发版后滞留 Unreleased 的批次（CI 覆盖率修复 / 文档四件套与工具链冻结 / 运营四页与指标段 / PRD-014 立项草案）。

### Added（M14/PRD-014 B3：SaaS 运营页产品化升级，2026-10-20）

- **统一交互组件（FR-14-08）**：`ConfirmWithReason`——全站唯一原因收集入口（包装 ElMessageBox.prompt，trim 归一、required 前端拦截、取消返回 null 与确认返回值区分，杜绝 U-14-1 类缺陷再现；危险动作必填、普通动作选填）；`TenantPicker`——可搜索租户选择器（复用 /tenants keyword 查询，选项「名称（编码）」，值租户 ID）。生命周期/订阅/用量三页租户输入全部换 TenantPicker，替代手输 ID。
- **订阅页重构为列表优先视图（FR-14-10）**：全局订阅列表（租户/套餐/状态筛选 + 分页 + planCode/planVersion 补全展示）→ 详情抽屉（当前订阅 + 该租户订阅历史）；开通走 TenantPicker + 套餐下拉；取消走 ConfirmWithReason 统一入口。
- **套餐页创建/发布闭环（FR-14-05/06/09）**：「新建套餐」FormDialog（code 唯一 1003 提示）；版本抽屉升级——「发布新版本」复制上一版本为起点 → 行级编辑配额（指标键/限额/执行方式）→ **差异预览**（新增/修改/移除三类标记）→ 确认发布；已发布版本只读标注（「发布走脚本」留白标注移除）。
- **测试**：组件单测 8 例（ConfirmWithReason 4 + TenantPicker 4）+ 视图回归 12 例（订阅页 5 + 套餐页 3 + 生命周期页 4，随 TenantPicker/confirmWithReason 改造同步更新），SaaS 视图 12/12；admin-web 全量 / vue-tsc / smoke-mock / headers / api-parity 见同日验证记录。

### Added（M14/PRD-014 B2：SaaS 运营 API 闭环，2026-10-20）

- **套餐创建 / 版本发布端点转正（FR-14-05/06）**：`POST /saas/plans`（code 唯一 → 409/1003）、`POST /saas/plans/:id/versions`（版本单调递增、发布后不可变语义沿用 M13 领域实现；`limitValue` 接受 number/string 归一非负 BigInt，配额字典未登记 → 404/1002；返回含配额默认项 limitValue 转 string）。审计事件 `saas.plan.create` / `saas.plan.publish`（M12 契约，after 快照）。无新增错误码（沿既有 1001/1002/1003）。
- **订阅列表与历史端点（FR-14-07）**：`GET /saas/tenant-subscriptions`（分页 ≤200 + 过滤 tenantId/planCode/status/expireFrom/expireTo，参数显式白名单，非法 → 1001；排序固定 effectiveAt desc + id asc 主键 tie-breaker）与 `GET /saas/tenants/:id/subscriptions/history`；行内补 `planCode/planName/planVersion`（脏数据回 null 不阻断）。
- **存储端口扩展**：`SaasStore` 新增 `listSubscriptions(filter, page)` / `listSubscriptionsByTenant(tenantId)`；Fake 与 Prisma 双实现同语义（到期范围过滤 expireAt 为 null 不命中）。
- **同步面**：api-spec §3.21 补四行；mock handlers 同构四端点（创建/发布/列表/历史）；smoke-saas-ops 增 S14 段七项断言（22 → 29/29 本地实测通过，含重复套餐 1003、字典未登记 1002、planCode 补全、状态端点 terminated→[dispose]）。
- **测试**：@fw/saas 包 29/29（+3 列表端口语义用例，覆盖率 91.6/81.8/88.2/94.1 达标）；example-api saas 30/30（控制器单测 12 例 + Prisma 集成列表用例，CI 三库矩阵覆盖）；admin-web vue-tsc / example-api tsc 全绿；api-parity / triway 七轴 / headers / no-raw-throw 门禁全绿。

### Fixed（M14/PRD-014 B1：SaaS 运营四页正确性修复，2026-10-20）

- **操作原因端到端（U-14-1，FR-14-01）**：生命周期迁移与订阅取消的确认框输入原因此前被丢弃（`ElMessageBox.prompt()` 返回值未接收、API 调用未传参），现已接收 trim 后透传，落库 `lifecycle_logs.reason` / 订阅取消 reason（API 层与后端 M13 已支持，纯前端修复）。新增视图回归护栏 `lifecycle-page.test.ts` 四例钉住。
- **写操作权限渲染（U-14-2，FR-14-02）**：SaaS 四页写按钮补 `v-permission`（`ops:saas:write`），只读角色不再渲染动作行/按钮；修正订阅页头注释与实现不符。
- **生命周期真实状态驱动（U-14-3，FR-14-03）**：`statusOf` 助手转正为 `GET /saas/tenants/:id/lifecycle/status`（返回 `{status, allowedActions}`，allowedActions 由 `@fw/saas` TRANSITIONS 迁移表派生）；页面改为真实状态驱动，非法动作禁用并带提示，无状态租户显示空态；新增控制器单测 5 例。mock 同步十端点、api-spec §3.21 补行。
- **查询状态隔离（U-14-6 部分，FR-14-04）**：用量页切换租户即重置上一租户的配额/用量数据（此前残留展示）。
- **回归**：admin-web 190/190（186 基线 + 4 新增）+ vue-tsc 全绿；example-api saas 22/22（+5 控制器单测）+ tsc 全绿；smoke-mock 见同日验证记录。

### Added（PRD-014 立项草案，2026-10-19）

- **PRD-014（M14）Admin Web 产品化与 SaaS 运营体验升级立项草案**（`docs/prd/prd-014-admin-web-productization.md`）：基于同日对 main 分支源码的逐条核实（文件行号级证据入 PRD §1.2），将 admin-web 从功能验证型后台升级为运营控制台。四批次顺序：B1 正确性修复（操作原因端到端/权限渲染/生命周期真实状态驱动/查询状态隔离，P0）→ B2 运营 API 闭环（套餐创建与版本发布、订阅列表与历史端点转正既有领域能力）→ B3 页面产品化与统一交互（ConfirmWithReason/TenantPicker/四态骨架）→ B4 用量看板与运营首页（P2）。FR-14-01~14 / NFR-14-1~6 / AC-14-01~12，OQ-14-1~6 待评审（订阅升级/降级默认不进 M14）。PRD 索引同步更新（含 PRD-013 状态改「已发布 v0.7.0」）。

### Fixed（M13 推送后 CI 修复，2026-10-19）

- **`@fw/saas` CI 覆盖率门禁**：第五批新增的 `saas-metrics.ts` 无测试（69-122 未覆盖）+ 纯类型文件（store.port/types）0% 计入分母 → CI test:coverage 三项不达标（81/82/79 vs 85）。修复：补 `metrics.test.ts` 3 例（七计数器 render 数值断言 + reset 全零结构 + 段开关 + 高基数护栏 `tenantId=/metricKey=` 不得出现的断言）；vitest coverage exclude 增 `src/types.ts` / `src/store.port.ts`（沿 @fw/tenant 先例）。26/26 过，覆盖率 91.42/80.73/86.45/93.5。**教训登记：新包引入后本机必须跑 `test:coverage`（非裸 `vitest run`）再推送**。
- **CI 结果（16377db → 44e5341 修复后全绿）**：构建/单测/静态检查 success + **三库集成矩阵 postgres/mysql/sqlite 三腿全 success**——M13 剩余项「三库矩阵验证」由 CI 完成覆盖（真机窗口仅剩部署验收）；工具链冻结的 CI `node-version: 22.22.2` pin 生效验证通过。

### Added（M13 第六批：主线 B 文档四件套 + 工具链冻结落地，2026-10-19）

- **docs/42 开发环境指南**（OQ-13-4 定案：与 47 并列，42 号落地）：运行时基线、安装七步、常用命令、端口表、已知环境坑（沙箱 tsc/deploy 静默等四项）。
- **docs/48 可复现构建规范**：单一权威来源（packageManager/`.nvmrc`/lockfile/engines）、版本冻结矩阵（六处）、安装构建纪律（frozen-lockfile、依赖序、Prisma 双 generate、无隐式网络）、平台差异登记、历史违规示例（v0.2.0 双写 version / `@fw/tenant` 漏 CI 循环 / 三处同步假绿）。
- **docs/49 Dev Container 指南 + `.devcontainer/devcontainer.json`**：`node:22.22.2-bookworm` 基镜像、postCreateCommand（corepack + frozen-lockfile 安装 + Prisma 双 generate）、五端口转发命名、corepack/引擎平台/权限三项 FAQ。
- **docs/97 可复现性验证清单**：工具链版本矩阵八项 + 干净构建五步 + 门禁抽检 + 行为一致性抽检（4029/4031/metrics）+ 已知差异豁免口径 + 首次留痕。
- **工具链冻结实改**：新增 `.nvmrc`（22.22.2）；CI `setup-node.node-version` 由浮动 `22` pin 为 `22.22.2`（两处）——minor 漂移曾是 engine 行为差异来源。
- **docs/47 §2.4** 主线 B 表更新为实际交付位与状态；README 文档索引补 47/42/48/49/97 五条。

### Added（M13 第五批：admin-web 运营四页——SaaS 运营面用户可见交付，2026-10-19）

- **四页（views/saas/*，PRD-013 §2.3）**：套餐管理（列表 + 版本/配额抽屉，发布后不可变语义标注）、订阅管理（查询/开通/取消，一租户一生效 1003 前端提示）、租户生命周期（六动作迁移 + alreadyApplied 幂等提示 + 历史日志表）、用量看板（生效配额 + 窗口用量进度条 + 运营补录上报，4029/deduped 文案区分）。动态路由经菜单树生成（views glob 自动解析），无权限菜单不出现。
- **API 模块 `src/api/saas.ts`**（九端点封装）+ types 四视图（BigInt 值后端已转 string）。
- **菜单入 seed**（系统管理目录 4 项，permissionCode=ops:saas:read）+ mock 同步（菜单 4 条 + 权限点 2 条 + saas 预置数据）；**存量环境需 reseed + 重登**。
- **mock handlers /saas/* 九端点**（迁移表与 @fw/saas 逐条同语义：4030/幂等/1003/4029 details/deduped），smoke-mock **140/140**。
- **错误码文案表**：4029/4030/4031 入 zh-CN/en-US locale（ErrorMessages 键集与 BIZ_CODE 编译期同构，缺键即构建失败）。
- **门禁修复**：`@Controller('/api/v1/saas')` 前导斜杠（既有约定，api-parity 路径归一按字面拼接）；模板不引 saas 调用面（模板 server 无 saas 域，triway A 轴提示保持零）。triway 七轴 / api-parity / headers 664 全绿。
- **验证**：admin-web 186/186 + build ✓ + smoke-mock 140/140 + example-api saas 17/17 + smoke-saas-ops 22/22。

### Added（M13 第四批：fw_saas_* 指标段 + smoke-saas-ops 端到端 + 集成建库兜底，2026-10-19）

- **`fw_saas_*` 指标段（@fw/saas saas-metrics.ts，M12 契约范式）**：`fw_saas_quota_checks_total{execution}` / `quota_exceeded_total`（4029）/ `usage_deduped_total` / `lifecycle_transitions_total{action}` / `lifecycle_invalid_total`（4030）/ `tenant_suspended_rejected_total`（4031）/ `sweep_total{result}`；低基数护栏（禁 tenantId/metricKey 入 label）；段开关 `METRICS_SAAS_SECTION_ENABLED`；埋点在 UsageService/LifecycleService/Guard。
- **`POST /saas/tenants/:id/usage/events`**：用量事件上报端点（运营补录/业务对接面，走 ADR-0030 全语义；4029 时补 `saas.quota.exceeded` 审计事件）。
- **`smoke-saas-ops.mjs`（22/22，入 CI）**：SaaS 闭环端到端——admin 登录 → 开租户+订阅 → 一租户一生效 1003 → 用量 ×10 + 超限 4029（details 三字段）→ 幂等键重放 deduped → 用量查询 → **冻结租户仍可登录 + 业务请求 4031（acme 租户 + acmeadmin 自身身份命中业务面）** → legacy 租户不受影响 → resume 恢复 → terminate → 迁移历史 + `/metrics` 三指标断言；前置数据自足（default 套餐/v1/配额项不存在时自建，不依赖 backfill）。
- **租户五态透传（@fw/tenant，ADR-0031 §3 衔接）**：`TenantInfo.status` 扩为 0~4 五态 Int；`assertUsable` 仅拒存量停用（0，M8 既有语义）——grace/frozen/terminated 放行至业务面由 SaasLifecycleGuard 4031 拦截（**冻结租户登录/导出白名单面必须可达**，此前在解析层即 4001）。tenant 包 34/34 零回归。
- **配置键登记补全**：`SAAS_GRACE_PERIOD_DAYS` 入 envSchema（zod 正整数默认 7）+ ENV_KEY_PATHS（`saas.gracePeriodDays`，非热更 boot 键）——triway F 轴修复。
- **集成测试建库兜底（`src/testing/apply-sqlite-migrations.ts`）**：沙箱 `migrate deploy` 出现**完全静默不落盘**（exit 0、0 表；与 turbo 231 同族环境症状）——deploy 后校验基线表、缺失则按序直建全量迁移 DDL（逐行剥注释）；refresh-rotation / observability-chain / saas 三个集成 spec 共用。**沙箱环境症状登记，CI（Linux）deploy 正常不受影响**。
- **验证**：example-api 全量 **138/138**（含修复的 auth 集成 12 例）+ @fw/saas 23/23 + @fw/tenant 34/34 + smoke 22/22；门禁 triway 七轴 / headers 659 / api-parity / no-raw-sql 全绿。

### Added（M13 第三批：运营 API + 冻结 Guard + 到期任务——SaaS 后端闭环，2026-10-19）

- **权限码（PERM）**：`ops:saas:read` / `ops:saas:write`（SaaS 运营面读写分离；与 `system:tenant:ignore` 组成跨租户维护路径，沿 /tenants 管理面先例）+ seed 权限点两条（admin 全量授权自动持有；**存量环境需 reseed + 重登**）。
- **运营端点 `/api/v1/saas/*` 九个（api-spec §3.21）**：套餐列表/版本、订阅创建/取消/查询、生效配额、窗口用量（rollup 重算）、生命周期迁移（非法 4030 / 幂等 alreadyApplied）与历史。整类 `@IgnoreTenant()` + `@LifecycleExempt()`，写操作带审计（M12 六字段 + after 快照）。
- **业务入口冻结拦截（`SaasLifecycleGuard`，APP_GUARD 注册序在 RbacGuard 后）**：frozen/terminated 租户业务请求 4031；放行面 = @Public + @LifecycleExempt 白名单（默认拒绝）+ 无租户上下文（单租户模式沿既有行为）。余量缓存优化（60s + 迁移失效）登记待办，当前直查以正确性优先。
- **到期处置任务（`SaasLifecycleJobs`，@Cron 每小时 + 分布式锁）**：active 订阅到期 → 租户 grace + 订阅置 expired；宽限期满（`SAAS_GRACE_PERIOD_DAYS`，默认 7）→ frozen；条件更新幂等（重复执行 alreadyApplied 短路不重复记日志）；单条失败不中断整批。配置键三处登记（.env.example / docs/60 / api-spec §3.21）。
- **端口扩展**：SaasStore 增 `listPlans` / `listActiveSubscriptionsExpiredAt` / `listGraceTenantsPastGrace`（Fake + Prisma 同步）。
- **测试**：saas 模块 17/17（集成 9：并发零超发等；守卫/任务 8：ALS 上下文经 runWithRequestContext 驱动）；auth 包 227/227 零回归。门禁：triway 七轴（含新权限码）/ headers 656 / no-raw-sql / api-parity 全绿。
- **坑（登记）**：迁移 SQL 按「分号切分 + 整段以 `--` 开头即丢弃」会把与注释同段的 CREATE TABLE 一并吞掉（departments 缺表连锁 no such table）——本地临时库建库已改为逐行剥注释 + 全量 DDL 直建（不与 deploy 部分应用态混跑）。

### Added（M13 第二批：Prisma 驱动接线 + 集成验证 + 存量回填，2026-10-19）

- **PrismaSaasStore（`SaasStore` 端口的 example-api 适配器）**：M13 十表映射；`consumeAtomic` 单事务落地 ADR-0030 不变量（事件幂等键唯一约束 → 窗口行初始化撞唯一键重读 → 条件 UPDATE 扣减，exceeded 整体回滚不留痕）；`conditionalUpdateStatus` 五态 Int 映射（0 存量停用 → frozen，1 → active）；`active_marker` 唯一兜底一租户一生效订阅（服务层校验 + 1003）。
- **SaasModule（example-api）**：`SAAS_STORE` token + 五服务装配（Plan/Quota/Subscription/Usage/TenantLifecycle），已接入 app.module；运营 API/到期任务/业务入口 Guard 随后续批次消费。
- **集成测试（`prisma-saas-store.integration.spec`，9/9）**：本地临时 sqlite + migrate deploy（受限环境 DDL 兜底按序执行、已存在对象幂等跳过）；覆盖超限事件回滚语义、**12 线程并发逼近硬限额零超发（AC-13-04）**、幂等键去重不重复计量、软限额告警同窗幂等、observe 仅留痕、active_marker 唯一冲突 1003、生命周期条件更新幂等 + 日志逐条。CI 矩阵可经 `SAAS_TEST_DB_URL` 直连 service DB。
- **存量回填脚本（`apps/example-api/scripts/backfill-saas.mjs`，ADR-0029 §2.2）**：确保 default 套餐 + v1；status=1 → active 订阅（expireAt 沿用）、status=0 → cancelled（不占 marker）；按租户无订阅才建，**幂等**（本机 dev.db 实测：首跑 3 active + 1 cancelled，重跑 4 全跳过）；`--dry-run` 支持；不改写 tenants 三列。

### Added（M13 SaaS 运营基础：契约冻结 + 领域包首批发起，2026-10-19）

- **ADR-0029/0030/0031 已采纳**（编号顺延：0028 已被 cache 标签 Cluster 兼容策略占用）：0029 套餐/订阅/生效配额三层模型（`tenants.plan/status/expireAt` 转派生只读 + active_marker 三库一致方案）；0030 硬限额并发扣减（DB 条件 UPDATE 唯一事实源 + Redis 仅预检 + 软限额同窗幂等告警 + observe 仅统计）；0031 租户五态生命周期（迁移表唯一权威 + 条件更新幂等 + 冻结 4031 作用于业务入口）。
- **错误码登记（三副本 + 工件同源）**：4029 配额超限（429）/ 4030 非法生命周期迁移（409）/ 4031 租户冻结（403）——core 源 + error-codes.json 工件 + 前端/模板/mock 副本 + `docs/40` 码表；`check-triway-consistency` 七轴全绿。
- **Schema 三库同构**：`example-api` 新增 M13 十表（plans/plan_versions/plan_quotas/quota_definitions/tenant_subscriptions/tenant_quotas/tenant_quota_windows/usage_events/usage_rollups/tenant_lifecycle_logs）+ 迁移 sqlite `20261019130000`（已在本机 dev.db 执行，10 表落库）与 pg 增量（migrate diff 生成）；mysql init 重新生成（19→29 表）；模型段逐字节一致校验通过（仅既有登记差异）；数据字典 `docs/30` §3.20~3.29。
- **新包 `@fw/saas`（领域逻辑首批发起）**：PlanService（版本递增发布、发布后不可变）/ SubscriptionService（一租户一生效 + plan_quotas 快照）/ QuotaService（生效值 = manual 覆盖 ?? 套餐默认、窗口切片）/ UsageService（consumeAtomic 限额编排、软限额幂等告警钩子、rollup 重算闭环）/ TenantLifecycleService（迁移编排 + 幂等重入判定 + 4031 断言）；持久化经 `SaasStore` 端口（Fake 驱动单测 23/23，覆盖率 92/84/92/95 过门禁；Prisma 驱动随 example-api 接入批次交付）；CI 包列表（build/test 两处循环）已同步。
- **注意（沙箱环境登记）**：本机 `prisma migrate deploy` 静默不执行（CLI 输出异常，与 turbo 231 同类症状）——sqlite 迁移经直连 SQL 执行并回填 `_prisma_migrations`；pg/mysql 迁移在真机部署窗口按既有流程执行前需人工核对。

### Added（文档：M13 立项草案，2026-10-19）

- **[PRD-013](./docs/prd/prd-013-saas-operations-foundation.md)（M13 草案）**：SaaS 运营基础落地（主线 A：套餐/订阅/配额模型、用量幂等与硬限额并发执行、租户五态生命周期、运营 API 与管理端、账单基础，FR-13-01~16 映射 PRD-011 S-01~S-07，不另建第二套需求体系）+ 可复现开发环境（主线 B：工具链冻结、开发环境文档四件套、验证矩阵边界声明，FR-13-17~21）；验收 AC-13-01~14，关键设计待 ADR-0029~0031 冻结（ADR-0028 已被 cache 标签 Cluster 兼容策略占用，编号顺延）。
- **[docs/47 开发文档](./docs/47-saas-foundation-dev-guide.md)**：PRD-013 配套技术设计——技术架构（新增 `@fw/saas` 领域包七模块）、关键接口（plans/tenant-subscriptions/quotas/usage/lifecycle/bills 六资源 + 错误码 4029/4030/4031）、数据结构（9 组新表 + `tenants` 存量字段派生化兼容策略 + 五态状态机）、五阶段实施计划（P0 基线 → P1 契约冻结 → P2 环境自动化 → P3 核心闭环 → P4 实机验证）。

### Fixed（P1 加固：标签脚本写序与失效返回值口径，2026-10-19）

- **`SET_TAGS_LUA` 写序重排（P1 加固）**：预检只能收敛**确定性**错误（WRONGTYPE / 标签键撞值键），预检通过后的**资源类**故障（OOM / 只读副本）仍会中止脚本并保留已执行命令。写序由「写值 → 登记索引」改为「**预检 → 登记索引 → 最后写值**」：残余故障的最坏结果由不可回收的**孤儿缓存**（有值无索引，标签失效永远触达不到）翻转为无害的**幽灵索引**（索引指向不存在的键：失效时 DEL 不存在的键无副作用，标签集合 TTL 到期自回收）。`store.port` 契约同步登记写序约束。
- **`INVALIDATE_TAG_LUA` 返回值对齐（P1 加固）**：脚本原返回**成员个数**（`#members`），memory 驱动返回**实际删除数**——幽灵成员场景下两驱动不一致。现改为累加各 `DEL` 的返回值，与端口契约「实际删除数」及 memory 驱动一致。
- **故障注入回归**：Fake 客户端新增写值阶段注入点（`failValueWriteOnce`，模拟资源类故障下已执行命令不回滚），锁定「只留幽灵索引、绝不留孤儿缓存 + 恢复后可正常写入」；跨驱动契约新增「幽灵索引 ⇒ invalidateByTag 返回 0 且索引被清理」；真实 Redis 侧新增 maxmemory + noeviction OOM 注入用例（门控 `CACHE_REDIS_INTEGRATION_ALLOW_MEMORY_FAULT`，默认跳过以免干扰并行写入；本机无 Redis，**未执行**）。

### Fixed（代码复核 P1/P2 修复，2026-10-18）

- **Redis 标签 Lua 的运行时错误保护（P1）**：`SET_TAGS_LUA` 改为「写前只读预检 → 通过后才写」。Lua 只保证**不可交错执行**、运行期报错**不回滚**——原顺序（先 SET 再逐个 SADD）在某个标签索引键被占成字符串（WRONGTYPE）时会留下「有值无索引」的孤儿缓存。现预检覆盖**全部**标签键类型与「标签键 == 值键」，任一不满足即零写入失败；memory 驱动同口径（此前会把字符串标签条目静默换成集合）。回归：`redis-driver`（Fake）+ `store-contract`（跨驱动）+ `redis-integration`（真实 Redis，注入类型污染后值键不存在）。文档口径同步澄清：`store.port` / `docs/contracts/cache.ts` 的「原子」= isolation，**不是事务回滚**。
- **双节点冒烟脚本的前缀安全与清场边界（P1）**：`smoke-dual-node.mjs` 新增 ①复用模式强制显式 `DUAL_PREFIX`，前缀仅允许 `[A-Za-z0-9._:-]`（禁 glob 元字符/空白），无测试语义段（smoke/test/it/tmp/temp）时须 `DUAL_PREFIX_ACK=1`；②启动后向两个实例读 `/api/v1/demo-cache/stats` 的**实际前缀**核对一致，不一致立即中止；③清场从 `${PREFIX}:*` 收窄为脚本自有的四个命名空间并校验键范围（含 `DUAL_CLEANUP_MAX_KEYS` 熔断）；④清场失败记为 **FAIL 并使脚本非 0 退出**（不再静默），清场/关闭连接/回收子进程改嵌套 try/finally，Redis 断连不再跳过 Node 进程回收；⑤新增 T5.1c「异 UA grace 重试被拒」，同时作为两节点 `AUTH_FINGERPRINT` 配置漂移探针。`cache-demo` 的 `/stats` 增 `prefix` 字段（自检端点，仍受 `DEMO_ENDPOINTS_ENABLED` 门控）。
- **双节点冒烟脚本的清场实现（P1 续，2026-10-19 复核二轮）**：脚本内**彻底移除 `KEYS`**——断言与清场均走 SCAN 游标（`DUAL_SCAN_COUNT`，默认 500），清场按 `DUAL_CLEANUP_BATCH_SIZE`（默认 500）**分批 DEL**，避免 O(N) 阻塞命令与超长 DEL；键范围/数量校验提前到 SCAN 收集阶段（超限即中止且**不删除任何键**），安全开关改为正整数解析（非法值 fail-fast）。T2 的 id 改为本次运行唯一后缀（可 `DUAL_FIND_USER_ID` 覆盖），孤儿/幽灵断言只针对本次运行写入的键，复用模式下的历史遗留键不再造成误判。**实测**：临时 Redis 5.0 上 20/20（含 `INFO commandstats` 证明 `keys` 调用为 0、1200 个同命名空间键分 3 批删净、同前缀业务键保留、`DUAL_CLEANUP_MAX_KEYS=1` 时清场 FAIL 且脚本 exit 1、中止时零删除）。
- **Refresh Token grace 指纹的缺失值旁路（P1）**：重试方指纹改为**无条件计算**（缺失 UA = `SHA-256("")` 定值，ADR-0022 决策 3a），赢家 `rotated_fingerprint` 非 NULL 即比对；`AUTH_FINGERPRINT=off` 只影响新轮换是否写指纹，不再让已有指纹行的 grace 重试走到「本次无指纹 ⇒ 放行」。配置漂移时异端仍判 replay（族撤销 + 审计），同端照常返回 B，并补 warn 日志。回归 L6-07/08/09。
- **锁 API 参数校验（P2）**：`LockManager.acquire()` 入口统一校验 `ttlMs`（必须正数）与 `waitMs`（≥0 有限值），放在重入分支之前——此前重入路径不写存储、绕过驱动侧 TTL 校验，非法 TTL 会「重入成功」；校验失败不改重入深度。`CacheService.lock()` 的 `waitMs` 校验置于 guarded 之前，非法参数 fail-fast，不被 fail-open 吞成 null。

### Fixed（双节点冒烟：数据库副作用保护，2026-10-19 复核三轮）

- **T5.1c / T5.2 会撤销账号全部 refresh 会话，默认改为跳过**：异 UA replay 与过期 replay 走 `handleReplay` → `revokeUserRefreshTokens`，副作用落在**数据库**（不受 Redis 清场命名空间约束）——复用共享实例时会把操作者/真实用户的登录踢下线。现在两条用例默认 `SKIP`（脚本明确打印原因），开启需 `DUAL_ALLOW_SESSION_REVOKE=1`，且：
  - 默认改用种子专用账号 `alice`；若解析结果仍是 `admin`，必须再显式 `DUAL_ALLOW_ADMIN_REVOKE=1`，否则起服务前 exit 1；
  - `DUAL_AUTH_ACCOUNT` / `DUAL_AUTH_PASSWORD` 可指定任意账号（非内置种子账号必须给口令，缺失即 exit 1）；
  - T5.0/T5.1a/T5.1b 与 T5.2 统一使用同一账号，避免「用 admin 的 token 触发撤销」的错位；
  - CI base 作业是一次性 seeded SQLite，显式开启并绑定 `alice` 以保留覆盖（20 断言）；共享库/真实用户库保持默认关闭（19 断言）。
- **实测**（临时 Redis 5.0）：默认 19/19（T5.1c SKIP）、`DUAL_ALLOW_SESSION_REVOKE=1` 时以 alice 跑 20/20（T5.1c PASS，code=3001）、`DUAL_INCLUDE_REPLAY=1` 但未开 ALLOW 时 T5.2 也 SKIP 且不等待 11s、ALLOW+admin 无例外 → exit 1、未知账号无口令 → exit 1。

### Known issues（登记，2026-10-18）

- **`/ready` 的 db 就绪探针是启动期一次性标志，非实时探测**（独立修复项，与 Redis 双节点验收无关，登记见 `docs/96-db-readiness-probe-issue.md`）：`createDbReadinessProbe.check()` 直接返回 `markConnected()` 的启动期布尔——启动时 DB 不可达则恢复后仍永久 `db:fail`（须重启）；运行期断连却仍报 `db:ok`。同场景 cache/queue/transport 探针为实时 ping，语义不一致。建议修法：带 1~2s 超时的实时 `SELECT 1` 探测 + 连续失败 N 次翻转（防抖）。

### Added（双进程双节点一致性冒烟入 CI，2026-10-18）

- **`smoke-dual-node.mjs` 进 CI base 作业**：把《Redis 多实例测试.md》真机方案（Windows↔云 30/30）的协议层断言固化为门禁——脚本自起 A/B 两个实例（3100/3101，可 `DUAL_PORT_A/B` 改），共享同一 Redis service、同一 SQLite 库与同一 `CACHE_PREFIX`，验证：T2 缓存跨实例读写与标签失效（B 命中 A 写入的缓存、B 失效后 A 回源、重建后键↔索引无孤儿）；T3 跨实例锁互斥；T4 锁 TTL 过期与旧令牌保护（旧句柄 renew/release 不伤害新持有者）；T5.1 同一旧 refresh token 经 A/B 并发刷新 ⇒ 唯一 replacement（grace + 同 UA 指纹）；`DUAL_INCLUDE_REPLAY=1` 追加 T5.2 过期 replay → family revoke（含 11s grace 等待）。未设 `DUAL_REDIS_URL` 时整脚本 SKIP；`DUAL_A/DUAL_B` 可切换为「驱动既有实例」模式（真机跨机器复跑用，不再需要本地专属 harness）。本地实测 17/17 通过。
- 顺带修正：`@fw/cache` 的 `exports` 仅声明 `import` 条件，跨包脚本须走 `import.meta.resolve` + 动态 import（CJS `require.resolve` 不可用）；ioredis 以其入口为基准 `createRequire` 解析，脚本内零硬编码绝对路径。

### Added（真实 Redis 单实例集成验证 + Cluster 兼容策略，2026-10-17）

- **Redis 单实例集成测试进 CI（回归测试设计 §9.4 落地）**：新增 `packages/cache/src/__tests__/redis-integration.test.ts`——连真实 Redis 单实例验证 Fake 客户端无法证明的服务端契约：① 标签原子协议（`setWithTags` 写值+登记 / `invalidateByTag` 读成员+删成员+删索引的 Lua 真实执行、双客户端「失效×写入」并发不变式——无孤儿键无幽灵索引）；② 锁 CAS 与 SET NX 竞争（两客户端单胜者、令牌隔离、释放幂等）；③ **真服务器端 TTL 过期**（非驱动惰性删除）；④ 故障路径（WRONGTYPE 类型错误显式抛错且原数据不覆盖、连接被外部 kill 后自动重连、**关停后 fail-open 降级返回空 / fail-closed 抛 9002**）。CI base 作业新增 `redis:7-alpine` service 容器与独立步骤；门控 `CACHE_REDIS_INTEGRATION_URL`（未设置整体 skip，本地默认无 Redis），破坏性关停用例另需 `CACHE_REDIS_INTEGRATION_ALLOW_SHUTDOWN=true`（保护共享本地实例）。**本地实测 Redis 8.4 9/9 通过**。
- **ADR-0028（缓存标签索引的 Redis Cluster 兼容策略）**：slot 约束分析——值键 ↔ 标签索引键为 N:M，**必须全部同 slot，只给标签键加 hash tag 不满足约束**；四方案评估（A 单全局 tag 分片归零 / **B prefix 作用域 tag【定案，键格式版本化+双读迁移，列入后续版本】** / C tenant 作用域（键无 tenant 上下文，改动面最大）/ D 重设计放弃多键原子性（回归 C-01/C-03 要消灭的孤儿键，不采纳））。当前版本限制四路登记：`store.port.ts` / `docs/contracts/cache.ts` / **驱动构造期 cluster 客户端告警**（`isCluster` 检测）/ ADR 本文档。
- **发布验证矩阵三档区分**（`docs/90-release-v0.6.0.md` §7）：**Fake 驱动测试通过**（调用映射，149 例常驻）≠ **单实例 Redis 验证通过**（CI service 门禁）≠ **Redis Cluster 验证通过**（未验证，CROSSSLOT 限制 + ADR-0028）；表述纪律入档。

### Fixed（发布后真机验证补丁，2026-10-17）

- **demo 自检面在 prod 未真正关闭（OBS-16，真机实测发现）**：`DemoController` 只 `import` 了 `DemoEndpointsGuard` 却**未加 `@UseGuards`**——`APP_ENV=prod` 且未设 `DEMO_ENDPOINTS_ENABLED` 时，`/api/v1/demo/*`（`/demo/ok`、`/demo/boom`、`/demo/items` CRUD、`/demo/log-sensitive`）仍**公网 200**，与 `docs/46` §4「四控制器 404」漂移（demo-queue / demo-transport / cache-demo 三个控制器守卫正常）。修复：补类级 `@UseGuards(DemoEndpointsGuard)`（commit `0944864`）；`demo-endpoints.guard.spec.ts` 增**四控制器 guard 挂载元数据断言**（修复前必红，修复后 4 passed）。真机重建重发后四端点与公网入口均 **404**。

### Docs

- **真机实测记录入库（v0.6.0 部署窗口）**：`docs/63` 新增 §6（发版动作与耗时、W3 边界矩阵、OBS-13 链路实测值、真机专属缺陷与处置、回滚面）；`docs/45` §6 排障样例补 **journald 档**并注明「公共 refresh 路由 ALS 无 userId，userId 在 ctx」；`docs/46` §4 登记 DemoController 漏挂修复与四控制器元数据断言；`docs/90-release-v0.6.0` 新增 §6 并更新 §5 遗留；PRD-012 AC-OBS-13/16/19 勾选与范围边界同步（Nginx 实例对齐、K8s NetworkPolicy 仍为登记项）。

## [0.6.0] - 2026-10-17

### Added（M12 W3 · 运维端点安全边界与暴露面收敛，ADR-0027，2026-10-17）

- **OBS-15 maintenance 三层安全边界**：`/api/v1/auth-maintenance/{refresh-cleanup,audit-archive,key-ring}` 由类级 `@Public` 裸奔收敛为 **`ops:read` 权限守卫**（OQ-4 定案权限码方案，复用 RBAC/审计链路；`OPS_TOKEN` 逃生门登记 ADR-0027 备选未启用），未登录 `3001` / 无权限 `3002`；三端点统一 `Cache-Control: no-store`（此前仅 key-ring 有）；`PERM.OPS_READ` 进权威表 + example-api seed 声明 + admin 全量授权（**存量环境需 reseed 或手工补权限点**）。反向验证：契约测试元数据断言（类级无 `@Public` + `@Permissions('ops:read')` + 三端点 no-store）；部署侧 maintenance 不上公网（见 OBS-19）。
- **OBS-16 运维端点全量普查与 demo 收敛**：新文档 **`docs/46-ops-endpoints.md`**——全仓 @Public/公开路径逐条登记（必要性/暴露面/敏感度/环境约束），三层模型（Public 自检 / Protected maintenance / 业务公开面）。`DEMO_ENDPOINTS_ENABLED` 新配置键（未设置按 `APP_ENV=dev`/`NODE_ENV=development` 判定）：`DemoEndpointsGuard` 应用到 demo*/cache-demo/demo-queue/demo-transport 四个自检控制器，**非 dev 默认 404**（不暴露存在性而非 403）；反向验证 `demo-endpoints.guard.spec.ts`（显式开关优先/dev 默认开/其余关/关闭 404）。
- **OBS-17 健康语义文档化**：`/health`（liveness）/`/ready`（readiness）语义标签落 `docs/46` §1；**路径不重命名**（K8s 探针映射不变）；具名别名未做（无消费方，登记）。
- **OBS-18 maintenance 快照契约统一**：任务快照公共字段集冻结 `{ name, expression, enabled, runs, lastRunAt, lastDurationMs, lastError }` + 各自特有段——additive 补 `enabled`（= `MQ_CRON_ENABLED`）与 audit-archive 的 `lastDurationMs`（此前缺）；`lastCutoff` 两任务语义同为「最近一次运行截止线」（非同义并存，保留）；契约测试锁定形状。
- **OBS-19 部署侧边界同步**：`check:helm` 扩展 **Nginx 三份一致性轴**（65/65）——① 免鉴权探针白名单覆盖集一致（health/ready/metrics）；② **maintenance 不上公网**（三份均不得为 auth-maintenance 建立公开放行，应用层权限码为主、部署侧纵深）。**真机 1Panel 实测边界待执行**（与 AC-OBS-13 排障样例实测同批，需用户配合窗口）。
- **新 ADR-0027**（运维端点安全边界：三层模型 / 默认受保护原则 / OQ-4 定案 / demo 收敛 / 部署侧一致性）；文档同步 `docs/40`（maintenance 口径）、`docs/46` 新建、`docs/60` §3（`DEMO_ENDPOINTS_ENABLED`）、`.env.example` ×2、README 导航、ADR 索引。**回归**：example-api 契约/守卫 spec 8 条新增全绿、config 门禁同步、helm 65/65、headers/no-raw-throw/triway 七轴全绿。

### Added（M12 W1 续 + W2 · 错误族收敛 / 禁裸抛 / 码表单一来源 / 契约测试 / Observability 贯穿，2026-10-17）

- **W1 收口（OBS-01/02/03/08，ADR-0025 修订）**：① **错误族收敛（OBS-01）**——`@fw/telemetry` 错误族继承 `@fw/core BizError`（`TelemetryUnavailableError`→9002、`TelemetryConfigError`→5002，`instanceof` 既有断言零改动通过）；两类**证据驱动改判**登记 ADR-0025：`TransportError` 族改②类（既有测试以 `not.toBeInstanceOf(BizError)` 锁定跨进程重建契约，重建身份由载荷 code 决定；「调用方转换」已在 demo-transport `mapTransportError` 落地）、`ConfigValidationError` 改③类（config→core 会造包循环依赖，bootstrap fail-fast 不经 HTTP 面）。② **禁裸抛门禁（OBS-02）**——新增 `check-no-raw-throw`（`scripts/check-no-raw-throw.mjs`，接入 CI base 作业）：扫描 packages/apps/templates 生产目录 `throw new Error(`，白名单仅 CLI（不暴露 HTTP）+ 行级显式注解 `fw-allow-raw-throw:<理由>`（6 处：TokenService ×4 = ADR-0020 Rule 8 冻结 / demo 演示本体 ×2），**存量迁移约 60 处 → BizError 统一码**（key-ring ×13→5002、storage key ×6→1001、tenant-admin 并发冲突→**1004**（修复「并发修改被降级 9001」）、job 驱动→1001、redis/nacos/缺依赖→9002 等；`9001→精确码` 行为修正见 Changed）。③ **码表单一来源（OBS-03）**——`check-triway-consistency` 升**七轴**：新轴 G 以 `@fw/core ErrorCode` 为唯一权威，`error-codes.json` 工件（`pnpm gen:error-codes` 生成 + 门禁 --check）与前端 `BIZ_CODE` / 模板 `BIZ_CODE` / mock `CODE` 三副本值集合逐一相等，**篡改任意一份即构建失败**（mock 补齐缺失的 4001/9002/2001 三码）。④ **契约测试（OBS-08）**——core `error-contract.test.ts`（16 码逐一锁定信封形状 + http 映射 + `details` 顶层 + 未知异常收敛 9001 不含内部细节/stack + `HTTP_TO_ERROR_CODE` 互逆自洽）、auth `audit-no-secrets.test.ts`（replay 审计行序列化零 token 明文/cipher 段）、admin-web `error-code-contract.test.ts`（双语言 i18n 键覆盖全部错误码）。
- **W2 Observability 贯穿（OBS-09~14，ADR-0026 已采纳）**：⑤ **requestId 双 ID 分层（OBS-09）**——per-request ULID（26 位 Crockford Base32）进 ALS + `X-Request-Id` 回带，上游合法复用/非法替换；`REQUEST_ID_ENABLED`（false 回退仅 traceId 零差异）/`REQUEST_ID_HEADER` 新配置键；**错误信封 additive 增 `requestId`**（请求上下文存在时输出）；前端 `BizError.requestId` + `utils/trace.ts` 记忆 + mock/模板三副本同步。⑥ **ALS 扩展（OBS-10）**——`RequestContext` 增 `requestId/familyId/jti`；`RbacGuard` 写 userId 时同写 jti/familyId，`RefreshTokenService.rotate` 边界补写；**`TokenService` 文件 diff = 0**（ADR-0020 Rule 8）。⑦ **logger 自动身份（OBS-11）**——`LogRecord` 顶层自动输出 `userId/requestId`（默认集，`LOG_IDENTITY_FIELDS` 门控，空串关闭）+ 可开 `familyId/jti`；调用方手塞同名 ctx 不覆盖自动字段（反向验证锁定）。⑧ **auth/security 指标段（OBS-12）**——`@fw/core` 新增模块级指标段注册表（零新依赖），`/metrics` 追加 `fw_auth_login_total` / `fw_auth_refresh_total` / `fw_auth_token_verify_failed_total{reason}` / `fw_security_replay_detected_total{reason}` / `fw_security_family_revoked_total`；**基数护栏**单测锁定 label 仅 `result`/`reason` 低基数枚举（userId/familyId/jti/requestId 禁入）；`METRICS_AUTH_SECTION_ENABLED` 开关。⑨ **链路贯通（OBS-13）**——新增 `observability-chain.integration.spec.ts`（SQLite 真库）：replay 场景下 `requestId+traceId` 在 `audit_logs` 行 / 结构化日志 / `/metrics` 计数三处一致可关联 + 九要素断言（响应头第四处由 core 单测锁定）；新文档 **`docs/45-observability-contract.md`**（信封字段级契约 + 实测排障样例）。⑩ **审计检索扩展（OBS-14）**——`/audit-logs` 与 `/export` 增 `trace_id/request_id/family_id/category/event` 过滤（Prisma/Memory 存储同语义），**过滤参数白名单外一律 400**（不静默忽略）；CSV 列同步扩展（mock 逐字节同构）；前端 AuditQuery 类型三副本同步。
- **新 ADR**：ADR-0025 修订（逐族落地表 + 两类改判证据 + 豁免清单登记）、**ADR-0026**（可观测 ID 分层与贯穿：双 ID 语义/ALS 扩展/jti 可记安全论证/指标段与基数护栏/审计检索键）。文档同步：`docs/40`（§1.3 信封 requestId + §1.4 X-Request-Id + 审计过滤 + 变更记录）、`docs/60` §3（四新配置键）、`.env.example` ×2、`docs/adr/README`。**回归**：logger **25/25**（新增 identity 5 条）、core **29/29**（新增 trace-request-id 6 条 + error-contract 5 条）、auth **224/224**（新增 auth-metrics 4 条 + audit-no-secrets 1 条 + audit-query-filters 3 条）、cache **149/149**、transport **93/93**、queue **156/156**、db **83/83**、config-center **54/54**、tenant **34/34**、storage **45/45**、telemetry **53/53**、example-api **113/113**（新增 observability-chain 集成 1 条）、admin-web/vue-tsc/build + smoke-mock、smoke-template-admin 全过；门禁 7 项全绿（headers / no-raw-sql / **no-raw-throw** / api-parity / triway-七轴 / helm）。
- **Changed（9001 → 精确码的行为修正，OBS-02 预期内）**：租户迁移「隔离级别已被并发修改」「租户已被移除」由 `9001/500` 改为 **`1004`（STATE_NOT_ALLOWED）**；传输/驱动类错误（缺依赖、超时、地址非法等）由 `9001/500` 改为码表精确码（`9002/503`、`1001/400` 等）——前端按码分支与告警规则自此可消费精确语义。

### Fixed（@fw/cache 缺陷清单 A 系列收口 + 跨驱动契约测试基建，2026-10-17）

- **A 系列 5 项修复 + 双驱动共享契约测试**（承接上批 C-01~C-06，落地工作区《Vitest 回归测试设计》§5/§8/§9/§10）。① **A-01 跨驱动类型语义对齐**：memory 驱动 get/smembers/sadd/compareAndDelete/compareAndExpire 遇不符类型条目改为**显式抛错**（对齐 Redis WRONGTYPE，此前静默替换/返回空会吞掉调用方键命名错误），mget 对集合键返回 undefined（对齐 MGET nil 永不出错），sadd 空成员不再创建幽灵集合条目（对齐 SADD 无操作）；`FakeRedisClient` 同步建模 WRONGTYPE（get/smembers/sadd/Lua 条件操作）与 SET 任意类型覆盖、EXISTS 任意类型可用；新增 **`store-contract.test.ts`**——同一组断言工厂对 memory 与 redis(fake) 两驱动运行（读写/TTL/集合/条件操作/WRONGTYPE/原子标签方法 11 组契约）。② **A-02 限流异常策略**：`take()` 对存储返回的 `TokenBucketTakeResult` 做**运行时形状校验**（缺 allowed/类型不符/非有限数值按存储故障走 fail-open/fail-closed，不再可能被误判；`retryAfterMs=-1` 哨兵语义保留）；`RateLimitMiddleware` 决策链路意外异常**不再无条件 `next()` 放行**——记录 error 日志后遵循 limiter 的 failOpen（fail-closed 以 BizError 9002 经 `next(error)` 交全局异常过滤器，与统一异常面同源）。③ **A-03 配置校验**：`updateRuntimeOptions` 入口校验（TTL/lockTtl 正数、jitter ∈ [0,1]、slowMs ≥ 0，非法热更 fail-fast）；调用级 `ttlSeconds`/`nullTtlSeconds`/`expire`/`lock` TTL 校验（此前 `ttlMs()` 用 `Math.max(1,·)` 把非法值钳到 1ms 静默写入）；`mset` **非事务契约显式化**（逐键写入、中途失败可能留下部分键，CacheService 与 docs/contracts/cache.ts 双登记）。④ **A-05**：redis `size()` 注释明确 redis-cluster 下 DBSIZE 为单节点近似值，禁止业务判定。⑤ **A-07**：memory 令牌桶冷桶清理的内存上界口径登记（`bucketSweepAt × 单桶体积`，不保证实时清理，硬上限依赖部署层告警）。⑥ **C-06 补充（设计 §8.1）**：函数参数改按函数源码区分（不同函数不再仅因类型相同就同键），循环引用编码与占位字符串可区分。**回归**：cache **149/149**（净增 43 条：store-contract 双驱动 22 条 + 限流非法结构/中间件兜底 3 条 + 配置边界 11 条 + 锁 renew 令牌隔离/看门狗停表 2 条 + key 函数区分等）、`tsc --noEmit` 0、build 0。**范围边界**：真实 Redis 单实例集成与双进程分布式锁验证（设计 §9.4）待 CI 挂服务后接入；`check:headers` 本轮报 `apps/admin-web/utils/trace.ts` 与模板 `biz-error.ts` 2 处缺失文件头——非本批改动（并行会话在途文件），未处理。

### Fixed（@fw/cache 缺陷清单复核修复 8 项：C-01~C-06 / A-04 / A-06，2026-10-17）

- **《Cache缺陷清单》独立复核后批量修复**（复核报告见工作区 `Cache缺陷清单-复核报告.md`，13 项中 11 项属实）。① **C-01/C-03/A-04 标签原子协议**：`CacheStorePort` 新增 `setWithTags`（写值 + SADD 标签登记单次原子，消除「值已写入、标签未登记」半程状态）与 `invalidateByTag`（SMEMBERS → DEL 成员 → DEL 索引单次原子，与写路径全序串行后不再产生「键存在但索引已丢」的孤儿；故障时**整体未发生**——修复前 fail-open 下 `smembers` 失败被当作「没有成员」仍清理索引，留下不可失效的残留数据，且实际触发条件是默认的 `CACHE_FAIL_OPEN=true` 而非清单标题所写的 false）；memory 驱动单同步块天然原子，redis 驱动新增 `SET_TAGS_LUA` / `INVALIDATE_TAG_LUA`（**已知限制：redis-cluster 跨 slot 多键脚本不可用，已在端口与驱动登记**）；`setRaw` 带标签与 `invalidateTag` 切换至新端口方法。② **C-02 锁释放语义**：`release` 改由**共享持有记录的深度**决定（原实现按句柄创建时的 `reentrant` 布尔值判断——普通获取句柄先释放会连重入方一起释放整把锁，且此后重入句柄的 release 永远静默失败），并明确 release 幂等（重复释放返回 false）。③ **C-04 看门狗**：周期改 `max(50ms, TTL/3)` 与 TTL 成比例（原 `max(1000, …)` 在 TTL<1s 时首次续期晚于锁过期），TTL<1s 告警；`LockOptions` 新增 `onLost` 回调（续期失败/异常停表后触发，失锁可感知）。④ **C-05 redis close()**：超时分支真正触发 `disconnect()`（原实现超时仅 resolve，与注释「超时即强制断开」不符），并对 `quit()` 挂接兜底 catch 防 unhandled rejection。⑤ **C-06 参数哈希升级**：`stableHash` 32 位 FNV-1a → **SHA-256**（64 hex），序列化改**类型可区分的规范化编码**（原 JSON.stringify 产生 `[undefined]≡[null]`、`{a:undefined}≡{}`、`NaN/Infinity≡null` 确定性碰撞；新增 Set/Map/Date/RegExp 专属编码）；装饰器默认键与旧缓存条目一次性失效（等 TTL 过期，无脏读）。⑥ **A-06 限流构造校验**：`RateLimitLimiter` 构造期校验 capacity（≥1 整数）/ refillPerSecond（正数），非法配置装配期 fail-fast（`CONFIG_INVALID_VALUE`）。契约同步：`docs/contracts/cache.ts`（LockHandle.release 语义冻结 / LockOptions.onLost / invalidateTag 原子语义）；测试桩 `FaultyStore` 补齐 `tokenBucketTake` 并新增 `failWhen` 选择性故障注入，`FakeRedisClient.eval` 支持两条新原子脚本。**回归**：cache **106/106**（新增 19 条：C-01 失效×并发写入 60 轮交错无孤儿不变式 / C-02 先释放普通句柄不提前放锁 + release 幂等 / C-03 fail-open 与 fail-closed 失效失败不销毁索引 / C-04 短 TTL 看门狗先于过期续期 + onLost / C-05 quit 挂起超时强制断开 + 正常完成不触发 / C-06 历史碰撞对全可区分 + Set/Map/Date 编码 / A-04 带标签写入走原子端口 / A-06 构造期校验）、`tsc --noEmit` 0、`check:headers` 619 文件通过（顺带修复 `check-triway-consistency.mjs` 文件头超 30 行扫描窗的既有阻塞）。**范围边界**：A-01（跨驱动 WRONGTYPE 差异）/ A-02（限流中间件兜底放行策略）/ A-03（updateRuntimeOptions 校验）/ A-05（cluster dbsize 运行时语义）/ A-07（冷桶清理上限）待与跨驱动契约测试基建合并处理；queue 包回归在途。

### Added（M12 W1 · 统一审计事件契约与 replay 链路修复，ADR-0025）

- **PRD-012 W1 首批交付（OBS-04/05/06/07，详见 [PRD-012 变更记录](./docs/prd/prd-012-observability-error-contract.md)）**。① **统一审计事件契约（OBS-06）**：`@fw/auth` `AuditLogRecord`/`AuditEntry` 增 `category`/`event`/`result`/`familyId`/`jti`/`requestId` 六字段（必填 nullable，`AuditService.persist` **字段全量落位**，序列化形状不随调用方漂移）；`audit_logs` + `audit_log_archives` 同构软增列 6 列，migration `20261017110000_add_audit_event_contract` **三方言 + admin 模板**同构（example-api SQLite / PG 变体 / MySQL init / 模板 SQLite），新增索引 `idx_audit_event` / `idx_audit_family` / `idx_audit_request` / `idx_audit_category_created`（归档表 `idx_audit_archive_*`）；存储映射同步 `PrismaAuthStore`（example-api + 模板）/ `PrismaAuditArchiveStore` / admin-store ×2；web 侧审计类型三副本（`docs/contracts/api-web.ts` / admin-web / 模板）同源补字段，mock 种子补齐（即时构造行可缺省）。② **replay 安全事件九要素（OBS-07）**：`RefreshTokenService.handleReplay()` 审计行走统一契约——`category='security'` + `event='refresh.replay_detected'` + `result='denied'` + `familyId` + `jti`（从复用方令牌解出），**`traceId` 改取 `getTraceId()`（修复此前硬编码 `null` 的「HTTP→Auth→Audit」唯一断链点）**，**全部 5 个调用点强制传入 `ip`/`userAgent`（修复主泄漏路径只传 4 参导致 ip/ua 为 null）**；新增 `ReplayReason` 低基数枚举（`not_found`/`no_replacement`/`fingerprint_mismatch`/`grace_expired`/`family_revoked`/`restore_failed`/`replacement_invalid`）进 `afterValue.reason`，人读 `detail` 保留；**rotation 判定语义零改动**（ADR-0020 Rule 8 组件边界不动），落库失败仍降级日志兜底不阻塞主流程。③ **日志错误码一等字段（OBS-05）**：`@fw/logger` `LogRecord` 增顶层 `code?: number`，级别方法增可选 `LogOptions`，`GlobalExceptionFilter` 改传顶层 `code`（不再内嵌 ctx）——日志侧可按错误码检索。④ **契约文档收口（OBS-04）**：`docs/40-api-spec.md` §1.3 `details` 口径修正（实现在**信封顶层**，历史文档误写 `data.details`），前端 `request.ts` 的 `data.details` 兼容分支标注 Deprecated（一个版本后移除）；`docs/contracts/api-web.ts` `ApiEnvelope` 补 `details`。新增 **ADR-0025**（错误三类治理 / 判别符≠错误码 / 审计事件契约与增列 / 九要素口径）+ 数据字典 §3.13/§3.17 增列。**回归**：auth **216/216**（新增 `audit-event-contract.test.ts` 6 条：no_replacement / fingerprint_mismatch / grace_expired / 无上下文 traceId=NULL / 契约字段显式落库 / 旧调用方字段完整为 NULL）、logger **20/20**（新增 `logger.code.test.ts` 3 条）、core **18/18**、example-api **112/112**（含 rotation 集成 11/11 真库）、admin-web **183/183** + `vue-tsc` 0 + build 0 错误 + smoke-mock **140/140**、smoke-template-admin 全过（含模板 SQLite 应用新迁移）。**范围边界**：AC-OBS-07 未勾（九要素中 `request_id` 待 OBS-09/W2 填充）；OBS-01/02/03/08（错误族收敛 / 禁裸抛门禁 / 码表单一来源 / 契约测试扩展）待后续批次。

### Added（工程门禁：三方一致性对撞，2026-10-17）

- **新增强制 CI 门禁 `check:triway-consistency`**（`scripts/check-triway-consistency.mjs`，CI base 作业阻断合并）：把「框架包实现、example-api 实现、admin 模板生成结果」三份同源实现拉平六轴对撞——① **路由面·生成结果自洽**：模板 admin-web 调用面 ⊆ 模板后端路由面（含按模块装配判定的框架包控制器，未装配不计入）；② **路由面·模板是参考实现的裁剪子集**：模板路由面 ⊆ example-api 路由面；③ **权限码三方闭环**：框架 `PERM`（37 码，含 `@fw/queue` 的 `QUEUE_PERM_*`）为唯一权威——模板前端使用的码 ⊆ 模板种子声明 ∪ 框架码、模板种子声明的应用码 ⊆ example-api 种子声明 ∪ 框架码（模板不发明新码）、两侧控制器 `@Permissions` 的码 ≤ 本侧种子声明 ∪ 框架码（守卫一个种不出的码 = 端点永久 3002）；④ **Prisma 共有模型字段一致**（14 个共有模型逐一比对，`@fw/auth` Store 契约变化必须同步模板，`@map` 列名映射差异豁免、索引/表名差异仅提示）；⑤ **框架依赖面**：模板 `@fw/*` 依赖必须存在且为 `workspace:*`、源码 import 必须已声明；⑥ **配置键面**：模板 `.env.example` 键 ⊆ `ENV_KEY_PATHS`（99 键）∩ example-api `.env.example`（97 键），example-api 侧反向 ⊆ 注册表。**首跑即抓出 4 处真实漂移**（模板前端调用模板后端未注册的端点，接入生成项目即 404）：登录页 `GET /auth/oauth2/providers`（模板服务端未接入 OAuth2）、`web-limits` store 的 `GET/PUT /configs`（模板未接入配置中心，每次布局挂载打必败请求）、`api/audit.ts` 的 `GET /audit-logs/export`（死代码）。按模板裁剪范围修复：移除登录页 OAuth2 入口与 `utils/oauth2.ts`、删除 `api/config.ts` 与 `store/web-limits.ts`（AppMain 的 keep-alive 上限改回常量 12）、`api/audit.ts` 移除导出函数；修剪后模板 admin-web 经 vue-tsc 全量类型检查通过。**反向验证**：逐轴注入突变（模板独立路由 / 发明权限码 / 前端用未声明码 / schema 加字段 / 依赖规格非 workspace / 未登记配置键）6/6 全部被拦截。同步重构 `scripts/check-api-parity.mjs` 与新旧门禁共用 `scripts/lib/api-parity-core.mjs`（同一条路径两个门禁算出同一个键），并修复既有盲区：`@Controller()` 空前缀控制器（health/ready/metrics）此前完全不进路由面、`@Get(CONST)` 常量路径落入「无法静态解析」。文档同步：README 门禁清单与目录树、`docs/70` §1.6.8 对撞类门禁、`docs/40` §6。

### Added（文档：PRD-012 统一可观测契约与运维暴露，2026-10-17）

- **PRD-012 立项（M12，草案）**：新增 [docs/prd/prd-012-observability-error-contract.md](./docs/prd/prd-012-observability-error-contract.md)——按「**M12.2 统一 Error/Audit Contract → M12.1 Observability 贯穿 → M12.3 Maintenance/Health 暴露**」的依赖顺序合并为一个交付单元，分 W1/W2/W3 三波独立验收，共 **19 项需求 OBS-01~OBS-19 + 19 条 AC**（每项含反向验证）。立论：三件横切基础设施仍是「机制在、契约不在」——① **错误面**：`@fw/core BizError` 与集中码表早已存在，但框架内并存 6+ 套平行错误族（`TransportError`/`TelemetryUnavailableError`/`TelemetryConfigError`/`PermanentJobError`/`JobTimeoutError`/`TokenVerifyError`/`ConfigValidationError`）各自继承裸 `Error`，生产代码仍有大量 `throw new Error()` 被 `GlobalExceptionFilter` 降级为 `9001`（如 `tenant-admin.controller.ts` 并发冲突应为 `1004`、`key-ring.ts` 配置校验应为 `5002`），码表三份人肉同源副本（core `ErrorCode` / 前端 `BIZ_CODE` / mock `CODE`），且 `docs/40-api-spec.md` 称 `details` 在 `data.details` 而实现/前端实际在**信封顶层**；② **观测面**：日志 `LogRecord` 只有 `tenantId` 而**不输出 `userId`**，`familyId`/`jti` 只活在 `request.user` 内存对象从未进 ALS，`handleReplay()` 写审计时 `traceId` **硬编码 `null`**（绕过 `AuditService.persist` 自动取值，是「HTTP→Auth→Audit 一条链」唯一断点）且主泄漏路径（`refresh-token.service.ts:185` 只传 4 参）丢 `ip`/`ua`，`/metrics` 无 `fw_auth_*`/`fw_security_*` 段；③ **暴露面**：`/api/v1/auth-maintenance/*` 类级 `@Public` 放行、无权限码/运维 token/IP 白名单，部署层 Nginx 三份配置内网白名单**只覆盖 `/health|/ready|/metrics`** → maintenance **公网可达**，且三条路由仅 `key-ring` 有 `no-store`。**关键设计**：ADR-0025（错误三类治理：①对外业务族继承 `BizError`／②内部信号类保留但禁上浮／③基础设施 fail-fast；判别符「≠」错误码；`AuditEvent` 契约 + `audit_logs` 软增列 6 列 `category`/`event`/`result`/`family_id`/`jti`/`request_id`，归档表同构）/ ADR-0026（`requestId` per-request 与 `traceId` 跨服务分层，ALS 上下文扩展，logger 自动输出身份）/ ADR-0027（运维端点三层边界：Public 自检 / Protected maintenance / 内部诊断，**默认受保护、公开需显式白名单+理由+契约测试**）。新增门禁 `check-no-raw-throw`、新增文档 `docs/45-observability-contract.md` + `docs/46-ops-endpoints.md`、预估新增配置键 ~6。**范围边界（如实登记）**：本文档为**草案**，全部 AC 未勾选、无任何代码交付；**零新增错误码**（运维鉴权复用 `3002`）；明确不做 6 条（NG12-1 不改错误类名、NG12-2 错误码段位重排/数字码改字符串码、NG12-3 不引 `prom-client`、NG12-4 不自建 APM、NG12-5 `requestId` 不做跨服务透传、NG12-6 不动 M11.1 rotation 核心与 ADR-0023/0024 冻结项）；与 PRD-011 S-33~S-37 的观测面**命名规范共用**（`fw_<域>_<指标>_<单位>`），分工见 §9 末。PRD 索引已同步 [docs/prd/README.md](./docs/prd/README.md)。

### Added（M11.5 · Key Ring 可观测性，ADR-0024）

- **ADR-0024 落地**：[docs/adr/0024-key-observability.md](./docs/adr/0024-key-observability.md)——兑现 ADR-0023 决策 4 冻结项。核心：① **稳定 kid**：`'jwt-' + sha256(secret)[0:16]`（64 bit，同 secret 跨部署/实例/重启稳定；同 Ring 内 kid collision 启动即失败；sign 全量携带）；② **verify kid 四分支路由**：absent / legacy 角色标识（jwt-current/jwt-prev）→ dual-try 兼容、known stable kid → 精确单 key、**unknown kid → 直接拒绝不尝试任何 Ring key**（测试锁死：current 可验但 kid=unknown 的 token 必须 reject）；③ **Key Ring 运维端点** `GET /api/v1/auth-maintenance/key-ring`（沿 @Public 自检先例 + `Cache-Control: no-store`）：JWT Ring 稳定 kid + Replacement Ring 各 keyId 的 activeReplacementCipherCount 与 **retirable 判据**（基于「仍存在可恢复密文」计数，cipher 已清空的历史行不计入），source 枚举化（KeySource 四值）；`AuthStore.countReplacementCiphersByKeyId` 三实现；④ 安全事件审计口径文档化（action=security 复用既有审计面）。**不做**：rotation 核心/grace 状态机零改动（红线）、无前端新页面、无轮换自动化、无 KMS。回归：auth **210/210**（含 L8 9 条）、example-api **108/108**、config 16/16。**M11 系列五个阶段全部完成**。

### Added（M11.4 · 双 Key Ring，ADR-0023）

- **ADR-0023 落地**：[docs/adr/0023-key-ring.md](./docs/adr/0023-key-ring.md)——解 ADR-0020 登记的 JWT_SECRET 轮换误杀 prerequisite。核心：① 统一 KeyRing 抽象（`key-ring.ts`：ReplacementKeyRing + JwtKeyRing，密钥材料仍封 TokenService，rotation 核心零改动）；② **Rule 6 路由优先级**（禁全 Ring brute-force）：显式命中仅试该 key 失败即 fail closed / legacy `replacement-v1` 且 Ring 不含 → HKDF(current)→HKDF(prev) 回退链 / 未知 keyId fail closed；③ 新配置键 `AUTH_REPLACEMENT_KEYS`（`<keyId>:<secret>` 列表，解析规则冻结：keyId 禁 `:`/`|`、secret 禁 `|` 且 ≥32 UTF-8 bytes、空 entry/重复 keyId 启动即失败；Ring 密钥经 HKDF 派生到 32 字节）；④ **代际回退验收**：轮换部署（OLD→NEW+PREV）下 legacy 密文 grace 内恢复原 B 不触发族撤销（真库用例 + 跨代显式 Ring 场景），反向回退全失败仍 fail closed；⑤ JWT kid：sign 带 `jwt-current`（角色路由标识，稳定 kid 留 M11.5），verify kid 路由 + 无 kid 存量双试兼容；⑥ 退役窗口规则文档化（retire ≥ max(grace, 调度周期)+重叠期，判据 = keyId 名下未过期 cipher 行数为 0，M11.2 清理衔接）。红线验证：rotation 核心（baseline/L5/L6/集成 spec/CAS 收敛事务体）零改动全绿。回归：auth **199/199**（含 L7 17 条）、example-api **108/108**、config 16/16。

### Added（M11.3 · Client Fingerprint，ADR-0022）

- **ADR-0022 落地**：[docs/adr/0022-client-fingerprint.md](./docs/adr/0022-client-fingerprint.md)——grace 重试绑定轮换赢家指纹：**同客户端 → 返回同一个 B；异客户端 → replay 安全事件**（Rule 8 全链：族撤销 + 会话撤销 + audit `security` 事件 + 3001；M11.1 时仅 logger，本次补审计落库）。指纹 = `SHA-256(normalizeUserAgent(ua))`，**IP 不参与**（漂移误杀）；`normalizeUserAgent` 规则冻结（仅 trim，null→""，固定测试向量进 ADR）。**原子性**：赢家指纹由 CAS 同一 UPDATE 写入 `rotated_fingerprint` 新列（禁止二次补写）；**NULL 放行仅限 M11.1 存量行与 `AUTH_FINGERPRINT=off`**，新 rotation 产生 NULL 即缺陷（契约测试锁死）。新增配置键 `AUTH_FINGERPRINT`（on/off，默认 on，已登记 env-schema + ENV_KEY_PATHS + .env.example + docs/60）；`refresh_tokens` 加列 `rotated_fingerprint`，migration `20261016193000` 三方言 + 模板同构（mysql 变体重生成 init）。**baseline-009 翻转**：异客户端 grace 重试从 observation 改为断言拒绝（ADR-0020 预告项兑现）。L6 指纹测试层 8 条（向量/匹配/不匹配+审计/存量 NULL/off 模式/IP 漂移/全链撤销）。回归：auth **182/182**、example-api **106/106**。

### Added（M11.2 · Refresh Token 生命周期完整性，ADR-0021）

- **ADR-0021 落地**：[docs/adr/0021-refresh-token-lifecycle.md](./docs/adr/0021-refresh-token-lifecycle.md)——replacement 密文可恢复期从「最长 ≈37 天」收缩到 **grace 窗口 + 一个调度周期**。核心：`AuthStore.clearExpiredReplacementCiphers(now)`（判据 = `replacement_expires_at < now` 唯一化，脏数据同样回收；`NOT(三列全 NULL)` 仅保证幂等；只置三列 NULL 保留 `revokedAt/replacedById` 历史链）；`auth.refresh-cleanup` cron 扩展为**两级清理**（密文回收每次跑 + 30 天删行），快照/运维端点加 `lastCiphersCleared`/`lastDurationMs`；`cleanupReplacements()` 为编排门面（清库动作在 Store，Rule 8）。**Replacement metadata invariant**：三列全 NULL 或全 NON-NULL（契约测试锁死，M11.4 Key Ring 数据基础）；清空后 A 复用 → `no_replacement` → 泄漏族撤销（fail closed 与 M11.1 一致）。L5 生命周期回归 8 条：A→B→C→D 全链 / 中途 logout / logout-all / 孤儿 replacement / 清空后语义 / 清理不碰 B / 幂等 / 三列一致性。不新增任何状态枚举（全部派生状态）。回归：auth **173/173**、example-api **104/104**。

### Added（M11.1 · Refresh Token Rotation CAS，Commit 1）

- **ADR-0020 立项并落地 Commit 1（Memory 侧垂直切片）**：[docs/adr/0020-refresh-token-rotation-cas.md](./docs/adr/0020-refresh-token-rotation-cas.md)——M11.0a baseline（5 failed 实测）钉死的「N × A ⇒ N × replacement」并发 race 修为存储层 CAS 三态裁决（`rotated / already_rotated / replay_detected`）：grace 内重试解密返回**同一个**已持久化 replacement（AES-256-GCM 密文存于 A 行，HKDF 从 JWT_SECRET 域分离派生密钥，明文永不落库），grace 外/族死/B 已失效一律 fail closed（族撤销 + 3001），Security Invariant 禁止从已轮换的 A 再生成第二个 replacement。含 8 条锁死规则 + 时间基准（单次 rotation 单一 `now`）+ DoD 清单（编号 0017–0019 已由 PRD-011 预留故跳号）。`AuthStore` 新增 `rotateRefreshToken?`（Commit 2 定稿必选，Prisma 实现前服务层走 legacy 兼容路径）；`RefreshTokenRecord` 扩 4 列（`replacedById / replacementCipher / replacementKeyId / replacementExpiresAt`，schema/migration 随 Commit 2）。基线测试 `refresh-token.m11-0a-baseline.test.ts` **10/10 全绿**（5 failed → 10 passed，断言零改动）；TC-AUTH-008 断言按新语义翻转（宽限复用返回同 token）；auth 155/155、example-api 97/97。
- **M11.1 Commit 2（Prisma 侧，ADR-0020 收口）**：`refresh_tokens` 加 4 列（`replaced_by_id / replacement_cipher / replacement_key_id / replacement_expires_at`，全 nullable 保旧代码兼容，回滚 = 旧版本直接跑新库）+ `idx_rt_replaced_by` 索引；migration `20261016140000_add_refresh_replacement` 三份同构（example-api SQLite / example-api PG 变体 / admin 模板 SQLite）。`PrismaAuthStore.rotateRefreshToken`（example-api + 模板双份）：交互式事务内 CAS `updateMany`（谓词含未撤销+未软删+未过期，ADR-0020 Rule 2）+ 插入 B + 回填 `replacedById` 原子提交；CAS 失败抛哨兵回滚后**事务外**判定性重读（Rule 4，MySQL REPEATABLE READ 快照陷阱防呆）。`AuthStore.rotateRefreshToken` 转必选方法，服务层 legacy 路径已删除。SQLite 端到端实测 5/5：rotated 语义/并发 10 ⇒ exactly 1 replacement/族死 fail closed/grace 过期 replay/DB 无明文（`token_hash` 保持 hash-only、密文 5 段格式）。
- **M11.1 Commit 3（L2/L3/L4 测试分层落地，ADR-0020 DoD 本地项全勾）**：L2 内存并发回归（`packages/auth/__tests__/refresh-token.m11-concurrency.test.ts`，2/10/100 并发 exactly 1 + grace 重试同一 B）；L4 故障注入（`refresh-token.m11-fault.test.ts`，Case B–F：密文损坏/keyId 失配/grace 过期/B 已消费后 A replay 全部 fail closed 族撤销、A 过期仅拒绝 3003 无副作用；注入点在 store↔service 边界模拟位腐与密钥失配）；L3 Prisma 真库集成（`apps/example-api/src/modules/auth/refresh-rotation.integration.spec.ts`，独立临时 SQLite + beforeAll migrate deploy：存储层 CAS 三态 + **Case A 唯一约束注入 INSERT B 失败 ⇒ 事务回滚 A 保持 active 可重新轮换** + 服务层 10 并发 exactly 1 + Case C 直接改库模拟位腐 + Case E）。配套：`@fw/db` `PrismaClientLike.$transaction` 选项补 `maxWait/timeout`（Prisma 交互式事务 2s/5s 默认在 SQLite 单写者排队场景不足，store 显式放宽 5s/15s）；SQLite 本地并发容量实测稳定上限 10（exactly-100 归 CI MySQL/PG 矩阵）。DoD 15/16 项已勾，剩 PostgreSQL/MySQL 集成、双实例、CI green 三项待推送后 CI 验证。全量回归：auth **164/164**、db 83+12skip、example-api **104/104**。
- **M11.1 收口（CI 真库矩阵 + 双实例 + 独立小修）**：① 修复 `issue()` 返回 jti 与 JWT 载荷内 jti 背离（bf2055d，本地另生成未传入 signRefresh；生产路径未消费该字段，属潜伏不一致，补回归断言）；② rotation 集成 spec 参数化（`ROTATION_TEST_DB_URL` 直连 service DB）并挂进 CI 集成矩阵 MySQL/PG 腿（e68c530/a4b7c3e）——新增 example-api **MySQL 方言变体 schema**（`prisma/mysql/`，单条 init migration 由 migrate diff 生成；`replacement_cipher` 须 `@db.Text`：MySQL String 默认 VARCHAR(191) 装不下真实密文）；rotation 独立库 `fw_rotation` 与 packages/db 矩阵库隔离（避免 migrate deploy P3005）；③ **双实例 CAS 脚本**（`scripts/dual-instance-rotation.mjs`）：2 个独立 Node 进程（各自 PrismaClient/service 实例，进程间唯一共享状态 = 数据库）× 50 并发打同一 MySQL/PG ⇒ **exactly 1 replacement**。**CI run 38866505347：4/4 job 全绿，ADR-0020 DoD 全项达成（M11.1 完成）**。

### Fixed（文档：ADR-0020 Rule 8 组件归属澄清，2026-10-16）

- **ADR-0020 Rule 8 组件归属澄清（纯文档，零代码改动）**：原表述「replay 副作用由 **TokenService（RefreshTokenService）** 编排」把编排者误记为 `TokenService`——实际编排者是 `RefreshTokenService.handleReplay()`。修正后 Rule 8 = 「副作用由 `RefreshTokenService` 编排；`TokenService` 不参与编排，仅负责 JWT 签发/验签与 replacement 加解密；`AuthStore` 只做持久化 + CAS + 事实返回」。新增 [docs/adr/0020](./docs/adr/0020-refresh-token-rotation-cas.md)「**组件职责边界（Rule 8 精确化）**」小节（三组件职责树 + 源码文件锚点）与「对方案原文的**四点**修正」第 4 条（登记 `M11(PRD1-10善后).txt` 原文 Rule 8 的组件名偏差）。**顺带澄清一处笔误级问题**：SHA-256 令牌哈希（`hashToken`）在 `RefreshTokenService`，**不在** `TokenService`（后者内出现的 SHA 仅为 HKDF 密钥派生）。同步更新接口契约段与 DoD 末项表述。意义：为 M11.4 Key Ring 定死切口——只替换 `TokenService` 的密钥来源（多 `keyId` + 双生命周期），`RefreshTokenService` / `AuthStore` 契约零改动（`keyId` 已是 `already_rotated` 结果字段）。**方案笔记同源勘误**：工作区两份方案原文 `M11(PRD1-10善后).txt` 与 `M1-10善后.txt`（内容一致，`cmp` 校验 SAME，均未入库）**正文保留不改**，各插入 6 处勘误注记——头部全局勘误声明 + §三 TokenService 职责树 + §十六 标题与末句 + M11.1-03 + 文末 Rule 8 英文 Errata——零信息损失地纠正组件名与 SHA-256 归属（17590 → 21738 字节）。


### 评审登记（M11.1 · ADR-0020 增补，2026-10-16）

- **JWT Secret 轮换窗口登记为 M11.4 prerequisite（HKDF 方案不推翻）**：[ADR-0020](./docs/adr/0020-refresh-token-rotation-cas.md)「加密方案 / 已知留白」增补——replacement 密钥只从当前 `jwtSecret` HKDF 派生，`decryptReplacement` 无回退路径且 `keyId` 恒为 `replacement-v1` 不标识代际（JWT 验签侧的 `JWT_SECRET_PREV` 双密钥回退不覆盖 replacement 解密，`token.service.ts` 实现核对无误）。轮换部署（`JWT_SECRET=NEW` + `JWT_SECRET_PREV=OLD`）后，旧实例写入的密文在新实例解密必失败 → 按 Security Invariant fail closed 触发族撤销 → **误杀合法并发 retry**（A→B 跨部署代际 + grace 重试重叠的极端窗口）。处置：M11.1 **不为此返工**，登记为 **M11.4 Key Ring prerequisite**——双来源回退解密 + 密文 version/keyId 携带代际 + 退役条件覆盖 `max(grace, 轮换重叠期)`；验收判据 = 双 secret 部署下旧密文 grace 内可恢复且不触发族撤销（反向验证：无回退时 fail closed 仍然成立）。**顺带勘误**：ADR「加密方案」HKDF salt 原写作 `fw/replacement/v1`，实现 `token.service.ts` 实际为 `fw/auth/replacement/v1`，本次一并更正（以实现为准）。
- **grace 不做 fingerprint 维持（RFC 9700 依据补入《M11.1 最终修改方案》十四）**：refresh token rotation 本身即 RFC 9700（OAuth 2.0 Security BCP）官方认可的 replay detection 机制——旧 refresh token 被再次使用 ⇒ 判定授权可能已泄漏 ⇒ 撤销活跃 refresh token；「检测 + 撤销」闭环由 M11.1 的 CAS + family revoke 成立，fingerprint（deviceId / clientId / IP / UA）只是降低误报的增强信号而非检测前提。结论：M11.1 不为 fingerprint 扩大范围（grace 内「持 A 即可得 B」的显式取舍不变，baseline-009 冻结现状），仍归 M11.3，引入后翻转为拒绝。

## [0.5.5] - 2026-10-16

### Added（文档：PRD-011 SaaS 运营能力与生态扩展，2026-10-17）

- **PRD-011 立项（M11，草案）**：新增 [docs/prd/prd-011-saas-operations-and-ecosystem.md](./docs/prd/prd-011-saas-operations-and-ecosystem.md)——以「**产品能不能被运营**」的新视角复核 M1–M10 现状，识别四类结构性缺口（**U-1 多租户不运营**：`tenants` 有 `plan`/`status`/`expireAt` 三列但无套餐表、无配额、无用量、无计费、无生命周期动作、无运营后台；**U-2 模板不可扩展**：templates 仅仓库内静态资产，无清单/版本/远程源/插件概念；**U-3 驱动面窄**：五类端口合计 16 驱动，企业内网主流选项缺失；**U-4 工程化欠账**：生成器无 dry-run、观测无标准指标集与告警规则、无密钥托管、无 devcontainer、根 `turbo run` 与 Prisma engine 两项工程债未清），据此提出九大方向共 **48 项功能需求 S-01~S-48**，分 P0–P3 四阶段排期：
> **P0（v0.6.0）** 方向 1 多租户 SaaS 运营（S-01 套餐订阅 / S-02 配额定义与执行 / S-03 用量采集与聚合 / S-04 生命周期五态状态机 / S-05 计费与账单 / S-06 运营后台 / S-07 资源监控与告警）+ 方向 4 通知渠道最小集（S-19 渠道抽象统一派发 / S-20 渠道配置加密 / S-22 发送记录与失败重试）+ 方向 9 效率前置（S-43 devcontainer / S-44 根 turbo 修复 / S-45 Prisma engine 跨平台）；
> **P1（v0.7.0）** 方向 2 插件与模板市场（S-08 清单格式 / S-09 内置索引化 / S-10 远程源与版本解析 / S-11 注册与生命周期 / S-12 依赖与冲突检测 / S-13 一键安装与回滚）+ 方向 5 生成器增强（S-23 关系推导 / S-24 前端页面 / S-25 权限 / S-26 i18n / S-27 测试 / S-28 自定义模板+dry-run/diff/回滚+三方合并升级）+ 方向 8 安全合规（S-38 真机 IdP 实测 / S-39 API Key 轮换 / S-40 `SecretPort` 密钥托管 / S-41 RBAC 细化含自定义数据范围与角色继承 / S-42 合规导出）+ 方向 3 第一批（S-14 配置中心 Apollo/Consul/etcd、S-17 存储 OSS/COS/MinIO、S-18 认证 LDAP/OIDC/企业微信/钉钉）；
> **P2（v0.8.0）** 方向 6 微服务拆分（S-29 transport 远程化 / S-30 服务发现与负载均衡 / S-31 链路贯通 / S-32 分布式事务边界与 Outbox 示例）+ 方向 3 第二批（S-15 缓存 Cluster/KeyDB/Dragonfly、S-16 队列 Kafka/RabbitMQ/NATS）+ 方向 7 可观测告警（S-33 标准指标集 / S-34 Grafana 面板与告警规则 / S-35 日志聚合 / S-36 OTel 采样策略 / S-37 RUM 多实例聚合）；
> **P3** 方向 9 剩余（S-46 文档教程体系 / S-47 最佳实践与反模式 / S-48 视频教程）。
> 关键设计含 ADR-0017（计费与配额模型：额度与用量分离使校验 O(1)、超限同步 4029、订阅历史追加、出账幂等靠唯一约束、**不接支付**）/ ADR-0018（插件分发：清单唯一契约 + 声明式装配 + 冲突前置检测 + **无任意脚本执行**，与 NG4 划界）/ ADR-0019（生成器指纹与三方合并升级，**绝不自动覆盖用户改动**）；错误码在 `4xxx` 段扩展 `4029`（配额不足，响应带升级指引）/`4030`（租户状态非法流转）/`4031`（租户已冻结），`3xxx` 段新增 `3005`（API Key 已过期）；预估新增表 12 张、配置键 ≥ 33 个。明确不做 7 条（NG11-1 在线支付网关 / NG11-2 运行时插件沙箱 / NG11-6 多云编排 / NG11-7 自建 APM 产品替代 等）。
> **与既有结论的衔接**：81 号规划 §5「Kafka 不排期」（O-5）**改判为 S-16「做，但降档 P2 按需」**——理由是 PRD-011 的语境从「框架自身是否需要」变为「企业落地是否被驱动缺口卡住」（Kafka 为金融/政企高频前置）；改判已在 [81 §5](./docs/81-enhancement-roadmap.md) 与 PRD-011 OQ-1 双向登记，且要求能力对照表与降级口径文档先于实现。NG2/NG4/NG5/NG7 仍成立不失守（「运营后台」是**交付给客户自托管**的控制台，属 NG7 边界内）。PRD 索引已同步 [docs/prd/README.md](./docs/prd/README.md)，并收编原「待规划」中的开放平台网关（API Key + 配额 → S-39 + S-01~S-03），CMS 模板仍待规划。
> **范围边界（如实登记）**：本文档为**草案**，全部 AC 未勾选、无任何代码交付；48 项中多数为环境依赖项（LDAP / 企业微信 / Kafka / K8s 集群），本机沙箱不具备，按「到位即做 + AC 登记未执行与可复现命令」纪律推进；版本映射（v0.6.0–v0.8.0）为建议值，见 OQ-8。

### Fixed（驱动审查修复：@fw/auth · @fw/cache · @fw/queue 内存/Redis 驱动 26 项，2026-10-16）

- **驱动审查批量修复（P0 崩溃/泄漏/连接 5 项 + P1 跨驱动一致性 7 项 + P2 性能/类型/设计 14 项，公开端口方法签名零破坏）**。**P0**：① `MemoryAuthStore.nextId()` 与 `seedXxx` 显式 id 撞号——种子 id 为 `mem-N` 时推进计数器、发号校验全表不重号（此前 seed mem-1 后 createUser 生成 mem-1 **静默覆盖**种子用户）；② `@fw/queue` memory 驱动 `void execute` 吞 rejection——执行链路全量隔离，失败处理（退避/归档/`onDeadLetter` 回调）自身异常记日志不逃逸（unhandled rejection 在 Node 20+ 默认终止进程）；③ `MemoryCacheStore` 令牌桶补齐 TTL 与摊销清理（原注释声称「桶有回满 TTL」未实现——限流 key 无限增长 OOM）；④ `MemoryQueueDriver.close()` 改 await 在途执行 Promise + 独立超时定时器（此前用 `this.now()` 算 deadline，注入假时钟时永不满足 → 死循环）；⑤ cache 集群连接串支持凭据段 `redis://:pwd@host:port`，密码进 `redisOptions.password`（此前 userinfo 被当进 host 解析得到空 host，集群直接连不上）。**P1**：⑥ cache `sadd+pexpire` 合并为单条 Lua（两步间崩溃集合失去 TTL 永久驻留，破坏端口契约；同文件其余操作早已走 Lua）；⑦ memory 令牌桶时钟回拨语义对齐 Redis Lua（仅 `now > last` 才补充并推进 last，回拨不再多补令牌）；⑧ `size()` 端口文档化为**观测近似值**（memory=本进程条目 / redis=DBSIZE 整库，禁止业务判定用）；⑨ memory 队列限速改**每队列**令牌桶（与 bullmq per-Worker limiter 对齐——此前 10 队列共享一个桶，某队列突发饿死其他队列；限速热更重置桶对齐 bullmq 重建消费器的满桶语义）；⑩ 用户建模真实 `createdAt`（种子/创建时刻，列表投影与默认排序 `createdAt desc` 对齐 Prisma——此前恒 null）；⑪ 内存 NULL 排序语义（视为最小）在文件头如实登记为已知差异，不再声称「与 Prisma 一致」；⑫ `retryAfterMs` 在 `capacity < cost`（或 refill ≤ 0）时返回 **-1（永不可满足）**，不再返回误导性的 0；限流器对该配置错误记一次 error 告警。**P2**：⑬ `peek/earliestRunAt` 由 O(N) 全扫改为（队列 × 优先级）分桶最小堆；⑭ cache `Entry` 改判别联合（消除 `as string` 断言）；⑮ `evictIfNeeded` 容量压力下先清过期键再 LRU；⑯ `size()` 过期清理按 1 秒节流（防高频观测调用全量扫描阻塞事件循环）；⑰ queue 两驱动 `applyRuntimeOptions` 构造时浅拷贝 options（不再回写调用方对象，多实例防串扰）；⑱ 移除 `nextSeq()`（全仓无调用方，驱动特有能力破坏端口抽象）；⑲ `listDeadLetters` 排序加归档序 tie-breaker（同毫秒失败翻页稳定）+ payload 深拷贝（视图修改不再污染归档与重放）；⑳ `updateUser` 定义 patch 语义：业务列白名单（对齐 Prisma 可更新列），未知列报错；㉑ `replaceUserRoles/replaceRolePermissions` 校验引用存在（对齐 DB 外键，杜绝悬空引用）；㉒ 移除 MemoryAuthStore 的 `grantRolePermissions` 测试便利方法（与 `replaceRolePermissions` 等价，不该在生产类面）；㉓ cache Redis `close()` 对 `quit()` 加 3 秒超时兜底（挂住即 `disconnect`，不阻塞优雅停机）；㉔ 单实例补 `retryStrategy` 与 Cluster 一致（均 200ms），修正 `maxRetriesPerRequest` 注释与实际行为不符；㉕ `as never`/`as [number,...]` 等断言收敛（eval 结果逐项校验、Cluster options 显式类型）；㉖ Redis `error` 告警日志 5 秒节流（抖动风暴折叠计数输出）。**验证**：`@fw/cache` **91/91**（+6：回拨对齐 / -1 哨兵 / 桶 TTL 回收 / 原子 sadd Lua / 凭据解析）、`@fw/auth` **145/145**（+9：防撞号 / createdAt / 白名单 / 外键校验）、`@fw/queue` **156/156**（+6：每队列限速隔离 / 假时钟停机 / 异常隔离 / 死信深拷贝与 tie-breaker / options 防污染）、三包 `tsc --noEmit` 0 错误、静态门禁 4 项全绿。

### Added（M10 E-09 文件存储端口，2026-10-16）

- **E-09 文件存储端口 `@fw/storage`（PRD-010 P2，带附件的业务 CRUD 不再每项目重写上传）**：① **新框架包 `packages/storage`**——`StoragePort`（put/get/delete/exists/stat/ping/close）+ `StorageModule.forRoot()` 按 **`STORAGE_DRIVER=local|s3`** 装配（沿 cache/queue/transport/config-center 的「端口 + 多驱动 + 枚举切换 + 非法取值启动即失败」范式，s3 桶名缺失亦启动即失败）；**S3 走 optional peer + 结构化最小接口**（`@aws-sdk/client-s3` 懒加载，local 驱动零依赖，未安装启用时启动即失败并给安装命令；导出面不泄漏 SDK 类型——ioredis 先例同款，决策与备选取舍见 [ADR-0016](./docs/adr/0016-storage-port-fw-storage.md)）。② **默认安全**（NFR）：`StorageService` 门面层类型/大小白名单默认收紧（20MB + 11 类扩展名，`STORAGE_MAX_MB`/`STORAGE_ALLOWED_EXTS` 可调），超限/越权类型一律 `400/1001` 不静默截断；存储 key 服务端生成（`<yyyyMM>/<uuid><ext>`）+ 端口 key 卫兵 + local 驱动 resolve 越界最终防线（免疫路径穿越）。③ **端到端落地 example-api**：新表 `upload_files`（迁移 `20261016000000` + pg 变体，数据字典 **§3.19**——内容在存储端口、元数据在库）+ `/api/v1/files` 三端点（api-spec **§3.16**：POST 上传 `file:create` 守卫、GET 元数据与下载登录即可——语义同任务产物下载；下载裸字节流 + RFC 5987 文件名）；新权限点 `PERM.FILE_CREATE`（`file:create`，seed 授予 user，无菜单——上传是表单内嵌能力）。④ **codegen 附件字段识别**：`fw gen crud` 把 `*FileId` / `*AttachmentId` 的 String 字段识别为附件（`isAttachment`，优先级高于外键判定）——前端生成 upload 控件（新组件 `FileUpload`，`FormDialog` 与生成的 `form.vue.tpl` 双接线；上传走 `/api/v1/files`、值存文件 id、附件字段不进列表列与查询条件），后端照常按 string 接收；附件字段约定与无物理外键口径登记于数据字典 §3.19。⑤ **mock 同构（N-02 逐字节纪律）**：`/files` 三端点（multipart 最小解析 + 白名单校验文案与 `@fw/storage` 逐字一致 + 下载逐字节回放）+ `file:create` 权限点与 user 角色授权 + `smoke-mock` 新增 7 断言。⑥ **E-08 模板收编（AC5 承诺兑现）**：`templates/admin/server` upload 模块删除自有 fs 实现，平移为 `@fw/storage` 门面消费（业务接口与端点契约不变），`STORAGE_*` 键替换原 `UPLOAD_DIR`。**配置键 87→97**（10 个 `STORAGE_*` 全部登记 `ENV_KEY_PATHS`，boot 键不入热更白名单）。**验证**：`@fw/storage` **45/45**（local 真实临时目录 + s3 fake 客户端双驱动：逐字节往返 / 404 收敛 / 幂等删除 / 越界防护 / 装配与缺桶启动即失败 / 白名单与 key 约定；覆盖率 86.55/82.6/93.47/87.05 过线）、`@fw/config` 16/16（97 键护栏）、`@fw/cli` **120/120**（附件识别 + form.vue 上传分支）、example-api 构建零错误 + `smoke-mock` **140/140**（新增 7 条：上传信封 / 元数据 / **下载逐字节一致** / 白名单外 400 文案逐字一致 / 未登录 401 / 404 不泄露存在性）、admin-web **183/183** + 构建零错误、`smoke-template-admin` **7/7**（收编后端到端：生成→migrate→seed→登录 + CRUD + **附件上传三端点连通含逐字节下载校验**）、静态门禁 4 项全绿（check:headers 600 文件 / check-no-raw-sql 351 文件 / check:helm 63/63 / check-api-parity 含 `/files` 对撞一致）。**范围边界（如实登记）**：s3 驱动真实对象存储端点（MinIO/AWS）本机无环境未实测——fake 客户端覆盖语义，真实连通性归入 E-05/E-11 环境到位后补测（AC8 同款纪律）；下载为整 Buffer 回放（20MB 上限内），Range/分片流式下载为非目标。

### Added（M10 E-15 暗色模式，2026-10-16）

- **E-15 暗色模式（PRD-010 P3 / AC11，O-4 决策收口；纯前端，零后端改动、零新增配置键）**：① **设计令牌层双列落地**（`apps/admin-web/src/styles/variables.css`）——暗色块按 [25 原型 §2.1](./docs/25-ui-prototype.md)「暗色列」补齐五个语义色（主 / 成功 / 警告 / 危险 / 信息）、文本三级、背景 / 卡片 / 边框，并补齐 `--el-color-*-rgb` 三元组（Element Plus 部分规则以 `rgba(var(--el-color-x-rgb), α)` 取色，只改十六进制会让这些位置对不上）；EP 结构性令牌（页面底色 / 卡片底色 / 浮层底色 / 空填充 / 文本五级）在 `:root` 与 `html.dark` **各写一次**并统一映射到 `--fw-*` 语义令牌（EP 的 `html.dark` 特异性高于 `:root`，只在 `:root` 写会被其覆盖）——「改 `--fw-*` 而 EP 组件不跟随」的两套调色板并存消除。② **主色派生按主题分流（真实缺陷修复）**：原实现两套主题一律向白混色，暗色下浅色系被冲淡（按钮 hover 发白、tag 浅底刺眼）；现改为浅色向白 / 暗色向黑，`dark-2` 各自反向，并同步写 `--el-color-primary-rgb`；**派生档取值按同一混色公式预计算为静态值写进令牌文件**（不用 `color-mix()`：实测 vite 8 / lightningcss 会**静默丢弃**无法静态求值的 `color-mix(in srgb, var(--x) 70%, #fff)` 声明 → 开发态有效、产线回落 Element Plus 默认派生色；改静态值后复验产物逐项命中，并加「令牌文件不得出现 `color-mix(`」护栏断言）；主色预设补暗色值（原型 §2.1 暗色列 `#5B8CFF` / `#36AD6A` / `#F2C037` / `#E0574D`）——同一预设在两套主题下各取原型值，主色本身可运行时切换故其派生档仍由 store 动态写入（同口径）。③ **主题三态** `light | dark | auto`（新增「跟随系统」并设**默认 auto**）：`prefers-color-scheme` 变更监听即时生效（无需刷新），显式选择不被系统覆盖；`darkMode` 降为生效值派生字段并**不落盘**（落盘的是用户意图 `themeMode`）；旧持久化（只有 `darkMode` 布尔）按显式模式迁移，**升级前后视觉零回归**；顶栏主题按钮改三态下拉（auto 用 Monitor 图标、tooltip 显示当前模式，文案走 E-14 locale 表新增 4 键）。④ **首帧上色**：`index.html` 前置内联脚本按持久化偏好与系统偏好先上 `html.dark`（否则暗色用户先看到浅色底再被 store 切暗），脚本与 store 的键名 / 三模式串 / 媒体查询串 / 位置早于应用脚本由单测断言同源。⑤ **硬编码颜色收口**：登录页验证码画布底色改读 `--fw-bg`（取不到保持透明，不写死任何颜色）、logo 文字色用 `--el-color-white`、任务条上投影改令牌 `--fw-shadow-up`。⑥ **护栏**：令牌层单测 9 条（原型 §2.1 两列逐项锁定 / 六语义色派生档逐项等于混色公式预计算值 / `-rgb` 三元组与基色一致 / **禁止 `color-mix()`** / 暗色独有 `--fw-*` 检测 / **`.vue` 零颜色字面量扫描** / EP 暗色变量先于本仓令牌的覆盖顺序 / 结构性映射落到 `--fw-*`）+ 外观 store 单测 19 条（默认 auto、跟随系统与实时变更、显式不跟随的反向验证、迁移与派生不落盘、主色双口径、明暗切换重算、损坏存储与缺 `matchMedia` 环境兜底）。**验证**：admin-web **183/183**（新增 28 条）+ `vue-tsc` 0 错误、**`pnpm build` 后校验产线 CSS 逐项命中**（`smoke-mock` 脚本**不构建**——只在 `dist` 已存在时跑体积门禁，不先构建会拿旧产物「通过」；本项验证流程固定为 `pnpm build` → 产线 CSS 取值断言 → `pnpm smoke`）、`smoke-mock` **133/133**（bundle 门禁：dist gzip 339.1 kB ≤ 600、vendor-element-plus 236.5 kB ≤ 360）、静态门禁 check:headers（578 文件）/ check-no-raw-sql（336 文件）/ check:helm（63/63）/ check-api-parity 全绿。**决策与范围边界（如实登记）**：O-4 收口为「暗色首发一等形态」；语义色派生档为静态预计算值（不引 SCSS / PostCSS / 前端色库，也不用 `color-mix()`——构建管线会静默丢弃，见 ②），改动基色时由单测按公式逐项标红；EP 结构边框五级**刻意不拉平**到单一 `--fw-border`（各级边框需保证暗色可见性，强行拉平会让表格分隔线与输入框描边不可见）。决策与取舍见新文档 **[ADR-0015](./docs/adr/0015-dark-mode-tokens.md)**。

### Added（M10 E-17 前端错误监控 RUM，2026-10-15）

- **E-17 前端错误监控 RUM（PRD-010 P3，前端异常从「用户报告」变「主动发现」）**：① 采集侧 `apps/admin-web/src/utils/rum.ts`——三源采集（`window error` 捕获阶段含资源加载失败 / `unhandledrejection` / Vue `errorHandler`，保留调用方既有 handler 不吞行为），会话内同签名去重（每签名 ≤5 条）+ 单会话 ≤100 条 + 单批 ≤10 条（`RUM_MAX_BATCH`）三重上限防一个 bug 刷爆上报；`navigator.sendBeacon` 优先、`fetch keepalive` 兜底，**采集与上报全程 try/catch fire-and-forget**（任何失败都不得反噬业务）；`VITE_RUM_ENABLED=false` 或非浏览器环境整体关闭（零开销）；`pagehide` / `visibilitychange` 冲刷待发批次。② 链路关联：`utils/trace.ts` 记住最近一次后端响应 `X-Trace-Id`（`utils/request.ts` 响应与错误拦截器登记）——前端错误与后端日志同链关联，不引前端 OTel SDK。③ 服务端新模块 `client-errors`：`POST /api/v1/telemetry/client-errors`（**@Public**——登录页与未登录态异常同样上报），信封形状 / 来源枚举（error/rejection/vue/resource）/ 字段长度 / 单批条数校验，多字段错误一次回齐（details 带 `reports[i].field` 字段级定位）；逐条 **error 级结构化日志**（`module=rum`，字段化 ctx，与后端异常同一管道可检索，对齐「错误全采」理念）；进程内按 source 计数随响应回带 `{received, total}`（被动观测面——**不设 stats 查询端点、不新增权限码**）。④ mock 同构（公开端点 + 同口径校验 + 进程内计数）。设计取舍：上报走 sendBeacon/fetch 而非 `request.ts`（无鉴权头、不过响应拦截器），api-parity 门禁将该路由归入「后端有前端未调用」提示位（预期内）。**验证**：admin-web **155/155**（rum 19 条：归一化 / 签名 / 批量窗口 / 去重 / 会话上限 / beacon 优先与 fetch 兜底 / 全静默失败 / 卸载）+ `vue-tsc` 0 错误、example-api **97/97**（client-errors 18 条：校验矩阵 + 结构化日志 + 计数累计 + 摄取前置拦截不落日志）、smoke-mock **133/133**（新增 6 条 mock 契约断言）、smoke-admin **114/114**（新增 3 条真实后端端到端：合法上报 received/total、超单批上限 400/1001、非法字段 details 一次回齐）、静态门禁 4 项全绿。**范围边界（如实登记）**：计数为进程内视图（多实例合计需日志侧聚合，与 `/metrics` cache 段同口径）；无专项 E-17 冒烟脚本（端点契约由单测 + smoke-admin 段覆盖，同 E-14/E-16 先例）。契约见 [api-spec §3.15](./docs/40-api-spec.md)。

### Added（M10 E-16 边界上限配置化，2026-10-15）

- **E-16 边界上限配置化（PRD-010 P3，边界值从「源码常量」升级为「登记配置」）**：四处硬编码常量定价为 env 键并登记 `ENV_KEY_PATHS`（现共 **87 键**，「加键必须登记」门禁由 env-registry 单测强制 schema 与注册表一致，防键集漂移）：`WEB_KEEP_ALIVE_MAX`（默认 12，前端 `<keep-alive :max>` 钳制值，**入热更白名单** `web.keepAliveMax`——前端布局挂载时经 `GET /configs` 读取，不热更则改值必须重新构建部署，与「上限配置化」目标相悖；原 PRD「按需入热更白名单」口径经前端消费路径收敛为必须入）、`MQ_DEAD_LETTER_PAGE_MAX`（默认 200，死信分页每页上限，boot 键——与 `MQ_DEAD_LETTER_MAX` 同先例构造期读取，`GET /admin/queue/dead-letters` 的 pageSize 超出钳制到上限而非报错）、`JOB_ARTIFACT_MAX_MB`（默认 20，任务产物体积上限，memory / db / bullmq 三驱动同口径构造注入，超出即失败终态）、`CONFIG_CENTER_HISTORY_MAX`（默认 20，配置历史保留版本数——回滚候选集 limit / 404 文案 / 环形表淘汰三处改读，超出淘汰最旧）。前端 `store/web-limits`（一次会话只打一次 `GET /configs`、失败不重试 fail-open、值域 [1,1000] 校验）+ `AppMain.vue` 接线；mock 同构（白名单 11→12 键、**已知键集一次性补齐 4 个新点路径**——修复 E-01/02/03/07/10 以来遗留缺口）。**验证**：`@fw/config` **16/16**（87 键护栏 + 白名单 12 键固定）、`@fw/queue` **150/150**（新增可配钳制断言：`deadLetterPageSizeMax: 5` → pageSize 999 收敛到 5）、`@fw/config-center` **54/54**（maxHistory 可配——环形表按配置值淘汰、回滚 404 文案同步）、example-api **97/97**（jobs 产物上限可配）、admin-web **155/155**（web-limits 6 条：默认值 / 合法下发 / 无键 / 越界 / 请求失败 / 只加载一次）+ `vue-tsc` 0 错误、smoke-mock **133/133**（含 12 键白名单断言）。文档同步：60 手册 4 键、`.env.example`（example-api + admin-web `VITE_RUM_ENABLED`）、api-spec §3.8 死信分页可配 / §3.11 产物上限可配 / §3.12 白名单 12 键与回滚保留版本文案。

### Added（M10 E-08 admin 全栈项目模板，2026-10-15）

- **E-08 admin 全栈项目模板（PRD-010 P2 / AC5，`fw new --template=admin` 一键产出可运行全栈骨架）**：① **模板资产** `templates/admin/`——`server/`（NestJS 服务端：`@fw/auth` 装配登录 + RBAC（用户 / 角色 / 菜单 / 字典 / 审计端点，`PrismaAuthStore` + `CacheBackedAuthCache` 复用 example-api 同构实现）、`DbModule.forRoot` 数据库装配、E-03 限流中间件挂 `/api/v1`、`demo-item` 示例 CRUD（`fw gen crud` 产物形态补 `@Permissions` + `@Audit` 守卫）、**附件上传模块**（`POST /api/v1/files` multipart 上传 + 元数据 + 流式下载，`file:create` 权限守卫、扩展名白名单 11 类、20MB 上限、UUID 存储名免疫路径穿越、按月分目录本地磁盘存储——E-09 落地后可平移为 `StoragePort` 适配，业务接口不变）+ prisma schema（RBAC 全套表 + 字典 + DemoItem + **`upload_files`** 模板自有表）+ 幂等种子（权限点 / admin·user·dept_leader 三角色 / 菜单树 / 字典基线 / 部门树 / admin·alice·bob 三账号，Argon2id 现场哈希）+ 预生成 SQLite 迁移）；`admin-web/`（Vue3 + Element Plus 前端精简骨架：登录 / 动态路由 / 按钮级权限 / 工作台 / 用户 / 角色 / 字典 / 示例 CRUD / 附件 —— 自 `apps/admin-web` 裁剪（不含任务中心、配置中心、租户页与 mock server），vite dev 代理到服务端）。② **CLI 接线**：`fw new --template=admin` 从报错变交付——生成后**自动把 `server` / `admin-web` 两个子包注册进框架仓库根 `pnpm-workspace.yaml`**（幂等、带标记注释便于清理；仓库外生成时打印手工注册说明），服务端 `.env` 一并就位，定制后续步骤提示；`cms` 保持未交付报错。**依赖解析路径**：生成项目以框架工作区成员形态解析 `workspace:*`（与 `apps/*` 同构、单一 lockfile，不引入 `file:` 链接或打包副本——pnpm 11 overrides 对 `file:`/tarball 目标的传递依赖不生效已实测排除）。③ **模板冒烟** `scripts/smoke-template-admin.mjs`（`pnpm smoke:template-admin`）：生成 → 安装 → migrate → seed → 构建启动 → **登录 + CRUD + 附件上传三端点连通** + 未登录 401 / alice 越权 3002 反向断言，全绿（按 E-xx 专项冒烟既定纪律不入 CI）。**验证**：生成项目服务端 `tsc` 0 错误、admin-web `vue-tsc` 0 错误、冒烟 7/7、`@fw/cli` 单测 8/8（admin 成功路径 + 仓库外告警 + cms 报错）。文档同步：根 README 快速开始改「目标体验」为已交付流程、`templates/admin/README.md` 新增、`templates/api/.env.example` 补齐 E-03 `RATE_LIMIT_*` 六键（E-03 遗漏的模板 env 同源缺口）。

### Added（M10 E-14 i18n 骨架，2026-10-15）

- **E-14 i18n 骨架（PRD-010 P3 / NG6 到期项，OQ-4 决策落地：错误码文案前端接管）**：① admin-web 新增 `src/locales` 文案表与极简 i18n 运行时——zh-CN / en-US 双表（错误码全集 + 语言切换器文案），**键集与 `BIZ_CODE` 数值全集编译期同构**（`ErrorMessages` 强类型，新增错误码不同步两表即 `vue-tsc` 报错，承接 api-spec §2「新增错误码必须同步」的前端侧义务）+ 模块级响应式 locale（localStorage `fw_admin_locale` 持久化 + `<html lang>` 同步；刻意不做浏览器语言嗅探，缺省 zh-CN）+ 点路径 `translate()` / `{var}` 插值 / `useLocale()` 组合式；**不引 vue-i18n**（2 门语言的骨架用不上复数/日期本地化，自研运行时约 60 行，决策与备选取舍见 [ADR-0014](./docs/adr/0014-i18n-frontend-locale.md)）。② `describeBizError` 文案表化 + locale 参数化——zh-CN 沿用「后端 message 优先」**显示行为零回归**（既有文案断言零改动通过），非 zh-CN 由前端表接管（后端中文 message 不再串味），未知码回落后端 message 再落兜底；9001（traceId 变体）/ 5002（details 拼接变体）走占位模板；4001 租户无效补专属文案（原走通用兜底）。后端零改动，信封 `{ code, message }` 契约不变。③ Element Plus locale 经 `ElConfigProvider` 接线（App.vue 包裹路由视图）+ Navbar 语言切换下拉（简体中文 / English，选项用原生名），切换即时生效无刷新。文档同步：**新文档 [ADR-0014](./docs/adr/0014-i18n-frontend-locale.md)**、api-spec §2 文案本地化归属注记（新增错误码须同步前端两表）、PRD-010 OQ-4 标注已采纳、adr README 与根 README 索引更新。**验证**：admin-web **121/121**（新增 11 条：zh-CN 零回归守卫 / en-US 表接管 / 5002·9001 模板插值 / 双表键集护栏 / resolveLocale 归一化与非法值回落）+ `vue-tsc` 0 错误、`smoke-mock` 119/119（含 bundle 门禁）、静态门禁 check:headers / check:helm / check:api-parity 全绿（check:config 因本机缺 gitignored 根 `.env` 读不到 `APP_ENV` 未跑通——环境预置问题，与 E-14 无关：本项零新增配置键）。

### Added（M10 E-13 站内信 / 通知中心，2026-10-15）

- **E-13 站内信 / 通知中心（PRD-010 P3 / AC10，管理后台消息触达闭环）**：① **消息由事件订阅产生，不由业务直调**——新增通知派发器订阅 `@fw/transport` 事件面：`job.progress` 的**终态**事件 → 派发人一条（成功/失败分级别，附产物文件名或失败原因；**运行中的进度事件不通知**——进度感知是任务条 E-12 的职责，写进站内信只会变成噪声）；`queue.alert` → 持 `system:queue:list` 的账号各一条（死信 error / 积压 warning，收件人按**权限码解析**而非硬编码名单）。② 新表 `notifications`（迁移 `20261015233000`，数据字典 **§3.18**）：`dedupe_key` **唯一**——多副本下每个副本都会收到同一事件并各自尝试写入，唯一约束让只有一个成功、其余静默跳过（无需分布式锁，比应用层「先查后写」少一个竞态窗口）；任务重跑因 `updatedAt` 变化会产生新消息；每人保留 200 条（超出淘汰最旧，未读计数不随历史线性变慢）。③ 用户面五端点（api-spec **§3.14**）：`GET /notifications`（分页 + `unreadOnly`，一次性返回 `total/unread`）、`GET /notifications/unread-count`、`POST /notifications/:id/read`（幂等）、`POST /notifications/read-all`、`DELETE /notifications/:id`。**鉴权 `notification:read`**（新增权限点并 seed 给 admin / user 与 M8 三示范角色 + mock 同步；不落「登录即可」——消息中心是可授予可回收的能力面），**归属人即边界**：越权与不存在一律 `404` 不泄露存在性（与 `/jobs/:id/*` 同语义）。④ **实时未读**：落库后广播 `notification.created`，经 E-12 的 SSE 通道下发 `notification` 事件（服务端按 `ownerId` 过滤），铃铛不轮询即刷新；票据主题裁剪同步（无 `notification:read` 不订阅该主题）。⑤ 前端重构 + 新组件：连接所有权从 `useJobCenter` 抽出为 **`store/realtime`（单连接多消费者）**——E-12 把流放在任务条里，再加一个消费者就会变成两条长连接（浪费连接数，且票据与重连策略出现两份）；现在新增消费者 = 注册一个 handler。`layout/NotificationBell.vue`（未读角标 + 下拉最近 8 条 + 全部已读 + 单条已读/删除 + 级别色点 + 相对时间）+ `store/notification.ts`（首屏一次性对齐列表与未读、实时事件按 id 去重前插、无权限时整块隐藏而非显示一个点了报错的图标）+ `utils/relative-time.ts`。⑥ mock 同构：五端点 + `notification:read` 权限点与角色授权 + 预置两条演示消息（mock 无事件面，若消息面恒空则铃铛与未读数无从验证）。**验证**：example-api **79/79**（新增 20 条：服务 8 + 派发器 12——含重复投递幂等、重跑产生新消息、进度事件不建消息、无收件人跳过、订阅失败降级、停机退订、广播失败不影响落库）、admin-web **152/152**（新增 15 条：realtime 5 / 通知 store 7 / 相对时间 3，另将 SSE 集成 5 条按新架构改写）+ 既有用例零回归、新冒烟 `smoke-notifications.mjs` **29/29**（未登录 401、前置清场、主题裁剪 admin=`[job,notification,queue]` / alice=`[job,notification]`、**派发任务 → 事件流直接收到 notification 事件**（kind=job.finished / level=success）、未读 1 → 标记已读 → 0 且重复标记幂等、归属人隔离反向验证（他人读/删 404 + 他人连接收不到你的通知 + 两人消息面完全隔离）、**无 `notification:read` 探针账号 → 3002 且票据主题不含 notification**、失败任务 → `job.failed`/error、两条终态恰好两条消息（进度事件不产生消息）、read-all 清零、删除后总数回落）。**范围边界**：多副本跨实例扇出仍依赖真实 Redis（本机无，同 E-12），写幂等由唯一约束 + 单测覆盖。

### Added（M10 E-12 SSE 实时推送，2026-10-15）

- **E-12 SSE 实时推送（PRD-010 P3 / AC9，完成感知从「最慢 10s」→「秒级」）**：① `@fw/transport` 新增**事件面**（RPC 之外的第二个语义面：地址是「找谁处理」、主题是「发生了什么」）——驱动端口增补**可选能力** `publish` / `subscribe`：`in-process` 驱动在本进程内扇出（单体零依赖），`redis` 驱动经 `PUBLISH` / `SUBSCRIBE`（**独立订阅连接**，订阅模式连接不能跑常规命令）跨实例广播，多副本下事件由任意实例产生、任意实例的订阅方都能收到；端口无该能力的驱动（预留 tcp/kafka 或 RPC-only 桩）由 `TransportService` 统一转 `TransportEventsUnsupportedError`（**快速失败优于静默丢事件**——静默会让 SSE 页面永远收不到推送却无任何报错）。订阅方异常被驱动隔离（单个连接断开不影响其他订阅方），`TransportCallStats` 增 `events`（published/received/topics/topicList）。② example-api 新增**统一 SSE 通道**（`EventsModule`）：`POST /events/ticket` 签发 **60s 一次性票据**（存 `CACHE_STORE`，redis 驱动下多实例共享），`GET /events/stream` 建 `text/event-stream` 长连接下发 `ready` / `job` / `queue` 三类事件，15s 注释帧心跳 + `X-Accel-Buffering: no`（防反代缓冲吞掉实时性）+ 断连即退订（无悬挂订阅）。**鉴权设计**：`EventSource` 无法自定义请求头、令牌只能进查询串，而查询串会落进网关访问日志——故用一次性短凭证换票，而非把 access token 写进 URL。**可见性边界**：主题按权限裁剪（`queue` 需 `system:queue:list`；`job` 人人可用），任务事件服务端按 `ownerId` 过滤。③ 事件源：任务中心三种驱动（memory/db/bullmq）与 `JobExecutor` 在**状态变更点**（派发/重跑、running、进度推进、终态）经模块级汇（先例 `setGlobalRateLimiter`，避免把事件面污染进驱动构造签名，memory 驱动「无参构造 = N-02 原行为」的既有契约与单测零改动）发事件；队列侧死信经 `QueueModule.forRoot({ alert })` 汇入，积压告警由 15s 巡检**边沿触发**（跨阈值只广播一次、回落复位，不刷屏）。④ 前端：`utils/sse.ts` 客户端（能力探测前置：无 `EventSource` 直接判定不可用、不白跑取票；**不信任 `EventSource` 内建重连**——票据一次性，自动重连必然带旧票换回 401，故主动关流 + 3s→30s 指数退避重新取票）；`useJobCenter` 改为**实时优先、轮询兜底**：SSE 在线即停轮询并保留 60s 低频对账（防「连接没断但事件丢了」），SSE 不可用立刻回落原退避轮询；任务条新增「实时 / 轮询」徽标。⑤ mock 对 `/events/ticket` 明确返回「不提供 SSE」而非伪造票据，前端确定性降级。**验证**：`@fw/transport` **93/93**（新增 10 条：in-process 扇出/异常隔离/退订/非法主题、redis 跨实例广播（共享总线双驱动实例）/退订释放频道/不可序列化载荷快速失败/异前缀忽略、服务层委托与统计、驱动无事件面时的错误）、example-api **58/58**（新增 6 条：票据主题裁剪/一次性与并发核销/损坏载荷/装配转发/发布失败降级/积压边沿触发）、admin-web **104/104**（新增 10 条：SSE 客户端 5 + store 集成 5）+ `vue-tsc` 0 错误、新冒烟 `smoke-events.mjs` **19/19**（未登录取票 401、主题裁剪反向验证、建流响应头与 ready 帧、票据一次性与伪造票据 401、派发后**不经轮询**即收到该任务事件（实测终态延迟 61ms）、归属人隔离反向验证、断连后事件面主题数回落 0）；回归 `smoke-transport` 6/6、`smoke-jobs-db` 10/10、`smoke-mock` 119/119、static 门禁 4 项全绿。**范围边界（如实登记）**：多副本跨实例扇出需真实 Redis（本机无 Redis），该语义由 transport 单测（共享事件总线的双驱动实例）覆盖，真机复跑待环境。契约见 [api-spec §3.13](./docs/40-api-spec.md)。

### Added（M10 E-10 审计归档策略，2026-10-15）

- **E-10 审计归档策略（PRD-010 P2 / AC7，98 清单 1.4 口径从「100 万行内」扩展为可持续）**：① `@fw/auth` 新增 **`AuditArchivePort` + `AuditArchiveService`**——批量「先写归档、后删在线」迁移循环：归档写入按主键 **upsert 幂等**（崩溃在写后删前的中间态重跑覆盖同 id，不产生重复行），写失败立即中止绝不删在线（fail-closed 不丢数据），截止线严格小于（边界记录不动）、分批推进（`maxBatches` 防单轮长占锁）。② example-api 落地：新表 **`audit_log_archives`**（迁移 `20261015210000`，SQLite/PG 双方言同构，数据字典 §3.17；主键与在线表一致 + `archived_at` 登记归档时刻，只增不改不删）+ `PrismaAuditArchiveStore` 端口适配（稳定升序分页 / 幂等 upsert / 行数计数 / 归档分页查询）+ 定时任务 **`audit.archive`**（`@Cron 0 2 * * *`，`lock: true` 分布式锁多副本单执行——与 auth.refresh-cleanup 同机制，TC-JOB-002 与 docs/94b cron 分布式互斥实测背书）+ 冷数据两端点 `GET /api/v1/audit-archives`（`audit:read`，dataScope 与排序白名单同源收敛）与 `GET /api/v1/audit-archives/export`（`audit:export`，任务类型 `audit.archive.export` 登记 `JobRunnerRegistry` 跨实例重跑，CSV 与在线审计导出逐字节同构）+ 运行快照 `GET /auth-maintenance/audit-archive`。③ 新配置键 2 个 `AUDIT_ARCHIVE_RETENTION_DAYS`（默认 180，与数据字典 §3.13 保留期口径一致）/ `AUDIT_ARCHIVE_BATCH_SIZE`（默认 1000），`ENV_KEY_PATHS` 80→82 键护栏同步；全部 boot 键不入热更白名单。**验证**：`@fw/auth` **138/138**（新增 9 条：截止线边界 / 分批 / maxBatches / fail-closed 反向 / 崩溃重跑幂等 / 删零中止防死循环）、`@fw/config` **16/16**（82 键护栏）、example-api **58/58**、新冒烟 `smoke-audit-archive.mjs` **13/13**（`RETENTION_DAYS=1`/`BATCH_SIZE=2` 实测：lastArchived=3、在线表行数回落、幂等重跑 0、归档查询命中 / 导出 CSV UTF-8 BOM、越权 403/3002 与未登录 401 反向）。文档同步：数据字典 §3.13 保留期口径 + §3.17、60 手册 2 键、`.env.example`、api-spec §3.7 两端点、98 清单 1.4、PRD-010 AC7 勾选。

## [0.5.0] - 2026-10-15

> 发布说明与验收证据见 **[v0.5.0 发布验收报告](./docs/90-release-v0.5.0.md)**。
> 本版聚焦「多实例一致性收口 + 规模化遗留 + 认证策略名实相符」：PRD-010 的 P0（E-01~E-04）与 P1（E-06/E-07）阶段交付。

### Added（M10 E-07 认证策略端到端，2026-10-15）

- **E-07 OAuth2 / apikey / session 端到端（PRD-010 P1 / AC6，`AUTH_STRATEGY` 枚举名实相符）**：① `@fw/auth` 新增 **OAuth2 授权码流服务**（`OAuth2FlowService` + `AUTH_OAUTH2_FLOW`）——authorize URL 构建、state 防 CSRF（随机 UUID 经 `AuthCachePort` 一次性消费：取后即删 + TTL 300s，redis 驱动下多实例共享，回调可落任意实例）、RFC 6749 §4.1.3/§4.1.4 标准 form 交换（Node 内置 fetch 不引 SDK，与 NacosConfigDriver 同策略，fetch 可注入测试桩）；**回调域名白名单**（`AUTH_OAUTH2_REDIRECT_WHITELIST` 前缀匹配且边界完整——`http://ok.com.evil.com` 不命中 `http://ok.com`，未配置 = 全拒默认安全）。② example-api 三端点 `GET /auth/oauth2/providers | :provider/authorize | :provider/callback`（providers 驱动登录页入口渲染；身份映射在应用层——本地账号取 IdP `email`/`username`，**不自动建号**防外部身份提权；`response_mode=json` 返回 TokenPair、缺省 302 以 URL fragment 回传令牌不进服务器日志）；`AuthService.loginByOAuth2` 会话落地与口令登录同源（refresh 轮换族/权限加载/审计 `after.provider`）。③ **apikey 强制验签**（`AUTH_API_KEY_SIGN_SECRET` 配置后生效，向后兼容）：`X-Api-Sign = HMAC-SHA256(secret, key\nts\METHOD\path)` + 时间戳 300s 防重放窗口 + 常量时间比对，算法导出 `apiKeySignature` 供业务同源生成；example-api 新增 `/api/v1/open/ping`（`@AuthStrategy('apikey')` 示例路由——原先全仓没有任何 apikey 路由，即「枚举有、路径无」缺口本体）。④ 前端：登录页按 providers 列表渲染 OAuth2 入口（拉取失败按空处理不阻塞密码登录）、回调 fragment 解析（抽 `utils/oauth2.ts` 纯函数 + 单测）、解析后立即清 hash 防令牌留历史记录；mock 同构（同形 providers 端点，无 IdP 如实返回空）。⑤ 新配置键 3 个 `AUTH_OAUTH2_PROVIDERS / AUTH_OAUTH2_REDIRECT_WHITELIST / AUTH_API_KEY_SIGN_SECRET`（`ENV_KEY_PATHS` 77→80 键，护栏同步；全部 boot 键不入热更白名单）。**验证**：`@fw/auth` **129/129**（新增 18 条含 state 重放/跨提供方/白名单边界绕过等反向验证）、`smoke-oauth2.mjs` 新冒烟 **15/15**（本机 stub IdP 全链路：跳转→授权→换 token→`/auth/me` 会话成立 + 反向验证 9 条 + apikey 签名段 4 条）、admin-web **94/94** + `vue-tsc` 0 错误、example-api **52/52**、`@fw/config` **16/16**（80 键）、`smoke-mock` **119/119**、静态门禁 4 项全绿。**契约订正**：api-spec §3.2 原 `/auth/oauth/:provider` 两行自 M3 起悬空未实现，按落地形态改写为 `/auth/oauth2/*`；§1.2 策略表加「名实相符状态」列；流程与签名约定见新文档 [docs/41](./docs/41-auth-strategies.md)。

### Added（M10 E-06 Redis Cluster 实测收口，2026-10-15）

- **E-06 bullmq / transport 的 redis-cluster 支持实测收口（PRD-010 P1 / AC8，L-04 划出的范围边界）**：① `@fw/queue` `createBullConnection` 与 `@fw/transport` `createRedisClient` 支持**多节点连接串**（逗号分隔 → `ioredis.Cluster`）——bullmq 阻塞连接 `maxRetriesPerRequest=null` 与 transport 快速失败 `=2` 语义在 cluster 下分别保留；② **hash-tag 约定**：bullmq 键族必须同槽（cluster 部署 `MQ_PREFIX={...}:`），驱动启动告警兜底（cluster URL + prefix 无花括号 → 可操作 WARN）；transport 键操作全单键（LPUSH/BLPOP/BRPOP/DEL/EXPIRE 独立），**无需 hash-tag**（两驱动差异文档化）；③ `smoke-queue.mjs` 阶段 D/F 适配 cluster（hash-tag prefix + `CACHE_DRIVER=redis-cluster`——cache 单实例客户端对 cluster 节点收 MOVED 假错误）。**实测**（[docs/94b](./docs/94b-queue-transport-cluster-live-test.md)：真机 6 节点一次性容器集群，L-04 同模式，测后即删）——bullmq 8 断言（入队/重试/死信/指标/**失速恢复 SIGKILL 演练**/cache-cluster 健康/cron 分布式互斥）+ transport 3 断言（单进程往返/双进程跨进程/超时 fail-fast）**全部通过**；hash-tag 反向对照实证（无花括号 prefix 入队静默失败）。单测 +4（parseClusterNodes 解析面 + Cluster 分支桩），queue **150/150**、transport **83/83** 零回归。

### Added（M10 E-03 框架级 API 限流，2026-10-15）

- **E-03 框架级 API 限流（PRD-010 P0 / AC3，G5「限流默认开启」的框架级兑现）**：`@fw/cache` 新增令牌桶原语与限流器——`CacheStorePort.tokenBucketTake(key, capacity, refillPerSecond, cost, now)` **原子取令牌**（memory 驱动进程内惰性补充，单次 ≤1ms；redis/redis-cluster 驱动 Lua 脚本一次完成「补充→扣减→回写→续期」，**多实例共享同一桶**，桶 TTL = 自然回满时间 + 缓冲防冷桶永驻）。`RateLimitLimiter`（按 IP 维度——中间件位于鉴权守卫之前拿不到用户身份；严格路径段前缀白名单豁免，`/metricsX` 不豁免于 `/metrics`；fail-open 与 cache 三防护同构；**dry-run 灰度仅计数告警不拦截**——非「关闭」，桶与计数照常运转，满足「默认开启不可整体关闭」）+ `RateLimitMiddleware`（Nest 全局中间件，429 + 既有错误码 `9003`（HTTP 429 已在 `@fw/core` 映射）+ `Retry-After` 头 + details 顶层信封同形）。限流计数（allowed/denied/whitelisted/dryRunPassed/failOpen）并入 `/metrics`（`fw_rate_limit_*` Prometheus 段，经模块级引用 `setGlobalRateLimiter`——仿 `setGlobalCacheService` 先例，未装配时输出不含该段）。example-api 装配：`AppModule implements NestModule` 挂 `/api/v1` 全路由，limiter 工厂按 `RATE_LIMIT_*` env 构造（`CACHE_STORE` 由 `CacheModule` 导出）。新增 5 键 `RATE_LIMIT_CAPACITY/REFILL_PER_SECOND/WHITELIST/FAIL_OPEN/DRY_RUN`（`ENV_KEY_PATHS` 72→77 键，护栏同步；全部 boot 键不入热更白名单，默认容量 600/每秒补充 10/白名单 health+ready+metrics/fail-open true/dry-run false）。验证：`@fw/cache` **88/88**（新增 8 条：memory 令牌桶容量/耗尽/时间补充封顶、redis Lua 桩参数与解析、白名单严格前缀、dry-run 计数、fail-open/fail-closed 反向、IP 规范化、429 信封；既有 80 条零改动）、新冒烟 `smoke-rate-limit.mjs` **8/8**（容量 5 实测连打 10 次 200×4/429×6、429 信封 code=9003 + Retry-After、超限下 health/ready/metrics 仍 200、`/metrics` 出现 `fw_rate_limit_denied_total ≥ 1`、dry-run 实例全 200 且 `fw_rate_limit_dry_run_passed_total ≥ 1`）、`@fw/config` **16/16**（77 键护栏）。文档同步：60 手册 5 键、`.env.example`、api-spec 限流注记。

### Added（M10 E-04 权限树契约落地，2026-10-15）

- **E-04 `GET /permissions/tree` 落地（PRD-010 P0 / AC4，api-spec §3.4 悬空契约收口）**：受 `permission:read` 保护的三层树——业务域（module）→ 权限点（menu 类在前、button/api 类随后，节点携带 `id` 与含子孙的 `codes`）→ 子资源预留。**实现注记（契约字面与实现的差异，如实登记）**：权限点与菜单之间无「属于哪个菜单」外键（menus 经 permissionCode 弱关联），树不伪造「按钮挂在菜单下」的归属层级——「菜单/按钮/接口三层」的归属语义待权限点引入归属外键后再收；当前树的第 2/3 层 = 权限点（type 区分）。前端两处选择器换接该端点（`flattenPermissionTree` 拍平兼容，UI 零改动）：roles 页授权弹窗分组数据源、menus 页权限码选择器（原 `GET /permissions` 契约保留）。mock 同构（同 module 分组 / 同 type 排序 / 同节点结构）。验证：`smoke-admin` 新增 E-04 段 **111/111**（admin 三层树 200 / 树与分组视图权限码集合完全一致的反向对撞 / 三型齐备 / alice 越权 403/3002）、`smoke-mock` **119/119**、admin-web 单测 **89/89**、`vue-tsc` 0 错误、`check-api-parity` OK（`/permissions/tree` 调用面 ↔ 后端路由对上）。

### Added（M10 E-02 配置中心多实例语义 + nacos 转正，2026-10-15）

- **E-02 配置中心多实例语义（PRD-010 P0 / AC2）**：`@fw/config-center` 新增可选 `ConfigHistoryPort`（append upsert / latest / findByVersion / list）——快照历史与版本号基线下沉持久层：**A 实例写入的版本 B 实例即时可见**（GET /configs 返回前经 `syncRemoteVersion()` 对齐持久层最新版本），**回滚候选跨实例一致**（rollback 候选集改读持久历史，缺省目标 = 持久层上一版）；版本号以持久层最新值为基线取大 +1（多实例不撞号），**外部事实源变更（file/nacos 轮询）对齐不推号**（B 实例追上远端已登记版本而非另占新号，反向保证单实例直改事实源仍推号入历史）；不注入端口 = 进程内环形表（M9 原行为，既有单测零改动）。example-api 落地：新表 `config_snapshots`（迁移 `20261015185000`，数据字典 §3.16，保留最近 20 版）+ `PrismaConfigHistoryStore`（Prisma upsert + 淘汰窗口）并默认装配。**nacos 驱动转正**：`CONFIG_CENTER_DRIVER` 枚举 `file` → `file | nacos`，新增 6 键 `CONFIG_CENTER_NACOS_SERVER_ADDR/DATA_ID/GROUP/NAMESPACE/USERNAME/PASSWORD`（`ENV_KEY_PATHS` 66→72 键，护栏同步；serverAddr 缺失启动即失败；nacos 走 v1 Open API 内容 MD5 轮询——多实例天然安全），example-api 按驱动装配 `NacosConfigDriver`。验证：`@fw/config-center` **53/53**（新增多实例语义 4 条：跨实例读版本一致 / 跨实例回滚一致且计入历史 / 版本基线不撞号 / **反向验证**：不注入历史保持 M9 原语义；既有 34 条零改动）、`@fw/config` **16/16**（72 键护栏）、example-api **52/52**、`smoke-config` **35/35**（新增持久历史前置清场）、新冒烟 `smoke-config-multi.mjs` **10/10**（双进程 = 双副本共享 SQLite 历史 + 共享事实源文件：A 写 → B 版本即时一致 → B 轮询追上 → B 回滚 → A 一致跟进 → nacos 缺 SERVER_ADDR 启动即失败）。文档同步：api-spec §3.12 多实例注记、数据字典 §3.16、60 手册（nacos 6 键 + 多实例选型指引）、`.env.example`、PRD-010 状态（OQ-2 采纳持久层方案）。

### Added（M10 E-01 任务中心驱动化，2026-10-15）

- **E-01 任务中心驱动化（PRD-010 P0 / AC1）**：N-02 任务中心从进程内存登记表升级为「端口 + 三驱动」——`JobCenterPort`（create/get/retry/artifact）+ `JOB_CENTER_DRIVER` 枚举（**memory 默认 = N-02 原行为零改动** / `db` / `bullmq`，boot 键不入热更白名单）。① **db 驱动**：新表 `jobs`（迁移 `20261015180000_add_jobs`，数据字典 §3.14 由 M7 规划模型改写为落地形态），登记/进度/终态/产物落库，执行在派发实例——**多副本下进度 / 下载 / 重跑任意实例可达**（不再要求会话粘滞）；重跑经新增 `JobRunnerRegistry`（`type → factory` 注册表）按持久化 params 重建执行体（闭包不落盘），未登记类型给可读 `1004` reason 而非静默失败；并发重跑竞态由 `WHERE status='failed'` 条件更新消解。② **bullmq 驱动**：登记与读面与 db 同源，执行经 `QueueService.dispatch('job-center.execute')` 分发（消费 handler 读库重建 runner 执行写库；执行实例随 `MQ_DRIVER`），入队失败兜底标 failed 可重跑。③ 调用方改造：`audit.export` 与 `tenant.migrate` 的执行体固化进 params（完整查询条件 / 迁移上下文，**连接串以密文入 params** 与租户表同语义），派发闭包与注册表工厂共用同一执行函数——memory 驱动行为逐字不变。④ 配置键 `JOB_CENTER_DRIVER` 登记 `ENV_KEY_PATHS`（65→66 键，护栏单测同步）。⑤ 冒烟新增 `smoke-jobs-db.mjs`（**10/10**）：双进程共享 SQLite 模拟两实例，A 派发 → B 轮询 succeeded → B 下载 CSV（UTF-8 BOM）→ B 重跑失败任务（注册表重建）→ 归属人语义跨实例一致 → memory 驱动回归锚点。验证：jobs 模块单测 **21/21**（memory 原用例零改动通过 + db 驱动 7 条含多副本语义 + bullmq 驱动 4 条含入队失败兜底）、example-api 全量 **52/52**、`@fw/config` **16/16**（键集护栏认新键）、smoke-admin **107/107**（N-02 段零改动全绿）；`[98 清单](./docs/98-scale-checklist.md)` 7.1「应用无状态」任务面勾选条件成立（多副本须切 db/bullmq 驱动）。文档同步：api-spec §3.11、数据字典 §3.14 + ER、60 手册配置键表、`.env.example`。

### Added（PRD-010 立项，2026-10-15）

- **PRD-010 · 下一阶段增强：多实例一致性收口与模板生态（[docs/prd/prd-010-next-stage-enhancements.md](./docs/prd/prd-010-next-stage-enhancements.md)，M10，草案）**：把 [81 号增强规划](./docs/81-enhancement-roadmap.md) 的 E-01~E-17 收编为标准 PRD 形态（背景目标 / 范围 / 用户故事 / FR 表 / NFR / 关键设计 / 8 条 AC / 依赖与风险 / 4 条 Open Questions）。四阶段：P0 多实例一致性收口（任务中心驱动化、配置中心多实例语义 + nacos 驱动转正、框架级 API 限流、`/permissions/tree` 落地）→ P1 规模化遗留（K8s 冒烟、bullmq/transport cluster、OAuth2 端到端）→ P2 模板生态（admin 全栈模板、`@fw/storage`、审计归档、压测补课）→ P3 体验增强（SSE、站内信、i18n、暗色模式、上限配置化、前端 RUM）。PRD 索引同步（原「待规划」中的文件存储 / 消息通知 / 国际化三项由本 PRD 收编）；81 号规划文档头加收编交叉引用。

### Added（下一阶段增强规划落盘，2026-10-15）

- **增强功能规划文档（[docs/81-enhancement-roadmap.md](./docs/81-enhancement-roadmap.md)）**：基于 v0.4.0 + Unreleased 现状的下一阶段（v0.5.x–v0.6.x）完善项清单（E-01~E-17），按 P0–P3 排序。核心评估结论：单实例叙事已闭环，主线转向**多实例与规模化叙事**——任务中心进程内存态（A-01）、配置快照历史进程内环形表（A-02）在多副本下破坏无状态性；G5「限流默认开启」目前仅覆盖登录面（A-03）；`/permissions/tree` 是唯一悬空契约（A-04）。P0 四项（E-01 任务中心驱动化 / E-02 配置中心多实例语义 + nacos 驱动转正 / E-03 框架级 API 限流 / E-04 权限树落地）建议构成 v0.5.0 主线；E-05~E-07（K8s 冒烟、bullmq/transport cluster 支持、OAuth2 端到端）为规模化遗留；E-08~E-11（admin 模板、`@fw/storage`、审计归档、压测补课）为模板生态；E-12~E-17（SSE、站内信、i18n、暗色模式、上限配置化、前端 RUM）按需穿插。每项含目标/收益/验收口径/依赖；明确不做清单与非目标对齐（Kafka 驱动经 O-5 评估不排期）。

### Added（M9 Backlog 收口与 L-04 实测，2026-10-15）

- **配置一键回滚 API（M9 Backlog）**：`POST /api/v1/configs/rollback`（`system:config:write`）——`@fw/config-center` 进程内快照历史环形表（20 版，每次版本推进登记），回滚走三阶段管道：**全量预审计**（任一失败整体不生效）→ **持久化目标覆盖集**（API 源，先落盘后生效）→ **逐键应用并通知**；目标未覆盖的键恢复 env 快照值；回滚本身计入历史（再回滚 = 撤销回滚）；版本不存在 `404/5003`（仅保留最近 20 版）、无历史 `400/1004`、未启用 `400/1004`。api-spec §3.10 与 PRD-009 §10 同步（推翻该 PRD §9「回滚 API 不做」的初版结论并记录决策理由）。验证：`@fw/config-center` 回滚单测 6 条（含审计失败 / 持久化失败整体不生效的反向验证）、`smoke-config` 阶段 G2 新增 8 条（**35/35**）。
- **Nacos 事实源驱动示例（M9 Backlog）**：`@fw/config-center` 导出 `NacosConfigDriver`——走 Nacos v1 HTTP Open API（**不引 SDK**，Node 20+ 内置 fetch）：读 404 → fail-open、写 = 发布（dataId/group/tenant/content/type 全量下发）、内容 MD5 周期轮询（多实例安全，不用长轮询监听端点）、可选鉴权惰性登录（复用 accessToken）、fetch / 定时器可注入测试桩；写后指纹更新抑制自触发（与 file 驱动同策略）。**装配方式**：落地项目实例化注入（`CONFIG_CENTER_DRIVER` 枚举仍仅 `file`，环境契约不变）。验证：fetch 桩单测 9 条（自触发抑制与解析失败 fail-keep 反向验证）。
- **L-04 收口实测记录**：`docs/94-redis-cluster-live-test.md`——真机一次性容器拉起真实 6 节点集群（3 主 3 从，仅绑 127.0.0.1，测后即删），`@fw/cache` redis-cluster 驱动框架级实跑 **8/8**（真实读写 / `/ready` 探活 / 无降级 / `@Cacheable` 命中 / 跨节点标签失效 / Lua 分布式锁 / 槽位路由）。范围边界：`@fw/queue`（bullmq）与 `@fw/transport` 的 cluster 段另行评估（hash-tag 语义）。

### Changed（遗留缺陷收口，2026-10-15）

- **N-03 整页 403 视图（v0.3.0 遗留 R3-03）**：`CrudTable` 列表接口返回 `3002`（无操作权限）时整页替换为无权限视图（与 `/403` 页同形 + 返回工作台入口），不再落「加载失败」通用错误态——3002 是权限判定结论而非瞬时故障，重试按钮会造成「点了也没用」的误导；其他错误码维持原错误态（含 traceId 与重试）。验证：`crud-table` 单测新增 3 条（无权限视图出现 / **反向验证**：非 3002 错误不得误报无权限 / 恢复路径），**10/10**。
- **bullmq rateLimit 热更收口（v0.4.0 遗留 R4-06）**：`@fw/queue` bullmq 驱动限速变更从「固化待重建 + WARN」升级为**重建消费器生效**——先建新消费器（新 limiter）再优雅关旧（新旧短暂并存由 bullmq 同队列多消费器语义兜底，无消费空窗）；同值不重建；重建失败回滚沿用旧消费器（消费面不被热更打没）。验证：结构桩单测 3 条（重建 / **反向验证**：同值不重建 / 失败回滚），`@fw/queue` **147/147**。
- **R4-05 工作台统计口径收口（v0.3.0 遗留 R3-05）**：核实后端 `/users` 与 `/audit-logs` 列表**已按 dataScope 四档收敛**（M8 T-M8-04），工作台取分页 `total` 即「调用方范围内数量」，与列表页所见一致——口径本身无误，缺的是标注。现非 `all` 档登录时，范围敏感卡（用户数 / 审计记录）副标题标注生效范围（`（限本人）` / `（限本部门）` / `（限本部门及下级）`），避免「用户数 1」被误读为全站规模；角色数 / 权限点是全局目录（无范围概念）不标注；取数失败的「—」项标注仍在。验证：`dashboard-permission` 单测新增 5 条（含 all 档与全局目录卡的**反向验证**），admin-web **89/89**。

## [0.4.0] - 2026-10-15

> 发布说明与验收证据见 **[v0.4.0 发布验收报告](./docs/90-release-v0.4.0.md)**。
> 本版聚焦「配置中心与热更新全量落地 + 管理面功能补齐」：M9 配置中心（PRD-009）、N-01 租户管理、
> N-02 异步导出任务中心、列表排序收口、死信分页、体验增强与文档一致性收口。

### Changed（文档归档与状态订正，2026-10-15）

- **历史记录归档**：7 份已完结的点时性记录移入 `docs/archive/<模块>/`（避免与活动文档混排导致版本误引）——发布验收报告 `90-release-v0.1.0.md`、`90-release-v0.2.0.md` → `archive/release/`；数据库实测 `92-test-databases.md`、`93-db-connectivity-switch-test.md` → `archive/database/`；队列演练 `94-queue-stall-drill.md` → `archive/queue/`；M8 演练与压测基线 `96-m8-drills.md`、`97-bench-baseline.md` → `archive/m8/`。全部入仓引用（README / CHANGELOG / 60 / 62 / 63 / 80 / 95 / 98 / 99 / PRD-008 / PRD-009 / Helm README / 归档内部互引）已同步改写为新相对路径，经脚本校验**全仓 markdown 链接 0 坏链**；v0.3.0 发布报告作为当前版保留在 `docs/` 根。清单与核对矩阵见 [文档一致性核对报告 §11](./docs/95-doc-audit.md)。
- **文档状态订正（与实现对齐）**：PRD-001 索引与文件头「草案」→「已发布 v0.1.0」（M1 早已交付，初稿状态遗留）；PRD 索引中 PRD-009「草案」→「已实现（2026-10-15，未发版）」（M9 已落地并全量验证，与 PRD 文件头及 CHANGELOG 上文对齐）。v0.3.0 报告 §6 中 R3-01/02/03/04/07 已被本 Unreleased 轮实现或经 `docs/99` §9 订正，报告按「历史结论不追溯改写」原则保留原文。

### Added

- **M9 配置中心与热更新（PRD-009 落地，M8 遗留 L-02 / FR-08 收口）**：① 新增独立框架包 `@fw/config-center`——`ConfigCenterPort`（`load/write/onChange` + adapter 注册位，`CONFIG_CENTER_DRIVER` 首版枚举仅 `file`，`nacos` 预留不入枚举）、本地文件适配（默认 `./config/runtime.json` + **mtime 轮询**（`CONFIG_CENTER_POLL_SECONDS`，默认 5s，不用 `fs.watch`）+ 原子写（临时文件 + rename））、**单一生效管道：校验 → 审计（先审计后生效，失败整体回滚）→ 持久化 → 应用覆盖 → 通知订阅者**（API 直写与文件轮询两条入口共用同一管道）；fail-keep——事实源缺失/损坏保持最后一份有效快照 + ERROR 日志，修复后自动追上，文件缺失按 env 快照启动（fail-open），白名单外键或非法值启动即失败（fail-fast）。② 热更新白名单**从 env-schema 键注册表派生**：`@fw/config` 新增 `ENV_KEY_PATHS`（全部 65 键 → 点路径）与 `ENV_HOT_KEYS`（白名单 11 键：log.level / log.maxBytes / cache.ttl / cache.nullTtl / cache.ttlJitter / cache.slowMs / cache.lockTtl / mq.rateLimit / mq.concurrency / otel.sampleRatio / tenant.cacheTtl），完整性单测强制「新增配置键必须登记映射、boot 键与安全基线键（auth.maxFailed 等）禁入白名单」（防键集漂移）。③ 四个框架服务新增运行时热更入口（PRD-009 FR-09：经 `onChange` 订阅，禁止自行轮询）——`@fw/cache` `updateRuntimeOptions`（ttl/nullTtl/ttlJitter/slowMs/lockTtl，lockTtl 同步刷新锁管理器）、`@fw/queue` `updateRuntimeOptions` + 驱动端口可选 `applyRuntimeOptions`（memory 即时生效；bullmq concurrency 经 Worker 原生属性即时生效、rateLimit 固化待重建并 WARN）、`@fw/telemetry`（尾采样处理器共享引用，比例即改即生效）、`@fw/tenant`（cacheTtlMs 对新缓存条目生效）；`example-api` 订阅装配 `wireConfigCenterSubscriptions` 带**反向验证单测**（11 键逐一断言生效路径，漏接即 FAIL）。④ 管理端点 `GET /api/v1/configs`（`system:config:read`，白名单键当前生效值 + 运行元信息 `meta`：驱动/快照版本号/轮询间隔/最近生效/最近错误）与 `PUT /api/v1/configs/:key`（`system:config:write`，body `{value}`）；新增 **5xxx 错误码段**：`5001` 该配置键不可热更新（boot 键或不在白名单）、`5002` 新值非法（zod 校验失败，`details` 带原因，**信封顶层**——顺带修复前端此前只读 `data.details` 的既有缺口）、`5003` 配置键不存在；同值写入视为无变更（不产生审计与文件写入）；`CONFIG_CENTER_ENABLED=false` 时 GET 仍可用（env 只读视图），PUT 一律 `1004`。⑤ 变更审计：`ConfigAuditPort` 端口反转（框架不反向依赖 auth，应用装配桥接进统一审计），`module=config`、`after` 携带 `value/source(api|file)/operator/ok(+拒绝原因)`，变更历史在审计日志按模块过滤。⑥ 前端新增「系统管理 → 参数配置」页（`views/system/configs`：键值列表 + 来源标记 + 运行元信息 + 修改弹窗按值类型分控件 + 变更历史抽屉），权限 `system:config:read/write` 与菜单随 seed 建出（`audit_module` 字典同批补 `queue/config` 两值）；mock 与真实后端同构（同白名单 / 同校验语义 / 同错误码 / 同审计可见性，mock 信封 details 顺带对齐顶层形态）。⑦ 新配置键 `CONFIG_CENTER_ENABLED/DRIVER/FILE/POLL_SECONDS` 四处同步（PRD-009 / docs/60 / `.env.example` / compose / Helm values）；CI 显式包列表三处纳入 `@fw/config-center` 并新增 M9 冒烟步骤。验证：`@fw/config-center` 单测 **34/34**、`@fw/config` **16/16**（含注册表护栏）、`@fw/cache` **80** / `@fw/queue` **144** / `@fw/telemetry` **53** / `@fw/tenant` **34**、`example-api` **41**、前端 **81**、`smoke-mock` **119/119**、`smoke-config.mjs` **27/27**（双入口生效 / 三类拒绝 / fail-keep / 审计可见 / 越权面 / 未启用形态 / 覆盖移除恢复 env）。

- **PRD-009 配置中心与热更新（L-02 / FR-08 收口，草案 → 已由上条 M9 交付落地）**：M8 终验的唯一需求级缺口立项——`ConfigCenterPort` + 本地文件适配（mtime 轮询 + 原子写）、从 env-schema 派生的热更新白名单（boot 键禁改）、单一生效管道（校验 → 应用 → 通知 → 审计，API 与文件轮询双入口共用）、管理端点（`GET/PUT /configs`，权限码 `system:config:*`）、admin 参数配置页与变更历史、建议新增 5xxx 错误码段。PRD 见 [docs/prd/prd-009-config-center.md](./docs/prd/prd-009-config-center.md)。
- **列表排序参数（api-spec §1.5 落地，BUG-15 后端部分）**：`@fw/db` 新增 `parseSortQuery()` / `parseSortItems()`，把 `sort=<snake_case 字段>:<asc|desc>`（多字段逗号分隔）解析为框架排序结构，并按**字段白名单**校验——未知字段 / 非法方向 / 超过 5 个字段一律 `400/1001`，**不静默忽略**（静默忽略会让客户端以为排序已生效，且任意 query 参数直入 orderBy 可推断未暴露字段）。`@fw/auth` 的 `UserQuery` 新增 `sort`，Prisma 与内存两套 store 均消费，并始终追加主键 tie-breaker，保证 `skip/take` 分页在同一排序键下稳定（TC-ORM-002）。`GET /api/v1/users` 已接线（白名单：`id` / `username` / `nickname` / `status` / `created_at` / `updated_at` / `last_login_at`）。验证：`@fw/db` 单测 83 通过（新增 13 条）、`@fw/auth` 111 通过、`example-api` `tsc` 0 错误、`smoke-auth` **28/28**（新增 3 条排序断言）。

- **列表排序参数前端接线（BUG-15 前端部分）**：`CrudTable` 原先发出的是列 `prop` 原值（camelCase，如 `createdAt:asc`），与 api-spec §1.5 的 snake_case 约定不符——后端白名单会**拒绝**它，即「后端做完仍不可用」。现抽出可测纯函数 `buildSortParam()`（`toSnakeCase` + 列 `sortField` 显式覆盖），`CrudTable` 统一走它构造 `sort`；列类型新增 `sortField`（用于「展示字段 ≠ 排序字段」）。`users` 页为账号/昵称/状态/最近登录/创建时间 5 列开启 `sortable`（此前无任何页面启用，该路径从未被执行过）。**mock 同步真实后端语义**（同一白名单、未知字段/非法方向 `400/1001`、默认 `created_at desc` + `id asc` 次级键）——mock 放宽校验会产生「dev 全绿、真机 400」的假绿。验证：`vue-tsc` 0 错误、前端单测 **69** 通过（新增 9 条）、`smoke-mock` **68/68**（新增 3 条排序断言）。

- **列表排序覆盖扩展至审计日志**：`GET /api/v1/audit-logs` 接入同一 `parseSortQuery`（白名单 `id` / `module` / `action` / `target_type` / `created_at`），`AuditQuery` 新增 `sort`，Prisma 与内存两套 store 均消费并追加 `id asc` 次级键（原实现只按 `createdAt desc`，分页在相同时间戳下不稳定）；前端审计日志页为模块/动作/对象/时间 4 列开启 `sortable`，mock 同步同语义。验证：`smoke-admin` 新增 3 条排序断言、`smoke-mock` **71/71**（含本条目新增的 3 条）、`@fw/auth` 111 通过、`@fw/db` 83 通过、`tsc` / `vue-tsc` 0 错误。

- **N-01 租户管理收口（后端五端点 + 前端页面）**：api-spec §3.9 自 M8 起只有契约、实现为零，前端亦无页面。本轮补齐全链路：① 后端 `TenantAdminController` 五端点（`GET/POST /tenants`、`PUT/DELETE /tenants/:id`、`POST /tenants/:id/migrate`），整类 `@IgnoreTenant()` 豁免租户解析（否则 `TENANT_ENABLED=true` 时平台管理员自身先 4001），调用方须**同时**持有 `system:tenant:ignore`，与 `tenant:*` 权限码是「与」关系并写豁免审计；`DELETE` 语义为**停用**（不写 `deletedAt`——解析路径必须仍按 code 命中并给 `4001`「租户已停用」，软删会让提示与排障方向跑偏）；legacy 存量单租户（id `0`）停用/迁移一律 `1004`；迁移是长任务（派发任务中心返回 `jobId`），语义为控制面切换（isolation 元数据 + 连接串密文 + 缓存失效），**数据物理搬迁由运维按手册执行**，接口与前端文案均明示。② `TenantAdminStore`（Prisma 与内存双实现）：编码格式校验、`dedicated` 必填 `dbUrl`、`shared` 拒收连接串、编码唯一性（`1003`）、连接串落库前加密。③ 前端 `views/system/tenants/index.vue`：CrudTable（`hideDelete`——内置删除按钮「删除后不可恢复」文案对停用语义构成误导）、`tenant_isolation` / `tenant_status` 字典驱动 `StatusTag`、sortable 列、actions-extra 自定义「停用」（二次确认文案区分停用/删除）与「迁移」（弹窗收集目标隔离级别 + `dbUrl` → 接入任务条）。④ mock 与真实后端同构（同白名单、同 400/404/1004 语义、legacy 守卫、`seedTenants()` 与后端种子同形）。验证：`example-api` 新增 20 条单测（store 9 + controller 11）、`smoke-admin` 新增 N-01 段断言（含 alice 越权）、`smoke-mock` 同步。

- **N-02 异步导出任务中心（后端任务面 + 前端任务条）**：审计导出在 api-spec 标注 Backlog、通用任务面缺位。本轮落地：① `JobCenterService`——进程内存登记表（按 `ownerId` 隔离，他人任务一律 404 不泄露存在性）、任务生命周期状态机（pending → running → succeeded/failed）、进度 `report(percent, message)` 单调收敛、产物上限 20MB（超出即失败终态）、失败任务原地重跑（仅 `failed` 可重跑，`1004`）、登记表裁剪防内存泄漏。② `JobsController`（`/api/v1/jobs/:id/progress|retry|download`）：任务面**只验登录 + 归属人**，不另设业务权限码（语义是「我自己的任务」）；派发侧（`/audit-logs/export` 需 `audit:export`、租户迁移需 `tenant:manage`）才由业务权限码把关；`download` 用 `@Res()` 直写裸文本流（统一信封拦截器对 `headersSent` 不二次包装），`Content-Disposition` 走 RFC 5987 `filename*` 防中文名乱码。③ `GET /audit-logs/export` 派发导出并立即返回 `jobId`（不等完成），同样受 `dataScope` 收敛（`self` 只导自己的记录）；路由刻意声明在 `@Get(':id')` 之前，否则 `export` 被当作 id 命中详情分支。④ 前端 `useJobCenter` store + `JobBar.vue` 页脚任务条：轮询退避 1s×1.5 封顶 10s、连续 3 次失败标 stale、sessionStorage 按用户 id 持久化（换号重建登记表，不串号）、完成后下载、失败展示 `error` + `traceId` 并可重跑。⑤ CSV 产物与 mock **逐字节同构**（表头 `id,createdAt,userId,…`、UTF-8 BOM `\uFEFF`、CRLF、引号转义）——mock 放宽会产生「dev 全绿、真机乱码」的假绿。⑥ 修复两处半成品真 bug：`create/retry` 快照必须先于 `void execute(id)` 取（execute 同步把状态推成 running，后取快照会让派发响应带着 running 返回）；`useJobCenter` 的 `restore()` 换号时不重建登记表。验证：`example-api` 新增 10 条单测、`admin-web` 新增 12 条、`smoke-admin` / `smoke-mock` 各新增 N-02 段（含 `simulate=fail` 失败路径与 BOM 断言——`text()` 会剥 BOM，须用 `arrayBuffer()`）。

- **死信列表分页（体验债收尾）**：`listDeadLetters` 原为全量返回，规模大时首屏与内存都不可控。新增 `pageDeadLetters()` 窗口切片（`page/pageSize`，上限 200），控制器响应带 `page/pageSize`，前端队列管理页改分页消费（tab 标签显示 total）。`packages/queue` 新增 4 条单测（驱动窗口切片、service 钳制、控制器响应）。

- **列表排序覆盖扩展至 roles / dict（BUG-15 增量收尾）**：`GET /roles`、`GET /dict/categories`、`GET /dict/items` 三端点接入同一 `parseSortQuery` 白名单（roles：`id`/`code`/`name`/`remark`/`data_scope`/`sort`，`permissionCount` 为聚合计算字段不可排序；dict 两端点只收视图可见字段），store 层可选 `sort` 透传、缺省行为不变，存储层自带主键 tie-breaker；前端 roles 页 4 列、字典项 3 列开启 `sortable`，mock 同语义（未知字段 `400/1001` 不静默忽略）。验证：`smoke-admin` / `smoke-mock` 各 +6 条（合法排序 + 未知字段 400 + `audit_module` 字典）。

- **管理后台体验增强（E-06 图标/权限码选择器 + E-07 审计模块字典）**：① 菜单管理页图标由自由文本改为 `IconPicker` 选择器（从 `icon-map.ts` 登记表点选 + 搜索 + 清除——手打未登记名只会静默回退默认图标，属假成功）；权限码由自由文本改为从权限点列表点选（`el-select` filterable，防手打出不存在的码被登录快照校验 403）；菜单表格图标列改为「图标 + 名称」可视化。② 审计日志页模块筛选由硬编码枚举改为 `audit_module` 字典消费（原选项过期：缺 `tenant` 且含从未写入审计的 `order`；seed 与 mock 同形落地）。

### Removed（文档一致性遗留 L-05 收口，2026-10-15）

- **移除「文档声明但未消费」的 `LOG_FORMAT` 配置键**：该键曾出现在 `docker-compose.prod.yml`、Helm values、60 手册 §3 配置表、98 规模化清单 §6.1 与裸机 env 样例中，但 `@fw/config` schema 未声明、`@fw/logger` 亦未读取——设置它不报错也不改变行为。日志输出格式由 `@fw/logger` **固定为结构化 JSON**（字段 `time/level/traceId/spanId/module/msg/ctx`）是既定设计，故按「配置诚实原则：无效键不留」走移除路线而非补 schema 消费。本次从全部编排与文档中移除该键，并在 `fw-api.service` 注释与 [文档一致性核对报告](./docs/95-doc-audit.md) L-05 记录收口结论。

## [0.3.0] - 2026-10-14

> 发布说明与验收证据见 **[v0.3.0 发布验收报告](./docs/90-release-v0.3.0.md)**。
> 本版聚焦「真机可用性收口」：管理后台前端缺陷、路由与登录态生命周期、C-06 契约、部署路径。

### Fixed（管理后台前端：文档标注「已交付」但真机不可用/不可点的 15 项缺陷，2026-10-14）

> 逐页核对 [PRD-005](./docs/prd/prd-005-admin-template.md) + [原型 §3 页面清单](./docs/25-ui-prototype.md) 与 `apps/admin-web/src`，
> 发现上一轮的验收是**在 mock 上完成的**：mock 自建了一套后端并不存在的权限码（`dict:create/update/delete`），
> 菜单形状也与后端种子不同（mock 有队列管理、有订单列表，种子没有；种子却有一条指向不存在视图的死链菜单）。
> 结果是 6 项 P0 里 5 项只在真机暴露。本轮全部按「前端 + 后端小改 + 种子」三层修复，并补冒烟回归。
> 完整清单（现象 / 触发条件 / 根因 / 修复后预期行为 / 交互与数据展示要求 / 兼容性）见
> **[管理后台功能补充与缺陷修复方案](./docs/99-admin-web-enhancement-and-fixes.md)**。

- **`CrudTable` 操作列整列消失（审计「详情」不可达）**：`v-if` 只认 `formFields`/`canDelete()`，而审计页无表单、
  `audit:delete` 权限码不存在 → 字段级 diff 入口永久消失（违反 PRD-005 AC6）。改为同时探测 `actions-extra` 插槽。
- **字典项维护按钮永不渲染**：`permission="dict"` 推导出 `dict:create/update/delete`，后端权限常量只有 `dict:read`/`dict:write`。
  新增 `permissionActions` 显式覆盖动作码，字典项与分类统一绑定 `dict:write`。
- **生成器产出页面菜单不可达**：`fw gen crud` 写库 `component: 'views/<model>/index'`（相对 `web/src`），
  而前端只按「views 相对路径」拼候选 → 解析失败被静默跳过。解析前归一化（`src/`、`views/` 前缀与 `.vue` 后缀），
  两种约定同时兼容；并加单测护栏。
- **真机队列管理页不可达**：M7 只补了 `system:queue:list/manage` 权限点，未补 `/system/queue` 菜单，
  而动态路由完全由菜单树生成 → 无菜单即无路由。种子补菜单（`docs/99` §3 BUG-04）。
- **个人中心保存资料必失败**：前端借 `PUT /users/:id`（需 `user:update`）保存、`GET /users/:id`（需 `user:read`）回显，
  普通角色（仅 `auth:me`+`user:read`）回显为空且保存 `3002`。新增 `GET/PUT /api/v1/auth/profile`（仅需 `auth:me`）：
  GET 回显 `phone`/`email`，PUT 白名单只收 `nickname/phone/email`（`username`/`status`/`roleIds` 拒收，防自助提权），
  手机/邮箱冲突 `1003`；mock 与 C-06 契约同步。
- **越权按钮可点**（用户页分配角色/重置密码/启用禁用、菜单页增删改、字典分类增删改、队列暂停恢复、个人中心下线设备）：
  按服务端真实权限码补齐 `v-permission`，无权限不渲染。
- **用户表单 `roleIds` 类型错**：数组字段被渲染成单选 → 编辑回显为空、提交成字符串（服务端要求字符串数组 `1001`）。
  新增 `FormField.multiple`，`roleIds` 改多选；`number` 字段初值由空串改 `undefined`。
- **`keep-alive :include="[]"` 恒不缓存**（与组件注释矛盾，切回标签重复请求）：改为 `:max="12"` LRU，键取 `fullPath`。
- **隐藏菜单仍出现在侧边栏**：后端 `/auth/menus` 不按 `visible` 过滤，前端只过滤了顶层 → `visibleMenus()` 改递归剪枝。
- **死 UI「导出」**：审计页 `/audit-logs/export` 未实现（api-spec 已标 Backlog）却挂了按钮；用户页只弹提示。
  后端就绪前移除按钮，`CrudTable` 的 `export` 事件钩子保留。
- **字典标签在无 `dict:read` 角色下净失败**：`/dict/:code` 实际需 `dict:read`（api-spec 原标「登录后」）。前端无权限时
  短路不发请求并降级显示原值；普通用户角色补 `dict:read`；api-spec §3.6 标注更正。
- **死链菜单「订单退款」**：种子指向不存在的 `views/order/refund`，且后端无 `/api/v1/orders`（订单页仅存在于 mock）。
  移除该菜单整支，业务菜单示范由 `/demo-items` 承担（`order:read`/`order:refund` 权限点保留）。
- **批量删除假成功**：逐条删除但只 `catch` 首个错误、失败也弹「删除成功」且不刷新。改为累计成功/失败数并区分
  `success`/`warning`，无论成败都刷新列表并清空选择。
- **真机/mock 契约漂移**：mock 新增 `GET/PUT /auth/profile`；`DELETE /auth/sessions/:id` 补 `auth:revoke-session` 校验
  （此前 mock 放行、真机 `3002`）。

### Fixed（管理后台前端：路由与登录态生命周期 4 项缺陷，含反向验证，2026-10-14）

> 用户在真机上报告「点进具体功能页后侧边栏消失」。顺着「布局是否在匹配链上」这条线索排查，
> 一并暴露了 403 判定死代码、mock 行为与后端不一致、以及登出换号后仍是上一个账号的菜单/路由。
> 四项均已修复并补 16 条护栏；**每条护栏都做过反向验证（撤掉修复后必须 FAIL）**，避免假绿。
> 详见 [管理后台功能补充与缺陷修复方案](./docs/99-admin-web-enhancement-and-fixes.md) §3 BUG-16~19。

- **点进具体功能页后侧边栏（连带顶栏、标签页）整块消失（P0）**：动态路由被 `router.addRoute(route)` 注册成**顶层记录**，
  匹配链 `["/system","/system/users"]` 里没有布局路由 → 渲染的是 `views/layout/blank.vue`（只有一个 `<router-view/>`），
  全局布局根本没挂载。新增 `src/router/inject.ts`，统一以 `router.addRoute('Layout', record)` 挂到具名布局路由之下，
  匹配链变为 `Layout → /system → /system/users`；同路径记录去重（`/dashboard` 保留静态记录）；`/redirect` 一并移入布局内，
  标签页「刷新」不再卸载外壳。
- **无权限看不到 403，落的是 404（P1）**：兜底路由注册后 `router.resolve()` 对任何路径都有非空 `matched`，
  故 `if (resolved.matched.length > 0) return true` 恒成立，其后的「已知系统路径 → 403」是**不可达死代码**。
  抽出纯函数 `resolveFallback(path, matchedNames)` 按「是否命中兜底记录」判定，403 与 404 从此可区分（并可直接单测）。
- **登出后换号登录，侧边栏与路由表仍是上一个账号的（P0）**：守卫判据只有 `!permission.routesAdded`，而 `routesAdded`
  登出后从未复位（`permission.reset()` 在生产代码中**没有任何调用点**）→ 换号后「加载菜单 + 注入路由」整步被跳过；
  且动态路由不会随登出出表。改为按「菜单所属用户 id」判定并重建（`menusOwnerId`），重建时先 `removeRoute` 移除上一轮注入的
  记录，使上一个账号的路径彻底出表、直输 URL 落 403（对齐 `TC-WEB-001`）。
- **mock 的 `GET /auth/menus` 多做了一层 `visible` 过滤（P2）**：真实后端只按权限码过滤、可见性由前端剪枝，
  mock 抢先过滤会让前端剪枝路径在 dev 下**永不执行**（「mock 全绿、真机炸」的温床）。mock 与后端行为对齐；
  `订单中心` 标注为 mock-only 演示菜单（生产种子已移除该分支）。
- **换号后标签页仍列出上一个账号开过的标签（P2）**：标签持久化键 `fw_admin_tags` 被所有账号共用，
  既不隔离也不清理。改为 `fw_admin_tags:<用户 id>` 并随登录用户切换（换号即读到该账号自己的集合）；
  刻意不做旧键迁移（无法判断标签归属，迁移等于把上一个账号的标签泄露给新账号）。同时修正装配顺序：
  `restore()` 须在持久化 watcher **之后**执行，否则初始状态不写回本地（刷新即丢标签）。

### Fixed（工作台对低权限账号刷 403 且把无权指标显示成 0，2026-10-14）

> 真机浏览器实测暴露（**非本轮引入**，`views/dashboard/index.vue` 自 v0.1.0 起未改动；但属已识别的可动手缺陷，
> 与本轮已修的字典短路降级是同一模式，故一并修掉）。

- **现象**：以 `alice`（仅 `user:read` + `dict:read`）登录，工作台必然产生 3 条 `403`
  （`GET /permissions`、`/roles`、`/audit-logs?pageSize=1`）；更严重的是把**无权读取的指标显示成 `0`**
  —— `0` 与「真实为 0」无法区分，属误导；「常用入口」还列出无权进入的页面，点进去 403。
- **根因**：工作台**无条件** `Promise.all` 拉四个端点，失败一律 `.catch(() => null)` 后回落成 `0`；
  常用入口是写死的三条、不看权限。
- **修复**：① 每个指标按其**后端守卫权限码**决定是否请求（`/users`→`user:read`、`/roles`→`role:read`、
  `/permissions`→`permission:read`、`/audit-logs`→`audit:read`），无权端点**不发请求** → 不再产生 403；
  ② 统计卡三态化（加载中 / 有值 / **取数失败显示「—」**）；③ 常用入口按权限过滤；
  ④ 一个指标都不可读时给出明确说明而非渲染空卡片。
- **护栏**：新增 `src/views/dashboard/__tests__/dashboard-permission.test.ts`（5 条），前端单测 55 → **60**；
  反向验证：撤掉权限过滤 → 3 条 FAIL。真机复测：浏览器端到端 26/26 且**全程 0 条 4xx**。

### Fixed（真机验证：静态路由表重名僵尸记录 + 清理，2026-10-14）

> 真机验证前置核对时发现：上一轮「`/redirect` 从顶层移入布局内」只做了一半 —— 新增了布局内记录，
> 却**漏删顶层同名记录**，同一 `path`/`name` 注册两次。vue-router 注册时会静默移除先者，
> 运行时看不出问题，只留一条永远不可达的僵尸定义，且与文件注释自相矛盾。

- **`src/router/routes.ts`**：删除顶层 `/redirect` 记录，仅保留布局内那一条；
  `/redirect` 在静态表中恰好出现 1 次由单测锁定。
- **回归护栏（含一次自我纠错）**：新增「静态路由表内不得存在同名或同路径记录」断言。**首版写在
  `router.getRoutes()` 上是假绿** —— 实测故意加回重名后它仍然通过（vue-router 已静默去重），
  改为断言静态定义表 `constantRoutes` 本身后：加回重名 → FAIL、去掉 → PASS。

### Added（真机菜单数据 × 真实路由管线：夹具驱动集成护栏，2026-10-14）

> 本仓库反复被「mock 形状 ≠ 真机形状」咬到（本地全绿、部署后才炸）。本组护栏用**真机实际数据**
> 跑**真实管线**，把这类缺陷前移到单测阶段。

- 新增夹具 `apps/admin-web/src/router/__tests__/fixtures/real-menus.json`：2026-10-14 从真机
  `GET /api/v1/auth/menus`（admin）**原样转储**的响应 `data` 段，非手写 mock。
- 新增 `apps/admin-web/src/router/__tests__/real-menus.test.ts`（6 条）：每个菜单页都命中自身路由记录
  （无静默跳过）、匹配链必须以布局路由开头、目录类节点三层嵌套、生成器写法的
  `views/<model>/index` 两层嵌套、与静态路由重名的 `/dashboard` 只保留一条。断言只依赖结构关系、
  不依赖菜单条数，故种子调整不会使其变脆。前端单测 49 → **55**（含工作台权限护栏后为 **60**）。

### Verified（真机端到端：`106.55.32.251` / `https://cs.donttemo.top`，2026-10-14）

- **前端专用发版**：`git archive` 打包 → `/opt/fw/web-fix/<ts>` 装依赖并构建（显式注入 `VITE_API_BASE_URL=/api/v1`）
  → 产物断言 → `rsync -a --delete` 到 `/opt/1panel/www/fw-web`（41 → 41 文件，旧分片已清）。
  入口分片由 `index-CZavIGkr.js` → `index-ro_5WPJ_.js` → `index-DwAhQZFw.js`（第二轮含工作台修复）；
  **后端未改、未重跑种子、未重启服务、未动 `/opt/fw/current`**。
- **数据面验收** `wb-ssh/verify-webfix7.sh`：**24/24**（站点 200、`POST /auth/login` 仍 405、`/ready` ok、
  菜单树 8 条路径齐全且已无 `/order` 死链、`/auth/profile` 可达、产物中的 TagsView 为按用户隔离键的新版）。
- **全量回归** `wb-ssh/verify-c06.sh`：**27/27**，无回退。
- **真实 Chromium 端到端**：**26/26，且全程 0 条 4xx** —— 点击「系统管理 → 用户管理」后侧边栏/顶栏/标签页全部在位
  （侧边栏实测 200px）；6 个功能页直输 URL 均正确渲染；admin（已积累 7 个标签）→ 退出 → alice 登录后，侧边栏只剩
  `控制台 / 系统管理 / 用户管理 / 字典管理`（admin 独有菜单全部消失）、标签页只剩「工作台」；全程无 JS 运行时报错。
  **本机直连该 IP 的 443 会被本地网络重置**，测试网络经 `ssh -D` 动态转发从远端出网。截图见 `wb-ssh/shots/`。
  详见 [方案文档 §8.1](./docs/99-admin-web-enhancement-and-fixes.md)。

### Added（管理后台前端：方案文档与验证）

- 新增 **[管理后台功能补充与缺陷修复方案](./docs/99-admin-web-enhancement-and-fixes.md)**：逐页现状核对、待新增模块
  （租户管理页 / 异步导出任务中心 / 403 整页视图）与待完善模块（字典消费、菜单图标与权限码选择器、审计模块字典化）、
  **22 项缺陷表**、交互流程与数据展示规范、兼容性要求、验证证据与遗留项。
- 新增 `apps/admin-web/src/router/__tests__/layout-nesting.test.ts`：16 条路由/布局护栏 —— 匹配链必须含布局、
  静态路由去重、`/redirect` 在布局内、公开页无外壳、**真实挂载出 `.fw-sidebar`**、换号后旧页面落 403、
  `resolveFallback` 三个分支、静态路由表无重名。前端单测 31 → **49**（含真机菜单数据集成护栏与工作台权限护栏后为 **60**）。
- `apps/admin-web/scripts/smoke-mock.mjs`：新增「个人资料自服务」冒烟段 8 条断言（含 `409`/`1001`/越权字段拒收/
  「alice 可自助保存」回归）；冒烟总数 57 → **65（全通过）**。
- `apps/admin-web/src/store/__tests__/permission.test.ts`：新增 2 条回归护栏（`visibleMenus` 递归剪枝、
  生成器 `views/<model>/index` 可解析）；单测 **31 通过**。
- `docs/40-api-spec.md` §3.2 新增 `GET`/`PUT /auth/profile`；`docs/contracts/api-web.ts` 新增
  `ProfileResult` / `ProfileUpsertInput`。

### Fixed（角色/权限分派缺写库前校验：`roleIds:[""]` 静默写库可致用户权限归零，2026-10-14）

> 真机写端验收时，验收脚本取「admin 角色 id」的表达式失效返回空串，`PUT /users/:id` 载荷变成
> `{"roleIds":["","<探针角色>"]}`——接口返回 `code:0`，随后 admin 对**所有**端点返回 3002。
> 根因是产品缺陷而非脚本问题：`replaceUserRoles` / `replaceRolePermissions` 都是「先 deleteMany 再 create」的
> 全量覆盖，**入参没有任何校验**；而 `user_role.role_id` 是裸 `String` 且 schema 无外键关系，
> 空串在 SQLite / PostgreSQL 上都能静默插入。用户的角色集于是被替换成「无效关联」，
> 权限聚合直接归零，且从接口侧完全看不出是数据损坏。同类风险同样存在于角色授权（`permissionIds`）。

- **`@fw/auth` `AuthService`**：新增 `assertRoleIds` / `assertPermissionIds`——非空串、去重、
  全部存在且未软删（`listRoles()` / `listPermissions()` 走仓储层已过滤 `deleted_at`），
  不过校验即抛 `1001` 并列出未知 ID；`assignUserRoles` 与 `grantRolePermissions` 在写库**前**调用，
  把「静默数据损坏」变成「明确参数错误」。
- **`example-api` `users.controller.ts`**：`POST /users` 建号即带角色的路径同样补校验
  （原先直接调 `store.replaceUserRoles`，绕过了服务层）。
- **回归护栏**：`packages/auth` 单测 +3（空串拒绝、不存在 ID 整批拒绝、写库不执行既有角色原样保留；
  权限侧同源三例）；`smoke-admin.mjs` +3（`PUT /users/:id` 空串/不存在角色 ID → 1001，
  `PUT /roles/:id/permissions` 空串权限点 ID → 1001）。
- **真机修复**：备份三表后单事务重建 admin 角色关联、清除探针角色与测试残留，
  并按 `auth:perm:*` 精准失效 Redis 权限缓存（不等 60s TTL）；修复后 27/27 验收全绿。

### Fixed（C-06 契约收口：前端按契约全量调用、后端只实现演示子集，接入真实 API 后 25 个端点集体 404，2026-10-14）

> 域名上线后点管理后台页面，浏览器接连报 `Cannot GET /api/v1/auth/sessions`、`Cannot GET /api/v1/users/:id`、
> `Cannot GET /api/v1/dict/data_scope`。根因不是新引入的回归，而是**架构性缺口**：
> 本仓库采用「契约先行 + mock 顶上」的并行开发（[85-parallel-workstreams](./docs/85-parallel-workstreams.md) §4）——
> C-06 契约冻结于 M5，前端 `admin-web` 与 `mock/handlers.ts` 按契约**全量**实现，而后端 `example-api` 只落地到
> 「M3/M8 演示可验证」深度。两侧各自的门禁都是绿的（前端 29 单测 + 40 冒烟走 mock，后端冒烟走已实现路由），
> 于是「契约声明、mock 有、后端未注册」的端点**没有任何一道检查会发现**，只在接真实 API 后才 404。
> `docs/40-api-spec.md` §3 与 `docs/30-data-dictionary.md` §3.11/§3.12 其实早已写明这些端点与表，
> 缺的从来不是文档，是**实现**与**两侧对撞的门禁**。

- **补齐 25 个契约声明但后端未注册的端点**：
  - `GET/DELETE /auth/sessions[/:id]`：登录设备列表与下线。语义为「一个刷新令牌轮换族 = 一台设备」，
    族内多条是正常轮换结果；下线前先确认该族属于当前用户（防越权踢他人），再整族撤销。
  - `GET /audit-logs/:id`：审计详情，`dataScope` 与列表同源收敛（`self` 档范围外一律 404，不泄露存在性）。
  - `GET /menus/tree` + `POST/PUT/DELETE /menus`：菜单维护。与 `/auth/menus` 的分工是
    「全量配置用」vs「当前用户可见（按权限过滤，供动态路由）」；有子菜单时拒绝删除，避免层级悬空。
  - `GET /dict/categories|items` + `POST/PUT/DELETE` + `GET /dict/:code`：字典模块（PRD-005 FR-07）。
    `dict/:code` 是 `useDict()` 的消费入口，编码不存在返回**空数组而非报错**——否则页面首次渲染即失败。
  - `GET /users/:id` + `POST /users` + `PUT /users/:id` + `DELETE /users/:id` + `POST /users/:id/reset-password`：
    用户维护。密码走后端强校验（不信任前端强度判断）；账号不可改（登录与审计锚点）；
    重置密码返回一次性密码并**同时失效该用户全部登录态**。
  - `POST /roles` + `PUT /roles/:id` + `DELETE /roles/:id` + `POST /roles/:id/copy`：角色维护。
    编码不可改、内置角色不可删也不可调窄数据范围（保证超管始终 `all`）、仍有用户持有时拒绝删除；
    复制角色连同 `role_permission` 一起复制。
- **列表返回补齐契约字段**：`GET /users` 与 `GET /roles` 此前返回的是 `AuthUser`/`AuthRole` 原始形状，
  缺 `roleIds` / `createdAt`（用户）与 `permissionCount` / `remark` / `sort`（角色）——C-06 契约 §3.3/§3.4 要求列表带这些字段
  （分配角色弹窗预选、授权页展示都依赖它们）。现改为批量投影（一次关联查询，避免 N+1）。
- **`@fw/auth` 新增 `AuthService.invalidateUsersOfRole()`**：角色**资料**变更（如 `dataScope`）不写
  `role_permission`，不走 `grantRolePermissions` 的缓存失效路径，已登录用户会继续持旧数据范围。
  新增该方法供角色更新端点调用（纯新增，不破坏既有契约）。
- **新增权限点 `dict:read` / `dict:write` / `auth:revoke-session`**（随种子建出并授予 admin，权限点 28 → 31）。

### Fixed（软删不释放唯一键：同名账号 / 同编码字典永远无法重建，2026-10-14）

> 冒烟脚本连续第二次运行即失败：`POST /users` 对已软删的 `smoke_probe_user` 返回 409，
> `POST /dict/categories` 对已软删的 `smoke_probe` 同样 409。这不是测试问题，是**真实业务缺陷**：
> 软删行仍在表内，继续占用 `username` 与 `dict_categories.code` / `(category_id, value)` 唯一约束——
> 表现为「人员离职后重新入职」或「字典停用后想复用原编码」直接撞 409，且错误信息无法指出真实原因。

- **`PrismaAdminStore.softDeleteUser()`**：软删时给 `username` / `phone` / `email` 追加重删后缀释放唯一键
  （已释放过的跳过，重复调用幂等；审计仍可按原 id 追溯）。
- **`PrismaAdminStore.deleteDictCategory()` / `deleteDictItem()`**：同样释放 `code` 与 `value` 唯一键，
  删分类时连带释放其下所有字典项。

### Added（前后端接口对撞门禁 + 管理后台端点冒烟，2026-10-14）

- **`scripts/check-api-parity.mjs`（`pnpm run check:api-parity`，已接入 CI base 作业）**：
  把**前端调用面**（`apps/admin-web/src` 下所有 `request.<method>('<path>')`，模板串归一为占位段）
  与**后端路由面**（全仓 `*.controller.ts` 的 `@Controller` 前缀 + 方法装饰器）逐一对撞。
  前端调了而后端没注册 → **失败**（这正是线上 404 的直接来源）；后端有而前端未调用 → 仅提示
  （演示 / 运维端点本就不该被前端调）；路径首段即变量的动态调用（如 `<CrudTable>` 的 `props.api`）
  单独归类，不计入缺口。已用临时探针反向验证：注入一个不存在的调用即使脚本退出码变 1。
- **`apps/example-api/scripts/smoke-admin.mjs`（72 条断言，已接入 CI）**：逐个验证上述补齐端点，
  含越权面（最小权限角色对每类写操作均应 3002）、唯一键释放、软删后同名可重建、
  重置密码后旧口令失效、被下线设备的 refresh 立即失效、内置角色保护等。
  断言遵循「形状 + 下界 + 关键权限码」，不与种子总数耦合；所有写操作只用临时实体并清理。
  连续运行三次均 72/72（另：登录限流 60 秒 10 次会被连续跑打满，脚本识别 429 后明确退出而非输出一堆假失败）。
- **数据模型**：`prisma/schema.prisma` 与 `prisma/pg/schema.prisma`（模型段逐字节一致）新增
  `dict_categories` / `dict_items`；迁移 `20261014112810_add_dict_tables` 两个方言各一份；
  种子新增字典基线四类（`user_status` / `data_scope` / `audit_action` / `order_channel`，
  与前端真实消费点一一对应）与「菜单管理 / 字典管理」两个菜单项。
- **文档**：`docs/40-api-spec.md` §3.2 补登录设备端点、§3.4/§3.7 给两个未实现端点标注 Backlog、
  §6 记录接口对撞门禁；`docs/30-data-dictionary.md` §3.11/§3.12 按现行「字符串主键、框架表不带租户」约定重写
  （原文档是 bigint + `tenant_id` + `is_default` 的旧约定残留），ER 图同步。

### Fixed（前端队列管理两个端点路径缺少 `admin/` 前缀，2026-10-14）

> `apps/admin-web/src/api/queue.ts` 的 `tickCron` 与 `requeueDeadLetter` 请求 `/queue/...`，
> 而后端 `QueueAdminController` 挂在 `/api/v1/admin/queue`——同样是必然 404，且因为队列页面能打开、
> 只有点「手动触发 / 重放」才炸，属于典型的「页面绿、操作红」。现补齐前缀，产物已复验含
> `admin/queue/crons` 与 `admin/queue/dead-letters`。

### Fixed（HTTPS 上线后暴露：生产前端构建缺 API 基址导致登录 405，2026-10-14）

> 域名 `cs.donttemo.top` 走 Let's Encrypt HTTPS 后，浏览器登录返回 **405 Not Allowed**。
> 根因：`apps/admin-web/.env.production` 被 `.gitignore` 的 `.env.*` 规则排除，而 release 取自
> `git archive`（只含跟踪文件）→ 服务器构建时 `VITE_API_BASE_URL` **缺失** → axios `baseURL` 退化为
> `undefined` → 请求变成 `/auth/login` 同源相对路径，被静态站接管，nginx 对静态资源拒绝 POST。
> 实测证据：部署产物中 `/api/v1` 出现 **0 次**，`POST /auth/login` 返回 405 而 `POST /api/v1/auth/login` 返回 201。

- **`apps/admin-web/src/utils/request.ts`**：API 基址增加同源 `/api/v1` 兜底（`import.meta.env.VITE_API_BASE_URL ?? '/api/v1'`）。
  这是本缺陷的**根因修复**——构建输入缺失时按同源反代约定工作，而不是静默产生错误请求路径。
- **`apps/admin-web/src/utils/token.ts`**：令牌存储开关由「`VITE_API_BASE_URL` 是否已定义」改为专用
  `VITE_AUTH_STORAGE`（**默认启用**，置 `none` 关闭）。原实现把无关变量当环境哨兵，同一根因下会**连带**
  关闭令牌本地存储，表现为「记住我」失效、刷新页面即掉登录——即在 405 之外还埋了一个同源的次生缺陷。
- **`apps/admin-web/env.d.ts` / `.env.example`**：声明并文档化 `VITE_AUTH_STORAGE`。
- **`apps/admin-web/vitest.config.ts`**：移除已无必要的 `test.env` 注入（改用默认值后，测试不再依赖任何 env 变量）。
- **`deploy/scripts/bare-metal-deploy.sh`**：前端构建**显式注入** `VITE_API_BASE_URL`（新增 `WEB_API_BASE`，默认 `/api/v1`），
  并在构建后**断言产物确含该基址**——缺失即中止发布。这是一道新的发布闸门：杜绝「站点能打开但登不进去」的版本上线。

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
- **三大关键演练与终验（T-M8-08）**：新增 `apps/example-api/scripts/drill-m8.mjs`（可复跑，远程段落门控）与 `apps/example-api/scripts/bench.mjs`（压测基线）；产出 `docs/archive/m8/96-m8-drills.md`（演练记录 + PRD-008 §7 七条 AC 判定 + 遗留）、`docs/archive/m8/97-bench-baseline.md`（登录/列表/写入三类场景 QPS 与 P95）、`docs/98-scale-checklist.md`（规模化上线自检清单，FR-10）。

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
- **压测基线（T-M8-08，FR-11）**：`node scripts/bench.mjs` 三类场景——登录 `QPS 10.2 / P50 191.62ms / P95 255.65ms`（第 11 次返回 429，登录限流 60s/10 次生效）、列表查询 `QPS 561.8 / P50 16.17ms / P95 27.69ms`、写入 `QPS 37.5 / P50 26.46ms / P95 434.09ms`（SQLite 写锁串行长尾）；报告见 `docs/archive/m8/97-bench-baseline.md`，原始数据 `docs/bench/bench-latest.json`。
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
- **TC-JOB-008 已通过（2026-10-13）**：真实 Redis 失速恢复演练通过并固化进冒烟阶段 F；演练暴露并修复两个 `@fw/queue` 缺陷（`register` 未建消费器导致新进程无失速检查器、`ensureWorker` 自递归死锁与同队列重复建），记录见 `docs/archive/queue/94-queue-stall-drill.md`。

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

- 新增 [`docs/archive/database/93-db-connectivity-switch-test.md`](docs/archive/database/93-db-connectivity-switch-test.md)：连通/鉴权实测（含 PG SCRAM-SHA-256 完整握手）、三库矩阵结果、键空间独立核验、发现与修复、遗留 T-01~T-05。
- [`docs/archive/database/92-test-databases.md`](docs/archive/database/92-test-databases.md) 增补 §5 执行记录（实测服务端版本、`framework_test` 创建、大小写归一与批量造数注意事项）。
- 验收总纲遗留 **R-01（三库矩阵与数据库切换演练）** 完成实测闭环、**R-07（真实 Redis）** 完成 standalone 部分闭环（Cluster 留待 M8）。

### Fixed

- 修复动态路由子路径拼接缺陷：菜单全路径（如 `/system/users`）曾直接作为子路由相对路径，导致 `/system` 下的用户页拼成 `/system/system/users` 无法命中；现按父级前缀换算相对路径（单测回归护栏）。
- 修复 CrudTable 非分页接口响应兼容：接口约定返回裸数组，现兼容误包 `{ items }` 的响应，避免 el-table 拿到非数组崩溃。

### Fixed（v0.2.0 发布前验收修复，2026-10-14）

- **CI 纳入 `@fw/tenant`**：M8 T-M8-01 新增该包时漏加构建与覆盖率循环（`@fw/transport` / `@fw/telemetry` 已纳入），干净环境下 `example-api` 取不到其 `dist` 会构建失败；同时补入「M8 多租户端到端冒烟」步骤（`smoke-tenant.mjs`）。详见 [v0.2.0 发布验收报告](docs/archive/release/90-release-v0.2.0.md) §5 F2-01/F2-03。
- **`@fw/tenant` 覆盖率补齐**：`tenant.middleware.ts`（9.52%）与 `tenant.module.ts`（46.15%）原仅由端到端冒烟覆盖，包整体 lines 71.42% / functions 56% 低于 85% 门禁；补中间件 9 项 + 模块装配 5 项单测后达 **99% statements / 98.9% lines**（用例 19 → 33）。
- **应用自报版本**：`apps/example-api` 的 `/api/v1/demo/ok` 返回值由 `framework: 'v0.1.0'` 更新为 `'v0.2.0'`。

## [0.1.0] - 2026-10-13

> 首个可运行版本。含 M1 核心骨架、M2 数据库抽象层、M3 鉴权与权限、M4 缓存层。
> 门禁与验证证据见 [v0.1.0 发布验收报告](docs/archive/release/90-release-v0.1.0.md)。

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
| `v0.6.0`（已发布 2026-10-17） | M11–M12：认证核心强化五阶段（Rotation CAS / 双 Key Ring / 指纹 / 生命周期 / 运维端点）+ 可观测与运维边界（审计契约 / 错误族收敛 / 双 ID / 指标段 / 三层边界）+ @fw/cache 缺陷修复 13 项与双驱动契约测试 | PRD-011、PRD-012 |
| 待规划 | 内容/门户模板、文件存储抽象、消息通知、开放平台网关、国际化 | PRD 索引「待规划」 |

> 版本号随里程碑推进可能合并或拆分，以实际发布内容为准。
