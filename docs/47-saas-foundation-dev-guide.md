<!--
@file 47 · SaaS 运营基础与可复现开发环境 · 开发文档
@description PRD-013（M13）的配套技术设计：技术架构概述、模块划分、关键接口、数据结构设计与开发实施计划。
  需求口径以 docs/prd/prd-013 为准；来源规划为 TY-SaaS.md；领域契约冻结需先产出 ADR-0029~0031。
@author donttemo
@created 2026-10-19
-->

# 47 · SaaS 运营基础与可复现开发环境 · 开发文档

> 关联：[PRD-013](./prd/prd-013-saas-operations-foundation.md)（需求与验收）｜ 来源：`TY-SaaS.md`（规划基线）｜ 上游：PRD-011 S-01~S-07、M12 观测契约（ADR-0025/0026/0027）
>
> 状态：草案（2026-10-19）｜ 负责人：donttemo

## 1. 技术架构概述

### 1.1 总体架构

沿用 TY 既有分层：**接入层（admin-web / API） → 应用层（NestJS 模块） → 领域服务层 → 端口/驱动层 → 存储层（Prisma 三库矩阵 + Redis）**。本里程碑不引入新框架、新中间件类型，全部复用既有端口范式（`*_DRIVER` 枚举 + 多驱动）。

```
admin-web（运营页面，权限码走 PERM）
   │ REST /api/v1
   ▼
api 应用（NestJS）
   ├─ PlansModule          ─┐
   ├─ SubscriptionsModule   │
   ├─ QuotasModule          ├─ 应用层：控制器 + 守卫 + DTO 校验（不写业务规则）
   ├─ UsageModule           │
   ├─ LifecycleModule       │
   ├─ BillsModule          ─┘
   ▼
@fw/saas（新领域包，唯一业务规则归属）
   ├─ PlanService / SubscriptionService      （套餐与订阅，含版本快照）
   ├─ QuotaService                            （生效配额计算 + 原子扣减）
   ├─ UsageService                            （事件幂等 + 汇总重算）
   ├─ TenantLifecycleService                  （五态状态机，独占写权）
   ├─ BillingService                          （账单快照，P1）
   └─ SaasScheduler                           （到期/处置任务，幂等，走 @fw/scheduler）
   ▼
端口层：@fw/cache（Redis 锁/Lua）、@fw/queue、@fw/audit（M12 契约）、@fw/config
存储层：Prisma（sqlite/postgresql/mysql 矩阵）+ Redis（Standalone，Cluster 边界另行声明）
```

### 1.2 关键架构决策（待 ADR 冻结）

| ADR | 主题 | 候选结论 |
|---|---|---|
| ADR-0029 | 套餐/订阅/生效配额模型 | 三层分离：plans(版本化) → tenant_subscriptions(绑版本+期限) → tenant_quotas(覆盖值)；`tenants.plan/status/expireAt` 转为派生只读列 |
| ADR-0030 | 硬限额并发控制 | 首选 **DB 事务 + 条件更新**（`UPDATE ... SET used=used+? WHERE used+?<=limit`），Redis Lua 仅作热路径加速；涉及多 key Lua 时声明 Cluster key-slot 限制不支持 |
| ADR-0031 | 租户五态生命周期 | 状态机迁移表唯一归属 `TenantLifecycleService`；到期任务用状态条件更新保证幂等；冻结作用点为全局 Guard（复用 RbacGuard 链路） |

### 1.3 与既有能力的集成点

- **错误契约（M12）**：新增错误码走 BizError 三类治理 + error-codes.json 工件 + triway 三副本断言；沿用 4029（配额超限）、4030（非法生命周期迁移）、4031（租户冻结）。
- **审计（M12）**：生命周期与运营操作全部走统一契约，带 ip/ua/traceId 六字段。
- **观测（M12）**：新增 `fw_saas_*` 指标段（配额检查次数/拒绝数、生命周期迁移数、任务执行结果），入 core metrics-registry 基数护栏。
- **通知（M11 最小集）**：冻结/到期/终止触发站内信 + Webhook。
- **多租户（M8）**：全部查询强制租户过滤，fail-closed 语义不变。

## 2. 模块划分

### 2.1 新增包：`packages/saas`（@fw/saas）

| 模块 | 职责 | 不做 |
|---|---|---|
| plan | 套餐 CRUD、版本发布、版本快照读取 | 不写订阅状态 |
| subscription | 订阅创建/变更/续期/取消，套餐版本绑定，一租户一生效订阅约束 | 不算配额 |
| quota | 生效配额解析（覆盖 ?? 默认）、原子扣减/预留/回滚、软限额告警事件 | 不写用量事实 |
| usage | 事件写入（幂等去重）、窗口聚合、重算命令、查询 | 不做扣减 |
| lifecycle | 五态状态机、迁移校验、审计落库、通知派发 | 不被控制器绕过 |
| billing | 计费周期快照、明细生成（P1） | 不接支付网关 |
| scheduler | 到期扫描、宽限转冻结、保留期处置（幂等、可恢复） | 不直改状态字段 |

### 2.2 API 应用层新增模块

`PlansController`、`SubscriptionsController`、`QuotasController`、`UsageController`、`TenantLifecycleController`、`BillsController`（P1）。控制器只做 DTO 校验、守卫、调用领域服务、错误映射。

### 2.3 admin-web 新增页面（P1）

套餐管理、订阅管理、租户列表+生命周期操作、用量看板、账单列表。动态路由挂 Layout 下，权限码新增 `PERM.OPS_SAAS_*` 系列（登记进 `packages/auth/src/constants.ts` 唯一权威 + seed，**存量环境需 reseed**）。

### 2.4 主线 B 交付物（工具链与文档）

> **已交付（2026-10-19，M13 主线 B）**。编号处置（OQ-13-4 定案）：48/49/97 立项核对时均未被占用，
> 按原号落地；「开发环境指南」与本文并列、落 **docs/42**（47 保留 SaaS 领域指南不复用）。

| 交付物 | 实际位置 | 状态 |
|---|---|---|
| 开发环境指南 | `docs/42-development-environment.md` | ✅ 已交付 |
| 可复现构建规范 | `docs/48-reproducible-builds.md` | ✅ 已交付 |
| Dev Container 指南 | `docs/49-devcontainer.md` + `/.devcontainer/devcontainer.json` | ✅ 已交付 |
| 可复现性验证清单 | `docs/97-reproducibility-verification.md` | ✅ 已交付 |
| 工具链冻结 | `.nvmrc`(22.22.2) + CI `node-version` pin ×2 + devcontainer 基镜像 + `server-bootstrap.sh NODE_VERSION`，pnpm 统一由 `packageManager`(11.6.0) 派生 | ✅ 已落地（矩阵见 48 §2） |

## 3. 关键接口说明

> 资源前缀 `/api/v1`；鉴权沿用 JWT + RbacGuard；错误响应信封与 M12 契约一致（code/message/details 顶层 + requestId）。

### 3.1 套餐（平台运营）

| 方法/路径 | 说明 | 权限码 |
|---|---|---|
| `POST /plans` | 创建套餐（初始版本） | `PERM.OPS_SAAS_PLAN_WRITE` |
| `POST /plans/:id/versions` | 发布新版本（不可改历史版本） | 同上 |
| `GET /plans` / `GET /plans/:id` | 列表/详情（含版本列表） | `PERM.OPS_SAAS_READ` |
| `GET /saas/plans/current` | 租户侧查询本租户当前套餐快照 | 租户管理员 |

### 3.2 订阅

| 方法/路径 | 说明 | 备注 |
|---|---|---|
| `POST /tenant-subscriptions` | 为租户创建订阅 `{tenantId, planId, planVersion, effectiveAt, expireAt}` | 创建即写 plan_quotas 快照到 tenant_quotas；409 若已有生效订阅 |
| `PATCH /tenant-subscriptions/:id` | 变更（升级/降级/续期/取消），body 带原因 | 旧订阅留快照；写审计 |
| `GET /tenant-subscriptions?tenantId=` | 查询（运营任意租户；租户侧仅本租户） | 跨租户 fail-closed |

### 3.3 配额与用量

| 方法/路径 | 说明 | 备注 |
|---|---|---|
| `GET /quotas?tenantId=&window=` | 查询生效配额与已用量 | 生效值 = tenant_quotas 覆盖 ?? 套餐默认 |
| `PATCH /quotas/:tenantId/:quotaKey` | 租户级覆盖调整 | 运营专属；审计 |
| `POST /internal/usage/events` | 业务侧上报用量事件 `{tenantId, metricKey, quantity, occurredAt, idempotencyKey}` | **幂等键唯一约束**；重复返回 200 + `deduped: true` |
| `GET /usage?tenantId=&metricKey=&from=&to=` | 明细/汇总查询 | rollup 优先，标注数据来源 |
| `POST /usage/recalc` | 重算指定窗口 rollup | 运营专属；审计；幂等 |

### 3.4 租户生命周期

| 方法/路径 | 说明 | 备注 |
|---|---|---|
| `POST /tenants/:id/lifecycle` | 状态迁移 `{action, reason}`，action ∈ {activate, freeze, resume, terminate} | 迁移合法性由状态机校验，非法返回 **4030** |
| `GET /tenants/:id/lifecycle/logs` | 迁移历史（审计六字段） | 运营专属 |
| 到期任务（内部） | SaScheduler 扫描 expireAt → grace；grace 期满 → frozen | 状态条件更新幂等；重复执行无副作用 |

### 3.5 错误码（先登记 error-codes.json 再实现）

| 码 | 语义 | 类别（ADR-0025） |
|---|---|---|
| 4029 | 配额硬限额超限（附 metricKey 与升级指引） | ②可重试业务类 |
| 4030 | 非法生命周期迁移 | ③调用方错误类 |
| 4031 | 租户已冻结/终止，业务访问被拒 | ②业务状态类 |

## 4. 数据结构设计

> 以下为候选模型，落地前先核对 `docs/30-data-dictionary.md` 与现有 schema，避免重复存储同一事实。全部新表入三库矩阵 schema 变体并配迁移。

### 4.1 表清单

```
plans                套餐定义（code 唯一、name、description）
plan_versions        套餐版本（plan_id, version 递增, snapshot JSON, published_at）
plan_quotas          版本内配额默认项（plan_version_id, quota_key, limit_value, execution）
quota_definitions    配额字典（key 唯一, name, unit, window_type[day/month/total], execution[soft/hard/observe]）
tenant_subscriptions 租户订阅（tenant_id, plan_id, plan_version_id, status[active/expired/cancelled],
                     effective_at, expire_at；active_marker 唯一（NULL 可重复）表达「一租户一生效」）
tenant_quotas        生效配额覆盖（tenant_id, quota_key, override_value, source[plan_snapshot/manual]）
usage_events         原始用量（tenant_id, quota_key, quantity, occurred_at, source,
                     idempotency_key 唯一约束；按 occurred_at 分区/索引）
usage_rollups        窗口汇总（tenant_id, quota_key, window_start, window_type, total_quantity,
                     event_count；unique(tenant_id, quota_key, window_start, window_type)）
tenant_lifecycle_logs 生命周期日志（tenant_id, from_status, to_status, action, actor_type[system/user],
                     actor_id, reason, 审计六字段）
bills / bill_items   账单头/明细（P1：period, plan_version 快照, 用量来源引用, 调整项, rounding_rule）
```

> **开通写路径（ADR-0029 §2.5）**：`tenant_subscriptions` 行与 `tenant_quotas` 快照行必须由
> `SubscriptionStore.createSubscriptionWithSnapshot` 在**同一事务**写入（同成同败）。端口刻意不提供
> 「先建订阅、再逐条补快照」的入口——那会在任何一次写失败时留下「已生效但权益不完整」的订阅。

### 4.2 存量字段兼容（ADR-0029）

- `tenants.plan` / `status` / `expireAt` 保留为**派生只读列**：由 SubscriptionService / TenantLifecycleService 在写路径同步回写，读路径新逻辑不再消费。
- 提供一次性回填脚本（按现有值映射到默认套餐 + 五态初值，映射规则见 OQ-13-3）。
- 设退役里程碑：M14 评估删除。

### 4.3 五态状态机

```
pending ──activate──▶ active ──expire(任务)──▶ grace ──宽限期满(任务)──▶ frozen
                        ▲                        │                        │
                        └──────resume────────────┴────────resume──────────┘
active/grace/frozen ──terminate──▶ terminated ──(保留期满,任务)──▶ 数据处置（导出/删除，策略化）
```

- 合法迁移表入 ADR-0031；迁移实现为 `UPDATE tenants SET status=:to WHERE id=:id AND status=:from`（条件更新即幂等）。
- **Int 编码见 ADR-0029 §2.4**：写码 `pending=5 / active=1 / grace=2 / frozen=3 / terminated=4`；0 为存量停用
  只读兼容码（读作 frozen），领域写路径永不写 0。`from=frozen` 的条件更新须同时匹配 0 与 3，否则存量停用
  租户的 resume/terminate 恒 4030。
- 冻结作用点：全局 Guard 在 RbacGuard 后校验租户状态，`frozen/terminated` 拒绝业务请求（4031）；放行白名单 = 管理端登录、数据导出、生命周期查询。

### 4.4 并发与幂等机制

| 问题 | 机制 |
|---|---|
| 硬限额超发 | 事务内条件更新扣减；Redis 侧仅缓存余量作快速预检，DB 为事实来源 |
| 用量重复计量 | `usage_events.idempotency_key` 唯一约束，冲突即去重 |
| rollup 与 events 不一致 | 重算命令从 events 重建任意窗口；常规写入同事务保证 |
| 到期任务重复执行 | 状态条件更新 + 分布式锁（@fw/cache）双保险 |
| 进程重启恢复 | 任务无内存态，扫描基于 DB 条件，重启后自然续跑 |

## 5. 开发实施计划

### 5.1 排期（按 PRD-013 §2.1 五阶段）

| 阶段 | 内容 | 退出条件 |
|---|---|---|
| **P0 基线**（W1） | 确认 main/CI 基线；turbo 231 / Prisma 平台差异最小复现登记；readiness 断连行为复核 | 已知问题有复现步骤与待办 |
| **P1 契约冻结**（W1–W2） | ADR-0029/0029/0030 评审；错误码登记；权限码清单冻结 | 数据模型、迁移、错误响应、权限边界评审通过 |
| **P2 环境自动化**（W2–W3，可与 P3 并行） | 工具链冻结；docs 四件套；Dev Container；CI 门禁补强 | 干净 checkout 冒烟脚本通过 |
| **P3 SaaS 核心闭环**（W3–W6） | ① plans/versions/subscriptions/quotas 模型+迁移+服务 ② usage 幂等+硬限额原子扣减+竞态测试 ③ lifecycle 状态机+到期任务+Guard 作用 ④ 运营 API+审计+指标段 ⑤ admin-web 页面+账单基础 | AC-13-01~11 通过；三库矩阵通过 |
| **P4 端到端实机验证**（W7） | CI → Windows 本地 → 2C2G 云服务器：部署、重启、依赖故障与恢复演练 | AC-13-12~14；发布说明含拓扑边界与回滚 |

### 5.2 任务拆解（P3 内部顺序，不可倒置）

1. Schema 迁移（三库同构）+ 回填脚本 + 数据字典更新。
2. `@fw/saas` plan/subscription/quota 服务 + 单测（配额解析、版本快照）。
3. usage 事件幂等 + rollup + 重算命令 + 去重测试。
4. 硬限额原子扣减 + 并发竞态测试（入 CI）。
5. lifecycle 状态机 + SaScheduler 幂等任务 + 恢复测试。
6. 冻结 Guard 接入业务入口 + 白名单 + 4031 测试。
7. 运营 API + 审计 + `fw_saas_*` 指标段 + triway 错误码轴。
8. admin-web 页面 + 权限码 reseed + smoke-mock 同步。
9. `smoke-saas-ops` 端到端：开通 → 超限拦截 → 升级 → 冻结 → 注销全流程。

### 5.3 测试与门禁

- 逐包测试 `vitest run --no-file-parallelism`；三库矩阵 `test-schema.{mysql,postgresql}.prisma` + `DB_DRIVER`。
- 门禁全量复跑：`check:headers`、`check-no-raw-sql`、`check:helm`、`check-api-parity`、`triway-consistency`（新轴：错误码）、`check-no-raw-throw`。
- 回归基线更新后同步 PRD/CHANGELOG；范围固定断言（权限码数、错误码数、ENV 键数）三处同步。

### 5.4 发布与回滚

- 迁移均配回滚脚本；`tenants` 存量列只增不删，回滚无破坏。
- 发布说明模板：已验证拓扑 / 未验证拓扑（Redis Cluster、多节点、高负载）/ 已知限制 / 回滚步骤 / 监控点。
- 真机窗口沿用 1Panel 流程（release 目录 + systemd `fw-api`），验收走服务器侧 `curl -k https://cs.donttemo.top`。
