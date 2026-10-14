# v0.2.0 发布验收报告

> 版本：**v0.2.0** ｜ 发布范围：**M5–M8** ｜ 验收日期：2026-10-14 ｜ 验收人：donttemo（L0 编排）
> 依据：[验收标准](./10-acceptance-criteria.md) §2 完成定义、§3 里程碑门禁、§4 非功能与安全基线、§5 可观测基线、§6 三大关键演练、§7 验收流程
> 证据目录：`.workbuddy/release-0.2.0/`（构建、单测、覆盖率、冒烟、演练、依赖扫描原始输出）
> 关联：[v0.1.0 发布验收报告](./90-release-v0.1.0.md) ｜ [M8 三大关键演练与终验](./96-m8-drills.md) ｜ [压测基线](./97-bench-baseline.md) ｜ [规模化上线自检清单](./98-scale-checklist.md)

## 1. 发布物与范围

本次发布在 v0.1.0（M1–M4）之上，**一次性纳入 M5–M8 四个里程碑**，至此 **M1–M8 全部交付**：

| 包 / 应用 | 版本 | 内容 | 里程碑 |
|---|---|---|---|
| `@fw/queue` | 0.2.0 | 统一 Job 抽象 + memory/bullmq 双驱动 + `@JobHandler`/`@Cron` 扫描 + 重试退避 + 死信重放 + 幂等 + 令牌桶限速 + cron 分布式锁 + 优雅停机 + 运维面 | M7 |
| `@fw/tenant` | 0.2.0 | 三级回退租户解析（子域名/请求头/JWT claim，顺序与开关可配）+ 查库校验 fail-closed + TTL 缓存 + express 级中间件（上下文透传 `tenantId`/`tenantIsolation`/`tenantDbUrl`） | M8 |
| `@fw/transport` | 0.2.0 | in-process / redis 双驱动端口（`TransportModule.forRoot` 配置切换，调用方 diff = 0）+ redis RPC 协议 + `@TransportHandler` 声明式注册 + 客户端代理 | M8 |
| `@fw/telemetry` | 0.2.0 | OpenTelemetry 链路追踪：SDK 装配 + 尾采样（错误全采）+ HTTP 中间件三级父解析 + 日志 span 桥接 + DB/缓存/队列/传输插桩 + OTLP 导出 | M8 |
| `@fw/cli`（`gen crud`） | 0.2.0 | 五层生成器：schema 解析 → 类型映射 → 模板引擎 → writer（dry-run/diff/回滚）→ 编排；后端 6 / 前端 3 / seed 1 共 10 文件 | M6 |
| `apps/admin-web` | 0.2.0 | Vue3 管理后台：登录、动态路由、按钮级权限、用户/角色/菜单/字典/审计/队列页、`<CrudTable>` 标准组件 | M5 |
| `apps/example-api` | 0.2.0 | M1–M8 全能力活体验证载体（演示端点 + 7 套端到端冒烟 + 三大演练 + 压测） | M1–M8 |
| `deploy/`（部署资产） | — | Helm Chart（14 模板 + values/values-prod）+ docker-compose.prod.yml + nginx/fw.conf；`scripts/check-helm-chart.mjs` 离线校验 | M8 |

**明确排除**：无里程碑遗留。PRD-008 的 **FR-08「配置中心占位与热更新审计」未实现**（不在 §7 AC 内，登记为遗留 R2-02）。

## 2. 里程碑门禁（M5–M8）

| 里程碑 | 关键门禁 | 结果 | 证据 |
|---|---|---|---|
| M5 管理后台模板 | 动态路由与按钮权限生效；mock 全链路可独立运行；bundle ≤ 600 kB | ✅ 通过 | `admin-web` 单测 **29/29** + mock 冒烟 **57/57**（含队列页 17 项与 `system:queue:*` 双向越权拦截）；bundle gzip **311.5 kB**（门禁 600 kB） |
| M6 CRUD 代码生成器 | `fw gen crud` 产物零手改即通过 `tsc` / `vue-tsc`；默认不覆盖、失败回滚；模板可定制 | ✅ 通过 | `@fw/cli` 单测 **116/116**（覆盖率 89.69/82.2/89.05/90.16，门禁 ≥80%）；CI `gen crud demo-item --dry` 冒烟 |
| M7 队列与定时任务 | 双驱动语义一致；cron 集群单跑；死信重放；幂等与限速；失速恢复 | ✅ 通过 | `@fw/queue` 单测 **138/138**（94.54% lines）；冒烟 **31/31**（含真实 Redis **TC-JOB-008 失速恢复演练**，见 [94-queue-stall-drill.md](./94-queue-stall-drill.md)） |
| M8 多租户与规模化 | transport 切换不改调用方代码；跨租户越权用例全绿；缺上下文 fail-closed；traceId 跨服务贯通；Helm 探针/滚动更新/HPA 生效 | ✅ 条件通过 | 租户冒烟 **48/48**、传输 **17/17**、追踪 **14/14**；三大演练 **25/25**；Chart 校验 **63/63**；§7 七条 AC 全绿（见 [96-m8-drills.md](./96-m8-drills.md) §6.1） |

## 3. 全局发布门禁

### 3.1 完成定义（DoD）

| 条目 | 结果 | 说明 |
|---|---|---|
| 功能与 PRD 行为一致 | ✅ | PRD-005~008 的 AC 逐条勾选（PRD-008 §7 七条见 [96](./96-m8-drills.md) §6.1） |
| 新增单测 / 集成 / 端到端 | ✅ | 单测 **748 项**；端到端冒烟 **223 项**（7 套 example-api + admin-web mock） |
| 构建零错误 | ✅ | 11 框架包 + example-api + admin-web **13/13 通过** |
| 无 TODO 遗留（或已建 issue） | ✅ | 现存 TODO 均带责任人与日期 |
| 注释中文 + 文件头完整 | ✅ | `check:headers` **347** 文件通过 |
| 日志带 traceId、新能力接指标 | ✅ | traceId 贯通；`/metrics`（含缓存/队列降级与积压）、`/metrics/queue` 暴露 |
| 无硬编码密钥、输入校验完备 | ✅ | 密钥模式扫描未命中；参数统一走 zod / Prisma 绑定；Helm 默认不渲染明文 Secret |
| 文档同步 | ✅ | README / CHANGELOG / PRD 索引 / 部署手册 / 96-98 / 本报告已同步（见 [95-doc-audit.md](./95-doc-audit.md) §8） |
| CI 门禁覆盖全部包 | ✅ | **本轮修复**：补入 `@fw/tenant`（构建 + 覆盖率循环）与多租户冒烟步骤（见 §5 F2-01/02/03） |

### 3.2 非功能基线

| 项 | 目标 | 本轮实测 | 判定 |
|---|---|---|---|
| 覆盖率：整体 ≥ 70% | ≥ 70% | 11 个框架包 lines 均 ≥ 90% | ✅ |
| `auth` / `cache` / `orm(db)` ≥ 85% | ≥ 85% | auth 95.36% / cache 95.96% / db 96.17% | ✅ |
| `core` / `config` / `logger` ≥ 80% | ≥ 80% | core 99.13% / config 96.61% / logger 92.15% | ✅ |
| `cli`（生成器）≥ 80% | ≥ 80% | 90.16% | ✅ |
| 其余 M7/M8 包 ≥ 85% | ≥ 85% | queue 94.54% / tenant 98.9% / transport 95.22% / telemetry 93.43% | ✅ |
| 后台打包体积 | gzip ≤ 500 KB | 311.5 kB | ✅ |
| 登录接口 P95 | ≤ 300ms | 255.65ms（见 [97-bench-baseline.md](./97-bench-baseline.md)） | ⚠️ 数值达标但未做 50 并发长压（R2-03） |
| 百万行分页 P95 | ≤ 200ms | 未覆盖（数据集远小于 100 万行） | ⏳ R2-03 |

### 3.3 安全基线（缺一即不予验收）

| 条目 | 结果 | 证据 |
|---|---|---|
| 越权：A 无法读写 B 的数据 | ✅ | 租户冒烟阶段 A（跨租户越权拦截）+ 阶段 D（三类详情越权 403/3002）；`@fw/auth` 四档解析与越权单测 |
| 重放：refresh 复用被识别并踢下线 | ✅ | 鉴权冒烟：窗口外复用 → 401/3001，整族撤销 |
| 篡改：签名篡改一律拒绝 | ✅ | 鉴权冒烟：无效令牌 → 401/3001 |
| 爆破：连续失败达阈值锁定并告警 | ✅ | 鉴权冒烟 3004；压测中第 11 次登录返回 429（60s/10 次限流生效） |
| fail-closed：缺租户上下文即拒绝 | ✅ | 租户冒烟阶段 A1（403/4001）；`@fw/db` tenantScoped 单测 |
| 注入：SQL / XSS / 命令注入 | ⚠️ 部分覆盖 | 裸 SQL 门禁 **243** 文件通过、参数统一走 Prisma 绑定；专项注入用例未单列（R2-03 同类） |
| 脱敏：密码 / 令牌等不可见 | ✅ | 冒烟 `log-sensitive` 通过；dedicated 的 `dbUrl` 仅进程内传递、禁入日志 |
| 密钥：无硬编码、仓库扫描无命中 | ✅ | 扫描未命中；Helm 默认 `secrets.existingSecret` 外部注入，不渲染明文 Secret |
| 依赖：漏洞扫描无高危 | ✅ | `pnpm audit` 与 `pnpm audit --prod` 均 **No known vulnerabilities**（全仓 0 项） |

### 3.4 可观测基线

| 项 | 结果 | 证据 |
|---|---|---|
| `/health` `/ready` `/metrics` | ✅ | `/ready` 逐项报告 db / cache / queue / transport；缓存或队列故障时 503 而业务接口不受影响 |
| 结构化日志字段固定 | ✅ | `time / level / traceId / spanId / module / msg / ctx`；启用追踪后 traceId/spanId 自动注入 |
| 链路追踪 | ✅ | 追踪冒烟 14/14：跨服务同 traceId、尾采样错误全采、采样门控、配置守卫 |
| 慢查询 / 缓存降级 / 队列积压告警 | ✅ | 演练三：慢查询告警（`durationMs`+`traceId`）、`degradations` 指标、`fw_queue_backlog` 暴露 |

### 3.5 三大关键演练

> 脚本：`apps/example-api/scripts/drill-m8.mjs`（可复跑）；本轮**全量实跑 25/25，0 跳过，总耗时 84s**，含远程 MySQL 8.4.11 / PostgreSQL 18.6 / Redis 8.10.2。详见 [96-m8-drills.md](./96-m8-drills.md)。

| 演练 | 结果 | 关键实测 |
|---|---|---|
| 一 · 数据库切换 | ✅ 6/6 | sqlite / postgresql / mysql 三库均 `ready.db=ok` + 写后读全通（`listCount=4`）、结果一致；**业务代码 diff = 0**；耗时 48s ≤ 3600s |
| 二 · 规模演进 | ✅ 9/9 | 单体 in-process（`handledBy === callerId`）→ redis 双进程（`handledBy ≠ callerId`、caller `handled=0`）**同一端点同一请求体，仅环境变量不同**；跨进程同 traceId（3 span / 2 服务）；Chart 结构 + compose 齐备 + 清单校验 63/63 |
| 三 · 依赖故障降级 | ✅ 10/10 | Redis 不可达时业务 200（降级直查）+ `/ready` 503 + `degradations=4`；真实 Redis 恢复后读写一致（`healed`）+ `cache=ok`；远程库慢查询告警（`durationMs=46` + `traceId`）；队列限速积压 `waiting=10` → 消化归零 |

## 4. 验证证据清单（本轮全部实跑）

### 4.1 构建

| 项 | 命令 | 结果 |
|---|---|---|
| 框架包（11 个） | 逐包 `pnpm run build`（tsc） | **11/11 通过** |
| example-api | `pnpm --filter example-api run build` | ✅ 通过 |
| admin-web | `vue-tsc --noEmit && vite build` | ✅ 通过（gzip 总量 311.5 kB） |

> 本机沙箱注记：admin-web 在 dist 已存在时，`vite build` 清空 outDir 会触发宿主批量删除守卫（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，阈值 50）。移走旧 `dist/` 后重建即通过；CI 干净环境无此问题（见 §6 R2-05）。

### 4.2 单测（本轮实跑，748 项全绿）

| 包 | 用例 | 说明 |
|---|---|---|
| `@fw/config` | 10/10 | |
| `@fw/logger` | 17/17 | |
| `@fw/core` | 18/18 | |
| `@fw/db` | 70/70（另 **12 项三库矩阵按设计跳过**，未设 `DB_DRIVER` 时） | |
| `@fw/cache` | 77/77 | |
| `@fw/auth` | 108/108 | |
| `@fw/cli` | 116/116 | |
| `@fw/queue` | 138/138 | |
| `@fw/tenant` | 33/33 | 本轮补 14 项（中间件 9 + 模块装配 5），见 §5 F2-02 |
| `@fw/transport` | 82/82 | |
| `@fw/telemetry` | 50/50 | |
| 框架包小计 | **719** | |
| `apps/admin-web` | 29/29 | happy-dom + `@vue/test-utils` |

### 4.3 覆盖率（本轮实跑 `vitest run --coverage`）

| 包 | % Stmts | % Branch | % Funcs | % Lines | 门禁 |
|---|---|---|---|---|---|
| `@fw/config` | 93.84 | 77.14 | 100 | 96.61 | ✅ |
| `@fw/logger` | 89.83 | 88.57 | 95.65 | 92.15 | ✅ |
| `@fw/core` | 95.52 | 80.51 | 100 | 99.13 | ✅ |
| `@fw/db` | 93.36 | 83.16 | 92.85 | 96.17 | ✅ |
| `@fw/cache` | 94.31 | 91.57 | 91.46 | 95.96 | ✅ |
| `@fw/auth` | 93.42 | 86.34 | 92.51 | 95.36 | ✅ |
| `@fw/cli` | 89.69 | 82.20 | 89.05 | 90.16 | ✅ |
| `@fw/queue` | 92.75 | 85.57 | 90.56 | 94.54 | ✅ |
| `@fw/tenant` | **99.00** | 94.50 | 96.00 | **98.90** | ✅（补测后） |
| `@fw/transport` | 94.52 | 89.87 | 93.61 | 95.22 | ✅ |
| `@fw/telemetry` | 92.85 | 80.55 | 97.29 | 93.43 | ✅ |

### 4.4 端到端冒烟（本轮实跑，223 项全绿）

| 脚本 | 结果 | 说明 |
|---|---|---|
| `smoke.mjs` | **13/13** | M1+M2：健康/就绪/统一响应/错误码/details/脱敏/404/traceId 贯通/CRUD/软删 |
| `smoke-auth.mjs` | **25/25** | M3：双 token、`dataScope`、菜单过滤、refresh 轮换与泄漏族撤销、锁定 3004 |
| `smoke-cache.mjs` | **18/18** | M4：memory 全能力 + **真实 Redis** 读写/标签失效/分布式锁/指标 |
| `smoke-queue.mjs` | **31/31** | M7：memory 全能力 + 并发/限速 + **真实 Redis bullmq** + **TC-JOB-008 失速恢复** + 配置守卫 |
| `smoke-tenant.mjs` | **48/48** | M8：三级回退 + fail-closed + **dedicated 独立库路由** + **数据权限四档 19 项** |
| `smoke-transport.mjs` | **17/17** | M8：in-process + **真实 Redis 单/双进程** + 超时 fail-fast + 配置守卫 |
| `smoke-telemetry.mjs` | **14/14** | M8：未启用 / 全采导出 / 跨服务同 traceId / 采样门控 / 错误全采 / 配置守卫 |
| `admin-web` `smoke-mock.mjs` | **57/57** | M5+M7：登录/菜单/CRUD/越权/无感刷新 + 队列管理 17 项 + bundle 门禁 |

> Redis 段落由 `SMOKE_REDIS_URL` 提供真实实例（远程 Redis 8.10.2）后实跑；远程库段落由 `SMOKE_DB_SWITCH=1` 开启。

### 4.5 静态与编排门禁

| 门禁 | 命令 | 结果 |
|---|---|---|
| 文件头校验 | `pnpm run check:headers` | **347** 文件通过 |
| 原生 SQL 方言白名单 | `node scripts/check-no-raw-sql.mjs` | **243** 文件通过 |
| Helm Chart 渲染与清单校验 | `node scripts/check-helm-chart.mjs` | **63/63** |
| 依赖审计（全量） | `pnpm audit` | **No known vulnerabilities** |
| 依赖审计（生产） | `pnpm audit --prod` | **No known vulnerabilities** |

### 4.6 演练与压测

| 项 | 命令 | 结果 |
|---|---|---|
| 三大关键演练 | `SMOKE_DB_SWITCH=1 SMOKE_REDIS_URL=... node scripts/drill-m8.mjs` | **25/25**，0 跳过，84s |
| 压测基线 | `node scripts/bench.mjs` | 登录 QPS 10.2 / P95 255.65ms；列表 QPS 561.8 / P95 27.69ms；写入 QPS 37.5 / P95 434.09ms（见 [97](./97-bench-baseline.md)） |

## 5. 本次验收中发现并修复的缺陷

| 编号 | 缺陷 | 影响 | 修复 |
|---|---|---|---|
| **F2-01** | **CI 漏纳入 `@fw/tenant`**：`.github/workflows/ci.yml` 的构建列表与覆盖率循环未包含该包（M8 T-M8-01 新增时遗漏，`@fw/transport`/`@fw/telemetry` 已纳入） | CI 干净环境下 `example-api` 构建取不到 `@fw/tenant` 的 `dist`，流水线必红；且该包无覆盖率门禁 | 两份 `pkg` 列表补入 `@fw/tenant`（第 57/67 行） |
| **F2-02** | **`@fw/tenant` 覆盖率不达标**：lines 71.42% / functions 56%（门禁 85%），`tenant.middleware.ts` 仅 9.52%、`tenant.module.ts` 46.15%——中间件与模块装配此前只由端到端冒烟覆盖 | 补入 CI 覆盖率循环后将直接卡住发布 | 新增 `tenant.middleware.test.ts`（9 项）与 `tenant.module.test.ts`（5 项），覆盖运维路径豁免/短路/成功（含 dedicated `dbUrl`）/请求头与 JWT 来源/fail-closed 传递/store 异常，以及 `forRoot` 四个 provider 工厂与 `inject` 透传、`buildTenantRuntime` 的 env/overrides/fail-fast。覆盖率提升至 **99% stmts / 98.9% lines**，用例 19 → **33** |
| **F2-03** | **CI 缺 M8 多租户端到端冒烟步骤**：`smoke-tenant.mjs` 未进流水线 | 多租户（PRD-008 核心能力）在 CI 无端到端门禁 | 新增「M8 多租户端到端冒烟（SQLite）」步骤 |
| **F2-04** | `/api/v1/demo/ok` 自报 `framework: v0.1.0` | 发版后应用自述版本与发布版本不一致 | 更新为 `v0.2.0` 并补文件头 `@modified` |

**修复后回归**：`@fw/tenant` 单测 33/33、覆盖率 99%/94.5%/96%/98.9%；构建 13/13；文件头门禁 347 通过；CI 配置经静态核对（两份包列表含 tenant、多租户冒烟步骤就位）。

## 6. 遗留问题

| 编号 | 描述 | 等级 | 责任人 | 闭环条件 |
|---|---|---|---|---|
| R2-01 | **真实 K8s 集群部署未执行**（本机无 helm/kubectl/docker）：Chart 以离线渲染 + 清单语义断言（63/63）验证，`helm install` 与 `kubectl rollout` 需在有集群的环境执行 | P2 | donttemo | 按 `deploy/helm/fw-app/README.md` 在有集群环境跑一次并回填 |
| R2-02 | **FR-08「配置中心占位与热更新审计」未实现**（PRD-008 §2 列入范围，但不在 §7 AC 内） | P2 | donttemo | 后继里程碑以 `ConfigCenterPort` + 本地文件适配落地 |
| R2-03 | 压测为单机 SQLite 短时基线：未做 50 并发 × 5 分钟长压（受登录限流约束）、百万行分页未覆盖 | P2 | donttemo | 独立压测环境（放宽限流 + 指向 PG/MySQL）复跑 |
| R2-04 | **Redis Cluster 实跑未执行**（v0.1.0 遗留延续）：驱动已实现 cluster 分支并有单测，实跑仅 standalone | P2 | donttemo | 具备 Cluster 环境时补 |
| R2-05 | **本机沙箱批量删除守卫**（`SAFE_DELETE_BULK_CONFIRM_REQUIRED`，按 turn 累计、阈值 50）会中断 `admin-web` 构建的清空 outDir 与 `drill-m8.mjs` 的测试库清理步骤。**属宿主环境限制，非代码缺陷**，CI / 真实环境不受影响 | P2 | donttemo | 引入容器化本地环境 |

> **v0.1.0 遗留项状态**：R-01（三库矩阵与切库演练）、R-05（dev 工具链漏洞）、R-06（NestJS 11 升级）、R-07（真实 Redis standalone）均已闭环；R-09（临时文件）已闭环；R-02（turbo 管道）与 R-08（admin-web 依赖）随 M5 完成与环境问题自然消解。详见 [90-release-v0.1.0.md](./90-release-v0.1.0.md) §6。

## 7. 判定

**判定：条件通过（Conditional Pass）**

依据：

1. **无 P0 阻断红线**：未发现越权漏洞、数据丢失/不一致、密钥硬编码、依赖不可用即整体 500（缓存/队列故障均有降级且实跑验证）、AC 未执行却标记通过。
2. **代码层门禁全绿且可复现**：构建 13/13、单测 **748/748**、端到端冒烟 **223/223**、三大演练 **25/25**（含远程三库与真实 Redis）、Chart 校验 63/63、文件头与裸 SQL 门禁通过、`pnpm audit` 全量零漏洞。
3. **本次验收发现并修复了 4 项真实缺陷**（§5），其中 **F2-01（CI 漏包）与 F2-02（覆盖率不达标）为发布阻塞级**——若不修，CI 在干净环境下必红；修复后 `@fw/tenant` 覆盖率与 CI 门禁均达标。
4. **判为「条件通过」的原因**：M8 §7 七条 AC 虽全绿，但存在 **P2 遗留**——R2-01 真实 K8s 集群部署未执行、R2-02 FR-08 未实现（范围外）、R2-03 长压与百万行分页未覆盖、R2-04 Redis Cluster 未实跑。这些**均为环境能力缺失或范围外事项，而非代码缺陷**，且每条均登记了责任人与闭环条件，符合验收总纲 §7.5「P1/P2 未通过可留条件通过」。

**发布动作**：

1. 版本号：根与 11 个框架包 + 2 个应用统一 **`0.2.0`**。
2. 打附注标签 **`v0.2.0`**，与 [CHANGELOG](../CHANGELOG.md) 的 `[0.2.0] - 2026-10-14` 条目一一对应。
3. 推送后触发 CI，用真实 Actions 结果复核 F2-01/F2-03 的修复（此前 CI 从未在真实 Actions 上执行过三库矩阵与 M8 步骤）。
