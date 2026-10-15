# PRD-008 · 多租户与规模化演进

> 里程碑：M8 ｜ 状态：**已实现（条件通过，未发版）** ｜ 优先级：P2 ｜ 依赖：M2–M4、M7 ｜ 负责人：donttemo ｜ 更新：2026-10-14
>
> 变更记录：2026-10-13 donttemo 草案转定稿——结算两项待定问题（租户识别改三级回退可配、配置中心首版仅留适配位不绑定实现）；补 M7 依赖至头部（§8 已列）；状态置「已定稿」，M8 实现完成后再按验收门禁勾选 AC。
>
> 变更记录：2026-10-14 donttemo 实现进展——T-M8-01（三级回退解析 / fail-closed / 上下文透传，冒烟阶段 A+B）与 T-M8-02（`@fw/db` TenantDataSource：dedicated 独立库懒创建 + LRU/空闲淘汰 + Repository 按上下文选路，冒烟阶段 C 11 项）已完成；FR-01/FR-02/FR-03 已落地，FR-04~11 进行中。§7 AC 待里程碑收尾（T-M8-08）按门禁统一勾选。
>
> 变更记录：2026-10-14 donttemo T-M8-04 落地——FR-04/FR-05 完成：`@fw/auth` 新增 `DataScopeOrgPort` 端口与四档解析（`resolveDataScopeFilter` / `assertWithinDataScope`，fail-closed 收敛 self + `pendingScopes`），`departments` + `user_department` 两表与迁移落地，用户/角色分配/状态/审计四链路按档过滤（部门集合仅服务端注入，禁客户端传参），详情越权 403/3002 先于存在性查询；种子建五部门树 + 三角色 + 7 示范账号；TC-TNT-004 冒烟阶段 D 19 项断言全绿（四档精确集合 / 三类越权 / 审计收敛）。剩余 FR-06~11 进行中，§7 AC 仍待 T-M8-08 统一勾选。
>
> 变更记录：2026-10-14 donttemo T-M8-05 落地——FR-06 完成：新框架包 `@fw/transport` 以双驱动端口模式（沿用 M7 `@fw/queue` 先例）提供微服务调用语义，`TransportModule.forRoot()` 按 `TRANSPORT_DRIVER` 装配 **in-process**（进程内直连，单体零依赖）或 **redis**（跨进程 RPC：LPUSH 信封 + BLPOP 应答 + BRPOP 1s 轮询消费 + EXPIRE 60s 兜底）双驱动，**切换只改配置，调用方代码 diff = 0**；`TransportService` 只依赖端口并承载统计埋点与启停编排；错误经 serialize/deserialize 对等传播（BizError 按 ERROR_CODE_META 重建），处理方执行上限取信封内调用方超时；`TRANSPORT_ROLE`（caller/handler/both）按进程职责裁剪拓扑；`@TransportHandler` 声明式注册 + `createTransportProxy` 客户端代理（黑名单防生命周期钩子误触发）；配置 7 键（redis 缺连接串回退 CACHE_URL、两者皆缺启动即失败，tcp/kafka 仅预留不入枚举）。TC-TNT-005 冒烟 17/17 全绿（in-process 5 项 + redis 单进程 5 项 + redis 双进程跨进程 3 项 + 超时 fail-fast 3 项 + 配置守卫 1 项），单测 78/78、覆盖率 95.09/93.82/94.33/90.54。剩余 FR-07~11 进行中，§7 AC 仍待 T-M8-08 统一勾选。
>
> 变更记录：2026-10-14 donttemo T-M8-06 落地——FR-07 完成：新框架包 `@fw/telemetry` 以「`@opentelemetry/api` 轻量硬依赖 + `@opentelemetry/sdk-node`/OTLP 导出器 optional peer 懒加载」双轨模式（沿用 M7 ioredis 先例）提供链路追踪：`TelemetryModule.forRoot()` 按 `OTEL_ENABLED` 装配 SDK（未启用全短路零开销），`register({ propagator })` 显式注册 W3C traceparent+baggage 组合传播器；**尾采样处理器**（错误全采 + traceId 低 8 位确定性比例，同链路跨服务决策恒定）；**HTTP 中间件**每请求一个 SERVER span，父上下文三级解析（标准 `traceparent` → 框架自有 `X-Trace-Id` → 根），span 的 traceId/spanId 回写日志 ALS 与 `X-Trace-Id` 响应头（日志/trace/响应头三者同 ID），finish 按路由模板刷新 span 名、5xx 记 ERROR；**日志 span 桥接**；传输层 `call/dispatch` 包 CLIENT/SERVER span 并经 `traceparent` 信封跨进程续接；**DB/缓存/队列插桩**（各自 `$allOperations`/守卫点/派发执行点包 CLIENT/PRODUCER/CONSUMER span，均只依赖 api 的 no-op 语义，与 telemetry 经全局 provider 解耦）。配置 5 个 `OTEL_*` 键（缺端点启动即失败）。TC-TNT-006 冒烟 14/14 全绿（未启用/全采导出与 ID 一致/跨服务同 traceId 父子跨进程/采样门控 0 导出/5xx 错误全采/配置守卫），telemetry 单测 50/50（覆盖率 92.56/80.18/97.05/93.12），db/cache/queue 插桩单测全绿零回归。剩余 FR-08~11 进行中，§7 AC 仍待 T-M8-08 统一勾选。

> 变更记录：2026-10-14 donttemo T-M8-07/08 落地——**M8 全部 WBS 任务完成**（FR-09/FR-10/FR-11 交付）：新增 `deploy/` 部署资产（`deploy/helm/fw-app/` Helm Chart：14 模板含三档探针/滚动更新 `maxUnavailable=0`/HPA/PDB/迁移 pre-upgrade Job/Worker/admin-web/密钥外部注入/`checksum/config` 注解；`deploy/docker-compose.prod.yml` 中档六服务编排；`deploy/nginx/fw.conf` SPA 回退+反代+登录限流）与离线校验脚本 `scripts/check-helm-chart.mjs`（Helm 子集渲染 + K8s 清单语义断言 **63/63**）；三大关键演练可执行化 `apps/example-api/scripts/drill-m8.mjs` **25/25（0 跳过）**——数据库切换三库一致且业务代码 diff=0、规模演进（in-process → redis 双进程 + traceId 跨进程贯通 + compose→Helm）、依赖故障降级（Redis 不可达降级直查 + 恢复回切无脏数据 + DB 慢查询告警 + 队列积压可观测并消化归零）；压测基线 `scripts/bench.mjs`（登录/列表/写入三类场景 QPS 与 P95）；新文档 `docs/archive/m8/96-m8-drills.md`、`docs/archive/m8/97-bench-baseline.md`、`docs/98-scale-checklist.md`。**§7 AC 七条全部通过**，判定「条件通过」（遗留：真实 K8s 集群部署未执行、FR-08 配置中心占位未实现，见 96 文档 §6.4）。

## 1. 背景与目标

前七个里程碑解决「小而全」，本里程碑兑现愿景中最硬的一条承诺（G2）：**从小系统长成大系统，业务代码不重写**。

目标：提供多租户隔离、服务拆分路径、链路追踪与 K8s 部署模板，让同一套代码在小/中/大三档间切换形态。

衡量：演练一次「单体 → 两个微服务」拆分，业务模块代码可整包搬迁，改动集中在配置与 transport。

## 2. 范围

**做**：租户模型与上下文透传、两种隔离级别、数据权限扩展（部门/组织）、微服务 transport 切换、OpenTelemetry 链路追踪、配置与健康检查增强、K8s/Helm 部署模板、规模化清单与压测基线。

**不做**：自研服务网格、自动弹性伸缩策略调优、跨地域多活、数据库分片中间件。

## 3. 用户故事

- 作为 SaaS 服务商，我为不同客户开租户，可选共享库（低成本）或独立库（强隔离）。
- 作为架构师，我把订单模块拆成独立服务，只改 transport 配置，不改业务代码。
- 作为运维，我在 Grafana 上看到跨服务的调用链与耗时瓶颈。
- 作为开发，我从 compose 切到 K8s 时用现成 Helm 模板，不用自己写 YAML。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 租户模型 | `tenants` 表 + 租户上下文（子域名 / 请求头 `X-Tenant-Id` / JWT claim 三源解析，默认「子域名 → 请求头 → JWT claim」回退，回退顺序与各级开关可配）；上下文经 AsyncLocalStorage 透传到 Repository 与日志 |
| FR-02 | 隔离级别 | `shared`（同库 + `tenant_id` 自动注入查询与写入）与 `dedicated`（独立库，按租户路由数据源）；由配置与租户属性决定 |
| FR-03 | 越权防护 | Repository 层强制携带租户条件；缺失上下文时默认拒绝（fail-closed），提供 `@IgnoreTenant()` 显式豁免并记审计 |
| FR-04 | 数据权限扩展 | 在 PRD-003 的「仅本人」之上扩展：全部 / 本组织及下级 / 本组织 / 仅本人，作用于列表查询与详情校验 |
| FR-05 | 组织架构 | `departments` + `user_department`，支持树形与上下级数据范围 |
| FR-06 | 微服务 transport | 业务模块通过接口调用而非直接依赖实现；transport 可切 `in-process`（单体）→ `tcp` → `redis` → `kafka`；切换不改调用方代码 |
| FR-07 | 链路追踪 | OpenTelemetry：traceId 贯穿 HTTP、DB、缓存、队列；导出 OTLP；日志自动注入 traceId/spanId |
| FR-08 | 配置增强 | 支持配置中心占位（本地文件 / Nacos 适配位）；关键配置变更可热更新并审计 |
| FR-09 | 部署模板 | 提供 `docker-compose`（中小）与 Helm Chart（大）；含 HPA 示例、探针、资源限制、滚动更新策略 |
| FR-10 | 规模化清单 | 输出 CheckList：连接池、缓存击穿、队列积压、慢 SQL、N+1、日志采样率等，作为上线前自检 |
| FR-11 | 压测基线 | 提供示例压测脚本与基线报告模板（登录、列表查询、写入三类场景） |

## 5. 非功能需求（NFR）

- 租户上下文字段在所有日志、审计、队列消息中必现。
- 单实例 → 多实例：无状态，会话/令牌不依赖本地内存（依赖 Redis 或 JWT）。
- 链路追踪采样率可配（默认 10%，错误全采），对 P95 影响 ≤ 5ms。
- 模块化边界可静态检查：禁止跨模块直接引内部实现（lint 规则）。

## 6. 关键设计

**租户隔离选型**

| 级别 | 适用 | 成本 | 隔离性 |
|---|---|---|---|
| shared | 中小客户、量大 | 低 | 逻辑隔离（依赖代码正确性） |
| dedicated | 大客户、合规要求 | 高 | 物理隔离（独立库） |

**演进路径**

```
单体（in-process, SQLite/MySQL, memory）
  → 单体多实例（MySQL主从 + Redis + bullmq, compose）
  → 模块拆分（transport=tcp/redis）
  → 平台化（多租户 + Redis Cluster + Kafka + K8s + OTel）
```

每一步只改：`.env`、transport 配置、部署编排文件。

## 7. 验收标准（AC）

> 判定依据与逐条证据见 [`docs/archive/m8/96-m8-drills.md`](../archive/m8/96-m8-drills.md) §6.1；结论：**七条全部通过**。

- [x] 同一份业务模块代码，在 `in-process` 与 `redis` 两种 transport 下均调用成功。
      *证据*：`drill-m8.mjs` 演练二（同一端点同一请求体，仅环境变量不同）；`smoke-transport.mjs` 17/17。
- [x] 租户 A 的用户无法查询/修改租户 B 的数据（自动化越权用例全绿）。
      *证据*：`smoke-tenant.mjs` 阶段 A（跨租户越权 403/4001）+ 阶段 D（三类详情越权 403/3002）。
- [x] 缺失租户上下文时，查询直接失败（fail-closed），不返回全量数据。
      *证据*：`smoke-tenant.mjs` 阶段 A1；`@fw/db` tenantScoped fail-closed 单测。
- [x] 数据权限四种范围在列表与详情接口上均生效。
      *证据*：`smoke-tenant.mjs` 阶段 D 19 项；`@fw/auth` 四档解析/越权校验单测 14 项。
- [x] 一个请求跨 2 个服务时，可用同一 traceId 在追踪系统查到完整链路。
      *证据*：`drill-m8.mjs` 演练二（固定 `traceparent` → 同 traceId 3 span / 2 服务）；`smoke-telemetry.mjs` 14/14（TC-TNT-006）。
- [x] Helm 模板一键部署后，健康检查、滚动更新、HPA 均生效。
      *证据*：`scripts/check-helm-chart.mjs` 63/63（清单语义层：探针分指 `/ready` `/health`、`maxUnavailable=0/maxSurge=1`、HPA、PDB、resources、非 root、Secret 外部注入、迁移 Job pre-upgrade 钩子）。**真实集群 `helm install` + `kubectl rollout` 未执行**（本机无 helm/kubectl），见 96 文档 L-01。
- [x] 压测基线报告可复现，登录/列表/写入三类场景有明确 QPS 与 P95 数值。
      *证据*：[`docs/archive/m8/97-bench-baseline.md`](../archive/m8/97-bench-baseline.md)（登录 P95 255.65ms / 列表 P95 27.69ms / 写入 P95 434.09ms）；`apps/example-api/scripts/bench.mjs` 可复跑。

## 8. 依赖与风险

- 依赖 M2（Repository 注入租户条件）、M3（权限扩展点）、M4（Redis/锁）、M7（队列 transport）。
- 风险：shared 隔离一旦漏写条件即越权 → 以自动化测试 + Repository 层强制 + 上线前越权用例门禁兜底。
- 风险：过早微服务化拖慢小项目 → 文档明确「单体优先」，拆分仅在达到量化阈值（如模块 QPS 差异、团队边界）后进行。

## 9. 待定问题（已结案）

| 问题 | 结论 | 负责人 | 结论时间 |
|---|---|---|---|
| 租户识别用请求头还是子域名？ | **已定稿**：默认「子域名优先 → 请求头兜底 → JWT claim 备用」三级回退，回退顺序与各级开关均可配；已同步进 FR-01 明确三源解析与优先级 | donttemo | 已定稿（M8，2026-10-13） |
| 配置中心接 Nacos 还是 Apollo？ | **已定稿**：首版（M8）仅定义配置中心抽象接口与本地文件 / Nacos 适配位，不绑定具体实现；Nacos / Apollo 在落地项目选型后实现对应 adapter | donttemo | 已定稿（M8，2026-10-13） |
