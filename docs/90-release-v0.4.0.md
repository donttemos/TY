# v0.4.0 发布验收报告

> 版本：**v0.4.0** ｜ 发布范围：**M9 配置中心与热更新（PRD-009）全量落地 + 管理面功能补齐**（N-01 租户管理 / N-02 异步导出任务中心 / 列表排序收口 / 死信分页 / E-06·E-07 体验增强 / L-05 文档一致性） ｜ 验收日期：2026-10-15 ｜ 验收人：donttemo（L0 编排）
> 依据：[验收标准](./10-acceptance-criteria.md) §2 完成定义、§3 里程碑门禁、§4 非功能与安全基线、§7 验收流程；[PRD-009](./prd/prd-009-config-center.md) §7 AC
> 关联：[v0.3.0 发布验收报告](./90-release-v0.3.0.md) ｜ [文档一致性核对报告](./95-doc-audit.md)（P0 行动项即本版发版） ｜ [60 部署运维手册](./60-deployment-ops.md) ｜ [62 1Panel 真机手册](./62-1panel-real-deploy.md)

## 1. 发布物与范围

v0.3.0 收口「真机可用性」后，M8 终验留下的最后一个**需求级缺口**是配置中心（L-02 / FR-08）。
本版将其全量落地（M9 / PRD-009），同时把积压在 `Unreleased` 的三轮迭代（N-01 / N-02 / BUG-15 收尾 / 死信分页 / E-06·E-07 / L-05）一并收敛为正式版本。

| 变更域 | 内容 | 依据 |
|---|---|---|
| `packages/config-center`（**新增第 15 包**） | `ConfigCenterPort` + 本地 file 适配（mtime 轮询 + 原子写）+ 单一生效管道（校验 → 审计（先审计后生效，失败整体回滚）→ 持久化 → 应用覆盖 → 通知订阅者）+ fail-keep / fail-fast 语义 | [PRD-009](./prd/prd-009-config-center.md) |
| `packages/config` | env 键注册表 `ENV_KEY_PATHS`（65 键全量登记）+ 热更新白名单 `ENV_HOT_KEYS`（11 键，boot 键禁入）+ `CONFIG_CENTER_*` 4 键 + 完整性护栏单测（防键集漂移） | PRD-009 §4 |
| `packages/cache` / `queue` / `telemetry` / `tenant` | 运行时热更入口 `updateRuntimeOptions`（PRD-009 FR-09，经 `onChange` 订阅，禁止自行轮询） | PRD-009 FR-09 |
| `apps/example-api` | **N-01** 租户管理五端点（`GET/POST/PUT/DELETE /tenants`、`POST /tenants/:id/migrate`，`@IgnoreTenant` 豁免 + `system:tenant:ignore` 与权限码）；**N-02** `JobCenterService` + `/jobs/:id/progress|retry|download` 任务面 + `GET /audit-logs/export` 派发；**M9** `GET /api/v1/configs`、`PUT /configs/:key` + 5xxx 错误码段（5001/5002/5003）；roles / dict / users / audit-logs 四面接入 `parseSortQuery` 排序白名单；死信列表分页 `pageDeadLetters` | [40-api-spec](./40-api-spec.md) §3.7 / §3.9 / §3.10 / §1.5 |
| `apps/admin-web` | 「系统管理 → 租户管理」「系统管理 → 参数配置」两个新页 + 页脚任务条（`useJobCenter` + `JobBar`）+ E-06 图标/权限码选择器 + E-07 审计模块字典化 + users / audit / roles / dict 排序列 | [docs/99](./99-admin-web-enhancement-and-fixes.md) |
| `apps/example-api/prisma/seed.ts` | **+10 权限点**（`audit:export`、`tenant:read/create/update/delete/manage/ignore`、`system:config:read/write`）、**+2 菜单**（租户管理 `/system/tenants`、参数配置 `/system/configs`）、**+3 字典**（`audit_module`、`tenant_isolation`、`tenant_status`） | — |
| `deploy/` 与文档 | 移除无效 `LOG_FORMAT` 键（L-05）；7 份点时性文档归档至 `docs/archive/<模块>/`；PRD 索引与文件头状态订正 | [95-doc-audit](./95-doc-audit.md) |
| `packages/*` 其余 | 无 API 变更；版本号随全仓统一升至 0.4.0 | — |

**明确排除（登记为遗留）**：L-01 真实 K8s 集群部署冒烟、L-04 Redis Cluster 实跑、M9 Backlog（tenant-scoped config / 一键回滚 API / Nacos adapter 示例）、N-03 整页 403 视图（见 §6）。

## 2. 版本与升级影响

| 项 | 说明 |
|---|---|
| 版本号 | 全仓 **15 个** `package.json`（根 + 12 框架包 + 2 应用）统一 `0.3.0 → 0.4.0`；`workspace:*` 引用无需改动 |
| 破坏性变更 | **无框架 API 破坏性变更**；升级动作见下两行 |
| ⚠️ 种子语义变更 | 新增 10 权限点 + 2 菜单 + 3 字典。菜单与权限码是**登录时快照** → 升级后**必须重跑 `db:seed` 并让所有用户重新登录**，否则新页面 403 / 旧快照缺菜单。`db:seed` 是清场重建，**用户/角色/菜单 ID 全部改变**（断言与自动化请按用户名/编码查 ID） |
| ⚠️ 前端必须重建 | 新增页面视图（`system/tenants`、`system/configs`）与任务条组件 → 只跑 seed 不更新前端产物会出现**死链菜单**（本项目第 3 号教训）；前后端须**同批发版** |
| 配置键 | **新增 4 键**：`CONFIG_CENTER_ENABLED`（默认 `false` = 零开销）/ `CONFIG_CENTER_DRIVER`（首版仅 `file`）/ `CONFIG_CENTER_FILE`（默认 `./config/runtime.json`）/ `CONFIG_CENTER_POLL_SECONDS`（默认 5s），已入 `.env.example` 与 [60 手册](./60-deployment-ops.md)；**移除 1 键**：`LOG_FORMAT`（L-05，声明但从未被消费，按「配置诚实原则」移除；留着不报错也无行为，属误导） |
| API 变更 | 新增 `/api/v1/configs`（GET/PUT）、`/api/v1/tenants` 五端点、`/api/v1/jobs/:id/progress|retry|download`、`GET /audit-logs/export`（异步派发）；`/users`、`/roles`、`/dict/*`、`/audit-logs` 新增 `sort` 查询参数（白名单外 `400/1001`）；新增 **5xxx 错误码段**（5001 不可热更 / 5002 值非法 / 5003 键不存在） |
| 数据库 | **无新迁移**（`tenants` / 字典表 M8 已建）；`db:migrate` 应输出 No pending |

## 3. 发布门禁

### 3.1 完成定义（DoD）

| 条目 | 结果 | 说明 |
|---|---|---|
| 功能与 PRD 行为一致 | ✅ | PRD-009 §7 AC 全量验证（双入口生效 / 三类拒绝 / fail-keep / 审计可见 / 越权面 / 未启用形态），`smoke-config` **27/27** |
| 新增单测 / 集成 / 端到端 | ✅ | 单测 **869 项**（12 框架包 788 + admin-web 81）+ 三库矩阵跳过段 12（按设计）；端到端冒烟 **264 项**（8 套）+ mock 全链路 **119 项**；M8 演练 12/12（4 项环境门控跳过） |
| 构建零错误 | ✅ | 16 项构建全绿（含依赖序重建）；`vue-tsc` / `tsc` 0 错误（CI 门禁内） |
| 注释中文 + 文件头完整 | ✅ | `check-file-headers.mjs` **420** 文件通过 |
| 无裸 SQL | ✅ | `check-no-raw-sql.mjs` **277** 文件通过 |
| 前后端接口对撞 | ✅ | `check-api-parity.mjs` OK（新增 configs / tenants / jobs 调用面全部有对应后端路由） |
| 部署清单语义 | ✅ | `pnpm run check:helm` **63/63** |
| 文档同步 | ✅ | README / CHANGELOG / 本报告 / docs/80 / PRD 索引已同步；归档改链经脚本校验 0 坏链 |
| 真机部署验收 | ✅ | `106.55.32.251` 发版 + seed 重跑 + verify 通过（见 §4.4） |

### 3.2 非功能基线

| 项 | 目标 | 本轮实测 | 判定 |
|---|---|---|---|
| 后台打包 `dist` gzip | ≤ 600 kB | **326.5 kB** | ✅ |
| `vendor-element-plus` gzip | ≤ 360 kB | **233.8 kB** | ✅ |
| 覆盖率 | 整体 ≥ 70%；auth/cache/db ≥ 85% | 12 个框架包 lines 均 ≥ 90%（CI `test:coverage` 门禁全绿） | ✅ |
| 登录接口 P95 | ≤ 300ms | 255.65ms（v0.2.0 基线，本轮未改动鉴权热路径） | ✅ |

### 3.3 安全基线

| 条目 | 结果 | 证据 |
|---|---|---|
| 越权：低权限账号无法读写管理面 | ✅ | `smoke-auth` 28/28（alice 访问 `/roles`、`/audit-logs` → 403/3002）；`smoke-admin` 含 alice 越权段（新建用户/角色/字典/菜单、下线设备 → 403/3002） |
| 配置热更越权面 | ✅ | `PUT /configs/:key` 需 `system:config:write`；boot 键 5001 / 白名单外键 5003 / 非法值 5002（信封顶层 details）；`CONFIG_CENTER_ENABLED=false` 时 PUT 一律 1004 |
| 租户管理豁免不放大 | ✅ | `/tenants` 整类 `@IgnoreTenant` 但要求**同时**持有 `system:tenant:ignore`（与 `tenant:*` 与关系），豁免动作写审计；legacy 存量单租户停用/迁移一律 1004 |
| 任务面不泄露存在性 | ✅ | 任务只验登录 + 归属人，他人任务 404；派发侧才由业务权限码把关（`audit:export` / `tenant:manage`）；审计导出仍受 `dataScope` 收敛 |
| 分派入参写库前校验 | ✅ | 沿用 v0.3.0 修复，冒烟回归覆盖 |
| 令牌与敏感字段不入日志 | ✅ | 冒烟 `log-sensitive` 通过；租户 `dbUrl` 落库前加密、仅进程内传递 |

## 4. 验证证据清单（本轮全部实跑）

> 本机沙箱（Windows，无 docker/redis）按 CI 同款步骤逐项复跑；MySQL/PG 集成矩阵与 Redis 段由 CI 服务容器覆盖（§4.5）。

### 4.1 类型检查与单测（逐包 `vitest run --no-file-parallelism`，2026-10-15 实跑）

| 包 / 应用 | 文件 | 用例 |
|---|---|---|
| `@fw/config` | 2 | **16** |
| `@fw/logger` | 2 | **17** |
| `@fw/core` | 1 | **18** |
| `@fw/config-center` | 2 | **34** |
| `@fw/db` | 7 通过 + 1 跳过 | **83**（+ 12 跳过：三库矩阵按设计在未设 `DB_DRIVER` 时整文件跳过） |
| `@fw/auth` | 12 | **111** |
| `@fw/cache` | 10 | **80** |
| `@fw/cli` | 10 | **116** |
| `@fw/queue` | 16 | **144** |
| `@fw/tenant` | 4 | **34** |
| `@fw/transport` | 8 | **82** |
| `@fw/telemetry` | 9 | **53** |
| **框架包小计** | 79 | **788 通过 + 12 跳过** |
| `apps/admin-web` | 10 | **81** |
| **合计** | — | ✅ **869 通过** |

### 4.2 端到端冒烟（本机 SQLite，逐套独立进程，与 CI 步骤一一对应）

| 套件 | 结果 | 说明 |
|---|---|---|
| `smoke-mock.mjs`（前端 mock 全链路 + 体积门禁） | ✅ **119/119** | 含 gzip 326.5 kB / 233.8 kB；N-01/N-02/排序/配置页 mock 与后端同构断言 |
| `smoke-auth.mjs` | ✅ **28/28** | 需外部服务监听 3000；含 3 条排序断言 |
| `smoke-admin.mjs` | ✅ **107/107** | N-01 租户管理 / N-02 任务面 / 配置端点 / 排序 / 越权面逐项验证（独立起服务，登录限流计数器隔离） |
| `smoke-cache.mjs` | ✅ 12/12 | 自带服务生命周期（3100） |
| `smoke-queue.mjs` | ✅ 22/22 | 本机无 Redis，redis 段按设计跳过（CI 口径更高） |
| `smoke-tenant.mjs` | ✅ 48/48 | 自带服务生命周期（3300） |
| `smoke-transport.mjs` | ✅ 6/6 | in-process 段；redis 段未设 URL 跳过 |
| `smoke-telemetry.mjs` | ✅ 14/14 | 本地 mock OTLP 收集器 |
| `smoke-config.mjs` | ✅ **27/27** | M9 新增：双入口生效 / 三类拒绝 / fail-keep / 审计可见 / 越权面 / 未启用形态（3450） |
| **合计** | ✅ **264/264** | 0 失败（+ mock 119 = 383 项端到端断言） |
| `drill-m8.mjs`（三大演练） | ✅ **12/12**，4 项跳过 | 跳过段均为环境门控（`SMOKE_DB_SWITCH` / `SMOKE_REDIS_URL`，CI 与真机覆盖） |
| M6 生成器 dry-run | ✅ | `node packages/cli/dist/index.js gen crud demo-item --dry` |
| 迁移 + 种子（SQLite） | ✅ | `prisma migrate deploy` + `db:seed` 清场重建通过 |

### 4.3 静态门禁（2026-10-15 实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 文件头与署名 | `node scripts/check-file-headers.mjs` | ✅ **420** 文件 |
| 裸 SQL | `node scripts/check-no-raw-sql.mjs` | ✅ **277** 文件 |
| 前端/后端接口对撞 | `node scripts/check-api-parity.mjs` | ✅ OK |
| Helm + compose | `pnpm run check:helm` | ✅ **63/63** |

### 4.4 真机验收（`106.55.32.251` / `https://cs.donttemo.top`，2026-10-15 实跑）

> 发版执行记录：备份 `/opt/fw/shared/backups/fw-pre-0.4.0-20261015140829.sql.gz` → `release7.sh` 九步（REL `/opt/fw/releases/20261015140926`）→ `verify-release7.sh` + `verify-c06.sh`。

| 项 | 结果 | 说明 |
|---|---|---|
| 发版前备份 | ✅ | `pg_dump \| gzip` 三重校验：魔数 `1f8b` / `gzip -t` ok / `CREATE TABLE` **15** 张 |
| 九步发版 | ✅ | 解包 14 顶层条目、源码断言 4 项（config-center 包 / configs·tenants 控制器 / seed 新权限点菜单 / `ENV_HOT_KEYS` 注册表）、依赖安装、PG schema generate、拓扑序构建（config-center 排在 config/logger/core 之后）、前端构建注入 `/api/v1`（configs/tenants 视图 chunk 产出）、bin 重链 |
| 迁移 + **seed 重跑** | ✅ | `No pending migrations to apply`（tenants/字典表 M8 已建）；seed 后权限点 **40**、菜单 **10**（含 `/system/tenants`、`/system/configs`）、租户 4、账号 12、部门 5 |
| 服务切换 | ✅ | 原子切换 `20261014213252 → 20261015140926`；`systemctl is-active`=active；`/health` 200；`/ready` db/cache/queue/transport 全 ok |
| 数据面复核 `verify-release7.sh` | ✅ | **29/29**：配置中心未启用形态（GET 只读 / PUT 1004 / alice 3002）、租户管理（读 + 校验拒绝 + legacy 1004 + alice 3002 + 排序白名单）、任务中心（派发 → succeeded → 下载 CSV 带 UTF-8 BOM `efbbbf` / 他人任务 404）、排序正向+拒绝、菜单快照（admin 含新页 / alice 不含）、站点产物 chunk、外网 HTTPS 200/201 |
| C-06 回归 `verify-c06.sh` | ✅ | **27/27**（老功能面无回退；字典残留检查可见新增 `audit_module` / `tenant_isolation` / `tenant_status`） |
| 前端产物同步 | ✅ | 站点 48 文件，含 configs/tenants 视图 chunk 与 `/api/v1` 基址，无死链菜单 |

> 验收脚本自身曾有两处笔误（导出端点误用 POST——实际为 `GET /audit-logs/export`；`jobId` 误取——实际响应字段为 `data.id`），修正后 29/29；**产品无缺陷**，两处均为验收脚本对契约理解偏差，已同步修正脚本存档。

### 4.5 CI 远端复核（GitHub Actions，推送后实跑）

发版提交 `8ac2ff5a05219b4a9d2f61df3718f01201293be7` 推送 `origin/main` 并打标签 `v0.4.0` 后，CI 工作流 run **38690219583**（事件 `push`）**全部 4 个作业 success**，无失败步骤：

| 作业 | 结论 |
|---|---|
| 构建 / 单测(SQLite) / 静态检查 | ✅ success |
| 集成测试 / sqlite | ✅ success |
| 集成测试 / postgres | ✅ success |
| 集成测试 / mysql | ✅ success |

## 5. 本次验收中发现并处理的问题

**本机沙箱注记（非产品缺陷，属执行姿势）**：

1. `prisma generate` 首跑被沙箱 safe-delete 守卫拦截（`test-client` 目录重建触发批量删除确认）——按既有前置 `CODEBUDDY_SAFE_DELETE_ENABLED=0` 复跑即过，与 v0.3.0 轮教训一致，非代码问题。
2. 其余全量步骤（构建 16 项、单测 14 批、冒烟 8 套 + mock、演练、迁移种子）**一次通过**，未发现产品缺陷——本轮三轮迭代在开发期均已做反向验证，发布期无新增修复项。

## 6. 遗留问题

| 编号 | 内容 | 影响 | 归属 |
|---|---|---|---|
| R4-01 | **L-01** 真实 K8s 集群部署冒烟 | Helm Chart 已有离线渲染门禁，缺真实集群验证 | 需外部环境 |
| R4-02 | **L-04** Redis Cluster 实跑 | cluster 驱动有单测与降级路径，缺真实实例实测 | 需外部环境 |
| R4-03 | **M9 Backlog**：tenant-scoped config、一键回滚 API、Nacos adapter 示例 | 配置中心进阶能力 | v0.4.0 后迭代规划 |
| R4-04 | **N-03 整页 403 视图**：`3002` 仍走通用错误提示 | 体验项，纯前端 | 待排期 |
| R4-05 | **R3-05（沿用）** 工作台统计口径与 `dataScope=self` 的关系未细化 | 指标语义 | 产品待决策 |
| R4-06 | bullmq `rateLimit` 运行时固化（热更需 Worker 重建，当前 WARN 提示） | 极端场景下热更不完整，并发可热更 | 后续版本 |

## 7. 判定

**通过**。

- 本机全部门禁（单测 869、冒烟 264 + mock 119、静态 4 项、演练 12/12、M6 dry-run）实跑通过，零产品缺陷；
- 真机发版 + seed 重跑 + verify **29/29** + C-06 回归 **27/27**（§4.4）；
- **CI run `38690219583` 的 4 个作业全部 success** —— 结论与本机 §4.1–4.3 一致（含三库集成矩阵，本机沙箱无法覆盖的段由 CI 补齐）；
- §6 遗留项均**不阻塞本版发布**（R4-01/R4-02 需外部环境，R4-03/R4-04/R4-05 属后续迭代，R4-06 有 WARN 兜底）。

> **发布动作**：附注标签 `v0.4.0` 打于发版提交并推送；`origin/main` 同步更新（见 §8）。

## 8. 发布后的仓库状态

| 项 | 状态 |
|---|---|
| `origin/main` | 已更新至 **`8ac2ff5`**（推送记录 `d265e84..8ac2ff5`）—— 发版提交含 CHANGELOG 转版本 / 15 包 0.4.0 / 本报告 / 状态同步 |
| 标签 | `v0.1.0`–`v0.3.0` 远端已存在；本版新增 **`v0.4.0` 已推送**（附注标签，指向 `8ac2ff5`） |
| CI | run **38690219583**：4 个作业全部 success（§4.5） |
| 真机 | `/opt/fw/current → /opt/fw/releases/20261015140926`，服务 active，seed 已重跑（**所有用户须重新登录**） |

## 9. 真机升级指引

本版**前后端与种子均有变更**，三段必须同批执行（不能只跑 seed——新菜单指向的新页面视图只存在于新版前端产物中）：

1. **备份**：`docker exec <pg容器> pg_dump -U fw -d fw | gzip > /opt/fw/shared/backups/fw-pre-0.4.0-$(date +%s).sql.gz`（必须带 `| gzip`，三重校验）。
2. **后端 + seed**：解包 → `pnpm install --frozen-lockfile` → `prisma generate --schema prisma/pg/schema.prisma` → 拓扑序构建 → `db:migrate`（应 No pending）→ **`db:seed`** → 原子切换 + `systemctl restart fw-api`。
3. **前端**：`VITE_API_BASE_URL=/api/v1 pnpm --filter admin-web run build` → `rsync -a --delete dist/ /opt/1panel/www/fw-web/`。
4. **让所有用户重新登录**（菜单与权限码为登录时快照）。
5. **可选启用配置中心**：`.env` 追加 `CONFIG_CENTER_ENABLED=true` + 事实源文件（默认关闭 = 零开销）。
