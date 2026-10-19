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
| `tenants.status` | 保留为派生只读列：TenantLifecycleService 迁移时回写 Int 映射（pending=0/active=1/grace=2/frozen=3/terminated=4），既有消费方（如 4001 判定）逐步切到生命周期服务 |
| `tenants.expireAt` | 派生只读列：随生效订阅的 `expire_at` 回写 |

- **回填策略**（OQ-13-3 定案）：一次性脚本将存量 `plan` 字符串映射到 `default` 套餐的 v1 版本（无匹配值一律 `default`）；`status=1` → `active`；`expireAt` 为空 → active 无期限。回填幂等（按 tenant id 逐条 upsert 订阅，重复执行无副作用）。
- **退役里程碑**：M14 评估删除三列；在此之前禁止任何新代码直接写这三列（写权唯一归属两个领域服务）。

### 2.3 不做

- 不做套餐 A/B、灰度、按用户级配额（超出 M13 范围，FR 边界见 PRD-013 §1.4）。
- 不引入 `plan` 枚举硬编码——套餐是数据不是代码，新增套餐零发布。

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
