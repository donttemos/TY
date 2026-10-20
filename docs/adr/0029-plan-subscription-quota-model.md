<!--
@file ADR-0029 · 套餐、订阅与生效配额的三层模型
@description M13（PRD-013）SaaS 运营基础的领域模型定案：套餐版本化、订阅绑定版本与期限、
  生效配额 = 租户覆盖 ?? 套餐默认；tenants.plan/status/expireAt 存量字段转派生只读列的兼容策略与退役里程碑。
@author donttemo
@created 2026-10-19
-->

# ADR-0029 · 套餐、订阅与生效配额的三层模型

- 状态：**已采纳**（2026-10-19；M13 P1 契约冻结，随 PRD-013 立项）
- 关联：PRD-011 S-01、PRD-013 FR-13-01~03/05、`docs/47-saas-foundation-dev-guide.md` §4、PRD-013 OQ-13-3

## 1. 背景与问题

`tenants` 表已有 `plan`（裸字符串）/ `status`（Int 1）/ `expireAt` 三列，但无任何执行机制：无套餐定义、无版本、无配额、无订阅记录。直接在 `tenants` 上扩字段会立即产生三个问题：

1. **历史不可对账**：改 `plan` 字符串后，历史用量与账单无法知道当时生效的是哪一版权益；
2. **单一事实源分叉**：套餐默认值与租户特例散落在两处，无解析规则；
3. **删除字段是破坏性变更**：三库矩阵 + 既有环境回滚困难。

## 2. 决策

### 2.1 三层分离（唯一事实源）

```
plans → plan_versions          套餐定义与版本（权益描述，不可变发布）
       ↓ 绑定
tenant_subscriptions           订阅：tenant + plan_version + 有效期 + 状态
       ↓ 生成快照
plan_quotas（版本默认）→ tenant_quotas（租户覆盖）→ 生效值 = 覆盖 ?? 默认
```

- **订阅绑定 plan_version 而非 plan 最新版**：套餐升级只影响新订阅与新版本发布后的续订，历史订阅读自己的版本快照。
- **一租户至多一个生效订阅**：`tenant_subscriptions` 上建 partial unique（sqlite/pg 用过滤索引表达，mysql 变体用应用层约束 + 唯一索引 `(tenant_id, status)` 近似，见 §3.3）。
- **生效配额解析规则唯一**：`QuotaService.resolve(tenantId, quotaKey)` 内部实现 `tenant_quotas.override_value ?? plan_quotas.limit_value`，任何调用方不得自行 join 两表。

### 2.2 存量字段：派生只读，不删除

| 字段 | 处置 |
|---|---|
| `tenants.plan` | 保留为派生只读列：SubscriptionService 写路径回写当前生效套餐 code；读路径（含既有 TenantGuard/多租户解析）继续可读但不再作为权益依据 |
| `tenants.status` | 保留为派生只读列：TenantLifecycleService 迁移时回写 Int **规范码**（pending=5/active=1/grace=2/frozen=3/terminated=4；0 为存量停用只读兼容，见 §2.4），既有消费方（如 4001 判定）逐步切到生命周期服务 |
| `tenants.expireAt` | 派生只读列：随生效订阅的 `expire_at` 回写 |

- **回填策略**（OQ-13-3 定案）：一次性脚本将存量 `plan` 字符串映射到 `default` 套餐的 v1 版本（无匹配值一律 `default`）；`status=1` → `active`；`expireAt` 为空 → active 无期限。回填幂等（按 tenant id 逐条 upsert 订阅，重复执行无副作用）。
- **退役里程碑**：M14 评估删除三列；在此之前禁止任何新代码直接写这三列（写权唯一归属两个领域服务）。

### 2.3 不做

- 不做套餐 A/B、灰度、按用户级配额（超出 M13 范围，FR 边界见 PRD-013 §1.4）。
- 不引入 `plan` 枚举硬编码——套餐是数据不是代码，新增套餐零发布。

### 2.4 `tenants.status` 五态编码定案与「存量停用 / pending」兼容（2026-10-21 修正）

初稿 §2.2 曾写「pending=0」，与 `tenants.status` 自 M8 起的既有语义直接冲突：**0 一直是「停用」**，
且被三处强依赖——`@fw/tenant.assertUsable` 仅拒 0（4001 fail-closed）、租户管理端 `disableTenant`
写 0、本 ADR §2.2 回填脚本把 0 读作 frozen 并落 cancelled 订阅。驱动侧「写 pending=0 / 读 0=frozen」
因此是一张**非双射**的映射表，后果分两类：

**A. 已可达（当前代码即可复现，P0）**

1. `frozen -resume-> active` 与 `frozen -terminate-> terminated` 的条件更新按 `status = 3` 匹配，
   而存量停用行是 0 → affected=0，重读仍是 frozen（≠ 目标态）→ 4030。**经生命周期服务对存量停用
   租户做 resume/terminate 恒 4030**；唯一绕道是租户管理端直写 `status`，而那正是 ADR-0031 §2.3
   明令禁止的写路径。错误码还指向「迁移非法」，把排障引向迁移表而非编码映射。
2. `countTenantsByStatus('pending')` 按 0 计数 → 全部存量停用租户被报成「待开通」；
   `countTenantsByStatus('frozen')` 按 3 计数 → 全部存量停用被漏计。运营总览 `tenantCounts` 双口径失真。
3. 同一行状态被 `findTenantStatus` 读作 frozen、却被 `countTenantsByStatus('pending')` 计作 pending
   —— 读路径与统计路径互相矛盾。

**B. 契约地雷（当前无写入方，一旦按该表落地必然爆炸）**

4. `STATUS_TO_INT.pending = 0` 让「待开通」与「停用」共用同一编值：未来任何开通流程若按该表写
   pending，租户落库即停用——4001 与 4031 双重拒绝，且读回 frozen 使 `activate` 非法（4030），
   **永久无法开通**。本次修正即拆除该地雷（pending 独占 5）。

**定案（编值表）**：

| 编值 | 领域态 | 可写 | 说明 |
|---|---|---|---|
| 0 | `frozen` | ✗ 只读兼容 | 存量停用 / 租户管理端停用（M8 语义，保持不变） |
| 1 | `active` | ✓ | |
| 2 | `grace` | ✓ | |
| 3 | `frozen` | ✓ | frozen 的规范写码 |
| 4 | `terminated` | ✓ | |
| 5 | `pending` | ✓ | 新增；0 在既有消费方已表示停用，不能复用 |

- **读写双射**：写路径只产生 {1,2,3,4,5}，**永不写 0**；读路径 0 与 3 同读作 frozen。
- **frozen 的条件匹配与计数取「非冻结码的补集」**（`status NOT IN (1,2,4,5)`）：一次覆盖存量 0、
  规范 3 与未知脏值，使 `findTenantStatus` / `countTenantsByStatus` / `conditionalUpdateStatus`
  三者口径一致；脏值租户可经 resume/terminate 归一到规范码，不会有无法迁移的死态。
- **未知编码 fail-closed**：未登记值按 frozen 处理（未知状态绝不放行为可用），
  不再被误报为「租户不存在」（404）——`null` 唯一含义是租户不存在。
- **零迁移、可回滚**：5 是 Int 列上从未使用的空闲值，存量 0 语义不变，旧库升级零破坏。
- **pending 的鉴权面**：`@fw/tenant.assertUsable` 同拒 0 与 5（未开通租户不可用），保持 fail-closed。
- **已知遗留（不在本次范围）**：① 租户管理端 `toView` 把非 1 状态一律折叠为「停用」视图，
  grace/frozen/terminated 在管理端均显示停用；② `disableTenant` 直写 0 而非走生命周期服务，
  与 ADR-0031 §2.3「状态写权唯一归属」仍有偏差。两项均为 M14 之后待收口项。

### 2.5 订阅开通是「单事务」不变量（2026-10-20 补充）

开通订阅 = **订阅行生效** + **按 plan_version 快照写入全部 tenant_quotas**。二者不是两个步骤，
而是同一个可观测状态：只写订阅不写快照，租户即刻「已生效但权益不完整」（生效值回落到
`plan_quotas` 默认之外的空档，用量校验按无覆盖值判定）；只写部分快照则权益按条数截断。
因此定案：

- **端口只暴露一个写入口**：`SubscriptionStore.createSubscriptionWithSnapshot(sub, quotas)`，
  驱动必须在**同一事务**内写订阅行与全部快照行；任一条失败 → 整体回滚。端口**不提供**
  「只写订阅、稍后补快照」的方法（旧实现 `createSubscription` 即此形态，已移除）。
- **读在写前**：`plan_quotas` 读取在事务之外先完成（版本发布后不可变，读不引入竞态），
  读失败时库上零副作用；映射（`limit_value → override_value`、`source=plan_snapshot`）留在
  领域服务，驱动只负责原子落库。
- **失败语义**：唯一冲突 → 1003（事务内抛出，快照零落库）；其余失败原样上抛（无新增错误码）。
  失败后不得残留 `active_marker`——否则该租户重试恒 1003，等于永久无法开通。
- **验收口径**：Fake 驱动提供 `faultQuotaWriteAt` 故障注入点（第 n 条快照写入抛错），
  Prisma 驱动用 query extension 在事务内第 n 次 `tenant_quota.upsert` 抛错；两处均断言
  「订阅 0 行 + active_marker 0 行 + 快照 0 行」，并验证故障消除后同参数重试可一次写全。
  该用例对非事务实现有判别力（去掉 `$transaction` 后实测失败：残留订阅行 + active_marker）。

## 3. 影响与约束

### 3.1 数据模型

新增表结构以 `docs/47` §4.1 为准；全部走三库同构 schema（无 @relation、关联列裸 String + assert*Ids 前置校验约定不变）。

### 3.2 错误与审计

- 订阅创建冲突（已有生效订阅）复用 `CONFLICT` 1003；版本不存在复用 `NOT_FOUND` 1002；不新增错误码。
- 订阅创建/变更/取消全部走 M12 统一审计契约（六字段 + requestId）。

### 3.3 三库矩阵差异登记

| 差异点 | sqlite | postgresql | mysql |
|---|---|---|---|
| 一租户一生效订阅 | `active_marker` 列方案（三库一致） | 同左 | 同左 |
| DECIMAL 用量/限额 | BigInt（存量约定） | BigInt | BigInt |

- **active_marker 方案**：`tenant_subscriptions.active_marker` 在订阅生效时写入 `tenantId`、关闭时置 NULL；唯一索引 `(active_marker)` 对 NULL 不去重（sqlite/pg/mysql 行为一致），无需 partial index 即可表达「一租户至多一个 active」，**三库零方言分叉**，优于此前候选的「pg partial index + mysql 应用层校验」双轨方案。
- BigInt 用量/限额值沿用仓库约定（`docs/30` 数据字典逻辑描述口径）。

## 4. 后果

- 历史权益可对账（订阅留版本快照），满足 AC-13-02。
- 存量环境升级零破坏（只增列/增表 + 幂等回填），回滚脚本可完整还原。
- 代价：读路径多一层解析（resolve 缓存到 `@fw/cache`，TTL 60s，写路径主动失效——复用 setWithTags/标签失效协议）。
