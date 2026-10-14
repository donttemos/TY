# v0.3.0 发布验收报告

> 版本：**v0.3.0** ｜ 发布范围：**真机可用性收口**（管理后台前端缺陷修复 + 路由与登录态生命周期 + C-06 契约收口 + 1Panel/裸机部署路径） ｜ 验收日期：2026-10-14 ｜ 验收人：donttemo（L0 编排）
> 依据：[验收标准](./10-acceptance-criteria.md) §2 完成定义、§3 里程碑门禁、§4 非功能与安全基线、§5 可观测基线、§7 验收流程
> 关联：[v0.2.0 发布验收报告](./90-release-v0.2.0.md) ｜ [管理后台功能补充与缺陷修复方案](./99-admin-web-enhancement-and-fixes.md) ｜ [1Panel 真机部署验证报告](./63-1panel-real-deploy-verification.md) ｜ [文档一致性核对报告](./95-doc-audit.md)

## 1. 发布物与范围

本版**不新增包、不调整框架对外 API**，是把 v0.2.0 已交付的能力拉到「**真机可用的同源状态**」的收口版本。
触发原因：v0.2.0 的管理后台验收是**在 mock 上完成的**，mock 自建了一套后端并不存在的权限码与菜单形状，
真机上线后 6 项 P0 里 5 项当场暴露（用户报障「点进功能页侧边栏消失」）。

| 变更域 | 内容 | 依据 |
|---|---|---|
| `apps/admin-web` | 页面级缺陷 15 项 + 路由/登录态 4 项 + 工作台按权限取数（BUG-16~22），新增 5 个测试文件 | [docs/99](./99-admin-web-enhancement-and-fixes.md) |
| `apps/example-api` | 新增 `GET/PUT /api/v1/auth/profile`（自助资料，`auth:me` + 白名单）；分派入参写库前校验前置 | [40-api-spec](./40-api-spec.md) §3.2 |
| `apps/example-api/prisma/seed.ts` | 补「队列管理」菜单；移除死链菜单「订单中心」；普通用户角色补 `dict:read` | [docs/99](./99-admin-web-enhancement-and-fixes.md) §7 |
| `deploy/`（部署资产） | 1Panel 真机部署路径 + 裸机路径（systemd / 发版脚本 / 宿主 nginx）+ PostgreSQL schema 变体 | [61](./61-bare-metal-deploy.md) / [62](./62-1panel-real-deploy.md) / [63](./63-1panel-real-deploy-verification.md) |
| `packages/*` | 无 API 变更；仅版本号随全仓统一升至 0.3.0 | — |

**明确排除（登记为遗留）**：N-01 租户管理页（后端 `/tenants` 五个端点仍未实现）、N-02 异步导出任务中心、
L-01 真实 K8s 集群部署冒烟、L-02 FR-08 配置中心占位、L-04 Redis Cluster 实跑、L-05 `LOG_FORMAT` 键歧义。

## 2. 版本与升级影响

| 项 | 说明 |
|---|---|
| 版本号 | 全仓 14 个 `package.json` 统一 `0.2.0 → 0.3.0`；`workspace:*` 引用无需改动 |
| 破坏性变更 | **无框架 API 破坏性变更**；但有两处**升级动作必须执行**，见下 |
| ⚠️ 种子语义变更 | 菜单与角色授权发生变化（补队列管理菜单、移除订单中心、普通角色补 `dict:read`）。菜单与权限码是**登录时快照** → 升级后**必须重跑 `db:seed` 并让用户重新登录**。注意 `db:seed` 是清场重建，**用户/角色/菜单 ID 全部改变**（断言与自动化请按用户名/编码查 ID） |
| ⚠️ 前端存储键变更 | `TagsView` 标签键由 `fw_admin_tags` 改为 `fw_admin_tags:<用户 id>`（按用户隔离，修复「换号后仍看到上一个账号的标签」）。**刻意不做旧键迁移**：无法判断旧键里的标签属于哪个账号，迁移等于把上一账号的标签泄露给新账号 → 升级后各账号标签集合从空开始重建一次 |
| API 变更 | 新增 `GET /api/v1/auth/profile`、`PUT /api/v1/auth/profile`（`auth:me`，白名单 `nickname/phone/email`）；`/audit-logs/export` 未实现，前端按钮已下线（api-spec 仍标 Backlog） |
| 配置键 | 无新增/删除；`.env.example` 无变化 |

## 3. 发布门禁

### 3.1 完成定义（DoD）

| 条目 | 结果 | 说明 |
|---|---|---|
| 功能与 PRD 行为一致 | ✅ | PRD-005 §7 AC 逐页核对（[docs/99](./99-admin-web-enhancement-and-fixes.md) §1 现状核对表） |
| 新增单测 / 集成 / 端到端 | ✅ | 单测 **782 项**（11 框架包 722 + admin-web 60）；端到端冒烟 **203 项**（7 套）+ mock 全链路 **65 项** |
| 构建零错误 | ✅ | `vue-tsc --noEmit` 0 错误；`tsc -p tsconfig.json --noEmit`（example-api）0 错误 |
| 注释中文 + 文件头完整 | ✅ | `check-file-headers.mjs` **376** 文件通过 |
| 无裸 SQL | ✅ | `check-no-raw-sql.mjs` **248** 文件通过 |
| 前后端接口对撞 | ✅ | `check-api-parity.mjs` OK（前端调用面全部有对应后端路由） |
| 部署清单语义 | ✅ | `pnpm run check:helm` **63/63** |
| 文档同步 | ✅ | README 索引 / CHANGELOG / 本报告 / docs/80 / docs/95 / docs/99 已同步（见 §5） |
| 真机部署验收 | ✅ | `106.55.32.251` 数据面 24/24 + 27/27、真实 Chromium 端到端 26/26 |

### 3.2 非功能基线

| 项 | 目标 | 本轮实测 | 判定 |
|---|---|---|---|
| 后台打包 `dist` gzip | ≤ 600 kB | **311.5 kB** | ✅ |
| `vendor-element-plus` gzip | ≤ 360 kB | **231.6 kB** | ✅ |
| 覆盖率 | 整体 ≥ 70%；auth/cache/db ≥ 85% | 11 个框架包 lines 均 ≥ 90%（本轮未重跑覆盖率，沿用 v0.2.0 实测；CI `test:coverage` 门禁仍生效） | ✅ |
| 登录接口 P95 | ≤ 300ms | 255.65ms（v0.2.0 基线，本轮未改动鉴权热路径） | ✅ |

### 3.3 安全基线

| 条目 | 结果 | 证据 |
|---|---|---|
| 越权：低权限账号无法读写管理面 | ✅ | 冒烟 `smoke-auth`：alice 访问 `/roles`、`/audit-logs` → 403/3002；`smoke-admin`：alice 新建用户/角色、下线设备 → 403/3002 |
| 越权：前端按钮级门禁与后端权限码同源 | ✅ | 按 `packages/auth/src/constants.ts` 的 `PERM` 补齐 `v-permission`；`docs/99` §3 BUG-06 |
| 分派入参写库前校验 | ✅ | `roleIds:[""]` / 不存在 UUID / `[合法,""]` 均 400+1001，且**既有角色不被污染**；校验**前置**到写库之前，消除部分更新（`e5a1f37`） |
| 自助资料不可提权 | ✅ | `PUT /auth/profile` 白名单只收 `nickname/phone/email`，`username`/`status`/`roleIds` 拒收 |
| 令牌与敏感字段不入日志 | ✅ | 冒烟 `log-sensitive` 通过；`dbUrl` 仅进程内传递 |
| 依赖漏洞 | ✅ | v0.2.0 已 `pnpm audit` 生产与 dev 双零；本轮无依赖变更 |

## 4. 验证证据清单（本轮全部实跑）

### 4.1 类型检查与单测

| 包 / 应用 | 命令 | 结果 |
|---|---|---|
| `apps/admin-web` | `vue-tsc --noEmit` | ✅ 0 错误 |
| `apps/admin-web` | `vitest run --no-file-parallelism` | ✅ **8 文件 / 60 通过**（路由与布局 17、真机菜单数据集成 6、工作台权限 5、标签页隔离 1、CrudTable 7、request 9、biz-error 9、permission store 6） |
| `apps/example-api` | `tsc -p tsconfig.json --noEmit` | ✅ 0 错误 |
| `@fw/config` / `logger` / `core` | `vitest run` | ✅ 10 / 17 / 18 |
| `@fw/db` | `vitest run` | ✅ **70 通过 + 12 跳过**（三库矩阵按设计在未设 `DB_DRIVER` 时整文件跳过） |
| `@fw/cache` / `auth` / `cli` | `vitest run` | ✅ 77 / 111 / 116 |
| `@fw/queue` / `tenant` / `transport` / `telemetry` | `vitest run` | ✅ 138 / 33 / 82 / 50 |
| **合计** | — | ✅ **722 通过 + 12 跳过**（框架包）＋ 60（前端）＝ **782** |

> `apps/example-api` 无 vitest 单测文件（`vitest run --root . --dir src` 报 No test files found），
> 其验证面是 §4.2 的 7 套端到端冒烟脚本 —— 与 CI 的实际步骤一致（CI 亦只对框架包与 admin-web 跑 `test`）。

### 4.2 端到端冒烟（本机 SQLite，逐套独立进程，与 CI 步骤一一对应）

| 套件 | 结果 | 说明 |
|---|---|---|
| `smoke-auth.mjs` | ✅ **25/25** | 需外部服务监听 3000（CI 由前置步骤起服务）；本轮修正 1 条过期断言，见 §5 |
| `smoke-admin.mjs` | ✅ **76/76** | C-06 契约面（字典/菜单/用户/角色/登录设备/审计详情）逐项验证 |
| `smoke-cache.mjs` | ✅ 12/12 | 自带服务生命周期（端口 3100） |
| `smoke-queue.mjs` | ✅ 22/22 | 本机无 Redis，redis 段按设计跳过（CI 有 Redis 服务容器，口径 31/31） |
| `smoke-tenant.mjs` | ✅ 48/48 | 自带服务生命周期 |
| `smoke-transport.mjs` | ✅ 6/6 | in-process 段；redis 段未设 URL 跳过 |
| `smoke-telemetry.mjs` | ✅ 14/14 | 本地 mock OTLP 收集器 |
| **合计** | ✅ **203/203** | 0 失败 |

| 前端 | 命令 | 结果 |
|---|---|---|
| mock 全链路 + 体积门禁 | `node scripts/smoke-mock.mjs` | ✅ **65/65**，含 gzip 311.5 kB / 231.6 kB |

### 4.3 静态门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 文件头与署名 | `node scripts/check-file-headers.mjs` | ✅ **376** 文件 |
| 裸 SQL | `node scripts/check-no-raw-sql.mjs` | ✅ **248** 文件 |
| 前端/后端接口对撞 | `node scripts/check-api-parity.mjs` | ✅ OK |
| Helm + compose | `pnpm run check:helm` | ✅ **63/63** |

### 4.4 真机验收（`106.55.32.251` / `https://cs.donttemo.top`）

| 项 | 结果 | 说明 |
|---|---|---|
| 前端产物同步 | ✅ | 重建 `admin-web` 产物后 `rsync -a --delete` 到 `/opt/1panel/www/fw-web`，入口分片 `index-DwAhQZFw.js` |
| 数据面复核 | ✅ | `wb-ssh/verify-webfix7.sh` **24/24**；`wb-ssh/verify-c06.sh` **27/27**（无回退） |
| 真实浏览器端到端 | ✅ | 真实 Chromium 经 SSH 动态转发：**26/26**，且**全程 0 条 4xx**（修复前 alice 登录必现 3 条 403） |
| 环境未被污染 | ✅ | 本轮为**前端专用发布**：未重跑 seed、未重启后端、未改 `/opt/fw/current` |

真实浏览器端到端的 6 组断言与截图证据见 [docs/99](./99-admin-web-enhancement-and-fixes.md) §8.1。

## 5. 本次验收中发现并修复的缺陷

| 编号 | 严重度 | 现象 | 根因 | 处置 |
|---|---|---|---|---|
| **V3-F1** | P1（阻塞 CI） | `smoke-auth.mjs` 第 8 条断言 `admin 菜单含「审计日志」与「订单中心」` 失败（实测菜单根数=3） | 上一轮按「死链菜单」修复**整支移除**了种子里的「订单中心」(/order，视图与后端 `/api/v1/orders` 均不存在)，但只同步了 `smoke-admin.mjs` 与真机脚本，**漏了 `smoke-auth.mjs` 的两处菜单断言** —— 属种子语义变更后未同步的过期断言 | ✅ 已改为断言现存菜单（admin 含「审计日志」与「队列管理」；alice 不含二者且含「用户管理」），并注明设计意图；**未删除断言**。复跑 **25/25** |

> **该缺陷只会在 CI/真机暴露**：本机此前从未在推送前跑过 `smoke-auth`，而这批提交尚未推送（见 §8），
> CI 因此从未运行过 —— 这正是「本地绿灯 ≠ 流水线绿灯」的典型样本。
> 同类教训的通用规则：**种子/菜单/权限语义变更时，所有含菜单名或权限码断言的脚本都要一次性全量排查**（本次即为漏排查一处）。

**本机沙箱注记（非缺陷，属执行姿势）**：

1. 首次跑 `@fw/db` 单测时曾返回非零，单独复跑与整批复跑均 **70/70 通过** —— 疑为多个 vitest 进程争用同一 sqlite 文件所致；CI 为干净环境，无此问题。
2. 起服务必须按 CI 的写法：

   ```bash
   cd apps/example-api          # ← cd 单独一行
   node dist/main.js > /tmp/fw-api.log 2>&1 &   # ← 再后台起服务
   ```

   若写成 `cd apps/example-api && node dist/main.js &`，`&&` 会把 `cd` 一起放进**子 shell**，
   后续 `node scripts/smoke-*.mjs` 仍在仓库根目录执行 → `Cannot find module '.../scripts/smoke-auth.mjs'`（MODULE_NOT_FOUND，与产品无关）。
   本轮据此复跑即恢复正常。

## 6. 遗留问题

| 编号 | 内容 | 影响 | 归属 |
|---|---|---|---|
| R3-01 | **N-01 租户管理页**：前端页面与后端 `/tenants` 五个端点均未实现 | 多租户能力无 UI 入口（能力本体已在 v0.2.0 交付） | 需后端配套（api-spec §3.9 已定义契约） |
| R3-02 | **N-02 异步导出任务中心**：`/audit-logs/export` 与通用 `/jobs/:id/progress` 未实现 | 审计页导出按钮已下线 | 需后端配套（api-spec §3.7 标 Backlog） |
| R3-03 | **N-03 整页 403 视图**：`3002` 仍走通用错误提示，未整页替换为无权限视图 | 体验项 | **纯前端可先做，零后端依赖** |
| R3-04 | **E-06 菜单图标/权限码选择器**：仍为自由文本，填错会导致菜单被静默跳过 | 易用性 + 隐蔽故障面 | 纯前端可做 |
| R3-05 | **工作台统计口径**：当前一律取 `total`，与数据权限 `self` 的口径关系未细化 | 指标语义 | 产品待决策 |
| R3-06 | **标签页旧键不迁移**（BUG-20 的有意副作用） | 升级后各账号标签从空重建 | 产品待决策 |
| R3-07 | 死信列表无分页（后端 `listDeadLetters` 全量返回） | 规模大时需加窗口 | 后端 |
| R3-08 | **L-01** 真实 K8s 集群部署冒烟 / **L-02** FR-08 配置中心占位 / **L-04** Redis Cluster 实跑 / **L-05** `LOG_FORMAT` 键「文档声明但实现未消费」 | 与 v0.2.0 遗留一致，未推进 | L-01/L-04 需外部环境；L-05 二选一收口 |

## 7. 判定

**通过**。

- 本机全部门禁（类型、单测 782、冒烟 203 + 65、静态 4 项）实跑通过，且**验收过程中发现的唯一缺陷（V3-F1）已修并复跑通过**；
- 真机数据面 24/24 + 27/27、真实浏览器端到端 26/26 且 0 条 4xx；
- §6 遗留项均**不阻塞本版发布**（R3-01/R3-02/R3-07 需后端配套，R3-08 需外部环境或产品决策）。

> **发布动作**：打附注标签 `v0.3.0` 并同步 CHANGELOG；随后推送 `origin/main` 由 CI 复核（本报告 §4 的门禁已在推送前于本机全量复跑，CI 为最终确认）。

## 8. 发布时的仓库状态

| 项 | 状态 |
|---|---|
| 本地 `main` | 领先 `origin/main` **16 个提交**（历轮均未推送，远端停在 v0.2.0 之后的首轮 CI 排障提交） |
| 标签 | `v0.1.0`、`v0.2.0` 已存在；本版新增 `v0.3.0` |
| 未推送的影响 | 上述 16 个提交**从未被 CI 验证过** —— §5 的 V3-F1 即为该敞口的直接产物 |
| 建议 | 本版发布后立即推送并确认 CI 全绿，消除「本地绿灯、流水线未知」状态 |

## 9. 真机升级指引（按改动面分两段执行）

| 改动面 | 需要做什么 | 不需要做什么 |
|---|---|---|
| **前端段**（BUG-16~22、路由与登录态、工作台取数） | 重建 `apps/admin-web` 产物并同步站点目录：`git archive HEAD` → 目标机解包 → `pnpm install --frozen-lockfile` → `VITE_API_BASE_URL=/api/v1 pnpm --filter admin-web run build` → `rsync -a --delete --exclude '.well-known' dist/ /opt/1panel/www/fw-web/` | 不重跑 seed、不重启后端、不动 `/opt/fw/current`（本轮真机即按此执行） |
| **后端/种子段**（队列管理菜单、移除订单中心、普通角色补 `dict:read`、`/auth/profile`） | **必须重跑 `db:seed` 并让所有用户重新登录**（菜单与权限码为登录时快照）；升级前先做全量备份：`docker exec 1Panel-postgresql-XXXX pg_dump -U fw -d fw \| gzip > /opt/fw/shared/backups/fw-pre-0.3.0-$(date +%s).sql.gz` | — |

> 备份文件**必须带 `| gzip`**（漏掉会写出未压缩文件），并用魔数 `037 213` + `gzip -t` + `CREATE TABLE` 计数三重校验。
> 发版九步与验收脚本见 [62 手册](./62-1panel-real-deploy.md) 与 [63 验证报告](./63-1panel-real-deploy-verification.md)。
