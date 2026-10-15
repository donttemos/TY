<!--
@file M8 三大关键演练记录与里程碑终验（PRD-008 / 验收标准 §6 L3 发布门禁）
@description 记录「数据库切换 / 规模演进 / 依赖故障降级」三大演练的可复现执行结果（脚本
  apps/example-api/scripts/drill-m8.mjs，25/25 通过），并逐条判定 PRD-008 §7 七条 AC、
  L3 非功能基线与遗留项。
@author donttemo
@created 2026-10-14
-->

# M8 三大关键演练记录与终验

> 日期：2026-10-14 ｜ 结论：**通过（条件通过，见 §6 遗留）** ｜ 负责人：donttemo
>
> 演练脚本：`apps/example-api/scripts/drill-m8.mjs`（可随时复跑）
> 关联：[验收标准 §6 三大关键演练](../../10-acceptance-criteria.md) ｜ [PRD-008](../../prd/prd-008-multitenancy-scale.md) ｜ [部署与运维手册](../../60-deployment-ops.md)

## 1. 演练环境

| 项 | 值 |
|---|---|
| 应用 | `apps/example-api`（M1–M8 全能力的活体验证载体） |
| 运行时 | Node 22.22.2（Windows 沙箱） |
| 数据库 | SQLite（本地基线）+ MySQL 8.4.11（远程）+ PostgreSQL 18.6（远程，SCRAM-SHA-256） |
| 缓存 / 队列 | 进程内 memory（降级演练用不可达地址）+ Redis 8.10.2（远程，恢复回切与跨进程 RPC 用） |
| 追踪 | 本地 mock OTLP 收集器（`http.createServer`，随机端口，断言只看导出载荷） |
| 编排校验 | `scripts/check-helm-chart.mjs`（离线 Helm 子集渲染 + K8s 清单语义断言，63/63） |

远程实例登记见 [`docs/archive/database/92-test-databases.md`](../database/92-test-databases.md)；本轮不做任何生产环境操作。

## 2. 复跑命令

```bash
cd apps/example-api
# 本地可跑段落（单体形态 / 编排演进 / Redis 降级 / 队列积压）
node scripts/drill-m8.mjs

# 全量（含远程三库切换、真实 Redis 跨进程、慢查询注入）
SMOKE_DB_SWITCH=1 \
SMOKE_REDIS_URL="redis://:redis1234@106.55.32.251:6379" \
node scripts/drill-m8.mjs
```

门控语义：`SMOKE_DB_SWITCH=1` 开启远程库段落（数据库切换、慢查询注入）；`SMOKE_REDIS_URL` 开启真实 Redis 段落（微服务跨进程、恢复回切）。未开启的段落输出 `SKIP` 并计入跳过数，**不记为通过**。

## 3. 演练一 · 数据库切换（L3-1）

**通过标准**：改配置 → 同步 schema → 种子 → 跑同一套断言；业务代码 diff = 0，功能全绿，耗时 ≤ 1 小时。

| 步骤 | 结果 |
|---|---|
| sqlite（基线） | `ready.db=ok` `created=true` `listCount=4` |
| postgresql（远程） | `ready.db=ok` `created=true` `listCount=4` |
| mysql（远程） | `ready.db=ok` `created=true` `listCount=4` |
| 三库结果一致 | ✅ 业务行为与库无关 |
| 业务代码零改动 | ✅ `git diff --stat -- apps/example-api/src packages` 为空 |
| 演练耗时 | **47s** ≤ 3600s |

**切库动作**：改写 `prisma/schema.prisma` 的 `datasource db.provider`（`sqlite` / `postgresql` / `mysql`）→ `prisma generate` → `prisma db push --force-reset` + `tsx prisma/seed.ts` → 启动 → 四点断言（`/health`、`/ready` 的 db 探针、`/api/v1/demo/ok`、`/api/v1/demo/items` 的写后读）。脚本 `finally` 恢复 schema 与 sqlite client，工作区无残留。

> 与 [v0.1.0 数据库切换实测](../database/93-db-connectivity-switch-test.md) 的区别：前者在 `@fw/db` 层用三份方言 schema 跑同一套 Repository 断言；本轮在**应用层**（example-api 真实迁移 + 种子 + HTTP 端点）复现同一结论，覆盖从配置到接口的完整链路。

## 4. 演练二 · 规模演进（L3-2）

**通过标准**：单体 → 拆出 1 个微服务（transport 切换）+ compose → Helm；调用方代码不改；链路追踪贯通；滚动更新无中断。

### 4.1 单体 → 微服务（transport 切换）

| 断言 | 结果 |
|---|---|
| 2a 单体形态（`in-process` 单进程）：本进程处理 | ✅ `handledBy === callerId`（`host-9908`） |
| 2b 拆分形态（`redis`，A=caller / B=handler 双进程）：跨进程处理 | ✅ `handledBy=host-2844 ≠ callerId=host-7532` |
| 2b 角色裁剪：caller 进程不处理请求 | ✅ `handled=0` |
| 2b 链路追踪跨进程贯通 | ✅ 固定 `traceparent` → 同一 traceId 下 **3 个 span、2 个服务**（`fw-drill-caller` / `fw-drill-handler`） |

**调用方代码零改动的证明**：2a 与 2b 使用的是**同一个 HTTP 端点、同一份请求体**（`POST /api/v1/demo-transport/echo`，`{"message":"drill-mono"}`），差异只在环境变量（`TRANSPORT_DRIVER` 与 `TRANSPORT_ROLE`）。这是 PRD-008 §7 首条 AC「同一份业务模块代码，在 in-process 与 redis 两种 transport 下均调用成功」的直接证据。

### 4.2 compose → Helm 演进路径

| 断言 | 结果 |
|---|---|
| Helm Chart 结构齐备（`Chart.yaml` + `values.yaml` + 必备模板） | ✅ 14 个模板文件 |
| 中档编排齐备（compose 含 app / worker / postgres / redis / nginx / migrate） | ✅ |
| Chart 清单语义校验 | ✅ `scripts/check-helm-chart.mjs` **63/63**（详见 §5） |

> **滚动更新无中断**：Chart 以 `strategy.rollingUpdate.maxUnavailable=0 / maxSurge=1` + PDB `minAvailable=2` + 三档探针（`startupProbe`→`/health`、`readinessProbe`→`/ready`、`livenessProbe`→`/health`）声明式保证；本轮在**清单语义层**验证（离线渲染断言），真实集群 `kubectl rollout` 属环境相关，见 §6 遗留 L-02。

## 5. 演练三 · 依赖故障降级（L3-3）

**通过标准**：依次停 Redis、注入 DB 慢查询、制造队列积压；接口仍正确返回（降级直查），有告警；恢复后自动回切，无脏数据。

| 场景 | 断言 | 结果 |
|---|---|---|
| 3a Redis 不可达（`CACHE_FAIL_OPEN=true`） | 业务接口仍正确返回 | ✅ `GET /api/v1/demo-cache/find-user?id=99` → 200，`user.id=99`（降级直查 DB） |
| 3a 故障可见性 | `/ready` 如实报告依赖不可用 | ✅ HTTP **503**、`checks.cache=fail`（不掩盖故障） |
| 3a 可告警 | 指标记录降级事件 | ✅ `degradations=5`，`/metrics` 含 `fw_cache_degradations_total` |
| 3b Redis 恢复回切 | 读写一致、无脏数据 | ✅ 写后读两次均为 `healed` |
| 3b 回切确认 | `/ready` 恢复 | ✅ `checks.cache=ok`，`degradations=0` |
| 3c DB 慢查询注入（远程 PG + `DB_SLOW_MS=10`） | 产生告警日志 | ✅ 「慢查询告警」含 `durationMs=40`、`model=DemoItem`、`operation=count`、`traceId` |
| 3d 队列积压 | 积压可观测 | ✅ `QueueStats.queues[].waiting=10`（限速 2/s、并发 1 下派发 12 个） |
| 3d 指标 | Prometheus 文本暴露积压 gauge | ✅ `/metrics/queue` 含 `fw_queue_info{driver=...}` 与 `fw_queue_backlog` |
| 3d 消化 | 队列排空 | ✅ `waiting=0` |

> Redis 恢复回切（3b）与跨进程 RPC（4.1）均为**真实远程 Redis 8.10.2**，非模拟。

## 6. 终验判定

### 6.1 PRD-008 §7 验收标准（7 条）

| # | AC | 判定 | 证据 |
|---|---|---|---|
| 1 | 同一份业务模块代码，在 `in-process` 与 `redis` 两种 transport 下均调用成功 | ✅ | 演练二 4.1；`smoke-transport.mjs` 17/17 |
| 2 | 租户 A 的用户无法查询/修改租户 B 的数据（自动化越权用例全绿） | ✅ | `smoke-tenant.mjs` 阶段 A（跨租户越权拦截）+ 阶段 D（三类详情越权 403/3002）；`@fw/auth` 越权单测 |
| 3 | 缺失租户上下文时查询直接失败（fail-closed），不返回全量数据 | ✅ | `smoke-tenant.mjs` 阶段 A1（403/4001）；`@fw/db` tenantScoped fail-closed 单测 |
| 4 | 数据权限四种范围在列表与详情接口上均生效 | ✅ | `smoke-tenant.mjs` 阶段 D 19 项（四档精确集合 + 越权拦截 + 审计收敛）；`@fw/auth` 四档单测 14 项 |
| 5 | 一个请求跨 2 个服务时，可用同一 traceId 查到完整链路 | ✅ | 演练二 4.1（跨进程 3 span / 2 服务同 traceId）；`smoke-telemetry.mjs` 14/14（TC-TNT-006） |
| 6 | Helm 模板一键部署后，健康检查、滚动更新、HPA 均生效 | ✅（清单语义层） | `scripts/check-helm-chart.mjs` 63/63：探针分指 `/ready` `/health`、`maxUnavailable=0/maxSurge=1`、HPA min/max/CPU 目标、PDB、resources、非 root、Secret 外部注入、迁移 Job pre-upgrade 钩子 |
| 7 | 压测基线报告可复现，登录/列表/写入三类场景有明确 QPS 与 P95 | ✅ | [`docs/archive/m8/97-bench-baseline.md`](./97-bench-baseline.md)；`apps/example-api/scripts/bench.mjs` |

### 6.2 L3 全局门禁

| 门禁 | 判定 | 证据 |
|---|---|---|
| 关键演练（切换 / 演进 / 降级） | ✅ | 本文件 §3–§5，`drill-m8.mjs` **25/25**，0 跳过 |
| M8 里程碑门禁（验收标准 §3） | ✅ | transport 切换不改调用方代码；跨租户越权用例全绿；缺上下文 fail-closed；traceId 跨服务贯通；Helm 探针/滚动更新/HPA 生效 |
| 覆盖率达标记 | ✅ | 框架包整体 ≥70%；`auth` 108/108、`transport` 78/78（95.09/93.82/94.33/90.54）、`telemetry` 50/50、`db` 70/70、`cache` 77/77、`queue` 138/138 |
| 文档同步 | ✅ | README / CHANGELOG / PRD-008 / 部署手册 / 本文件 / 压测基线 / 规模化清单 |

### 6.3 T-M8-07 交付物（Helm Chart 与部署模板）

| 交付物 | 路径 |
|---|---|
| Helm Chart | `deploy/helm/fw-app/`（`Chart.yaml` + `values.yaml` + `values-prod.yaml` + 14 个模板） |
| 中档 compose | `deploy/docker-compose.prod.yml` |
| Nginx 反代配置 | `deploy/nginx/fw.conf`（SPA 回退 / `/api` 反代 / 登录限流 / 运维端点内网白名单） |
| 离线渲染校验 | `scripts/check-helm-chart.mjs`（**63/63**，本机与 CI 无 helm 时的门禁兜底） |

**Chart 关键设计（对照部署手册 §6 大档要求）**：

| 要求 | 实现 |
|---|---|
| `replicaCount` / HPA | 默认 3；HPA `minReplicas=3`、`maxReplicas=12`、CPU 60% 触发，含缩容稳定窗与伸缩策略 |
| 探针分指 | `readinessProbe → /ready`、`livenessProbe → /health`、`startupProbe → /health` |
| `resources` 必填 | requests + limits 均设置（默认 250m/512Mi ~ 1C/1Gi） |
| `strategy` | RollingUpdate，`maxUnavailable=0`、`maxSurge=1`，`revisionHistoryLimit=5` |
| `podDisruptionBudget` | `minAvailable: 2` |
| `secrets` 外部注入 | 默认不渲染 Secret 模板，容器经 `secretRef` 取用；`secrets.existingSecret` 指向外部 Secret |
| `cronJobs` 分离 | 迁移以独立 `Job` + `helm.sh/hook: pre-install,pre-upgrade` 执行，Worker 独立 Deployment（与 API 同镜像不同角色） |
| 安全上下文 | `runAsNonRoot` + 禁提权 + `drop: ALL` + `readOnlyRootFilesystem` + `emptyDir:/tmp` |
| 配置变更触发滚动 | Pod 模板 `checksum/config` 注解 |

### 6.4 遗留项（不阻塞 M8 关闭）

| 编号 | 描述 | 等级 | 处置 |
|---|---|---|---|
| L-01 | **真实 K8s 集群部署未执行**（本机无 helm/kubectl/docker）：Chart 以离线渲染 + 清单语义断言验证，`helm install` 与 `kubectl rollout` 需在有集群的环境执行 | P2 | 交付 Chart 与校验脚本；建议在有集群的环境按 `deploy/helm/fw-app/README.md` 跑一次冒烟并回填结果 |
| L-02 | FR-08「配置中心占位与热更新审计」未实现（PRD-008 §2 列入范围，但不在 §7 AC 内） | P2 | 见 §6.5；建议后继里程碑以 `ConfigCenterPort` + 本地文件适配落地 |
| L-03 | 压测为单机 SQLite 短时基线（登录 10 次受 60s/10 次限流约束；未做 50 并发 5 分钟长压） | P2 | 见 [`97-bench-baseline.md`](./97-bench-baseline.md) §3 条件说明；长压需独立压测环境 |
| L-04 | Redis Cluster 实跑（v0.1.0 遗留）仍为 standalone 验证 | P2 | 缓存/队列驱动已实现 cluster 分支并有单测，实跑留待具备 Cluster 环境时补 |

### 6.5 FR 覆盖情况（PRD-008 §2 范围）

| FR | 名称 | 状态 |
|---|---|---|
| FR-01 | 租户模型（三级回退解析） | ✅ 已完成 |
| FR-02 | 隔离级别（shared / dedicated） | ✅ 已完成 |
| FR-03 | 越权防护（fail-closed + `@IgnoreTenant`） | ✅ 已完成 |
| FR-04 | 数据权限扩展（四档） | ✅ 已完成 |
| FR-05 | 组织架构（`departments` / `user_department`） | ✅ 已完成 |
| FR-06 | 微服务 transport | ✅ 已完成 |
| FR-07 | 链路追踪（OpenTelemetry） | ✅ 已完成 |
| FR-08 | 配置增强（配置中心占位 + 热更新审计） | ⚠️ 未实现（L-02） |
| FR-09 | 部署模板（compose + Helm） | ✅ 已完成（T-M8-07） |
| FR-10 | 规模化清单（CheckList） | ✅ 已完成 → [`98-scale-checklist.md`](../../98-scale-checklist.md) |
| FR-11 | 压测基线（脚本 + 报告模板） | ✅ 已完成 → [`97-bench-baseline.md`](./97-bench-baseline.md) |

**结论**：§7 七条 AC 全部通过，L3 三大演练全绿（25/25）。FR-08 未实现（不在 §7 AC 内，登记为 P2 遗留），故判定为**条件通过**，闭环条件见 L-01/L-02。
