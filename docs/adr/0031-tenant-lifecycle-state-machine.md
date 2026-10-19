<!--
@file ADR-0031 · 租户五态生命周期状态机
@description M13（PRD-013 FR-13-10~12）租户生命周期定案：pending/active/grace/frozen/terminated 五态、
  合法迁移表、迁移唯一归属 TenantLifecycleService、条件更新幂等 + 分布式锁双保险、
  冻结的业务入口作用点与放行白名单、数据保留策略。
@author donttemo
@created 2026-10-19
-->

# ADR-0031 · 租户五态生命周期状态机

- 状态：**已采纳**（2026-10-19；M13 P1 契约冻结）
- 关联：PRD-013 FR-13-10~12/14、ADR-0029（tenants.status 派生化）、ADR-0030（到期任务与扣减的衔接）、PRD-013 OQ-13-3

## 1. 背景与问题

`tenants.status` 目前是自由 Int，无迁移校验：任何代码可写任意值；无到期自动处置；冻结不作用于业务请求。需要统一：谁能改状态、合法路径有哪些、重复执行与重启如何保证幂等、冻结后什么还能用。

## 2. 状态与迁移表

### 2.1 五态

`pending`（已创建未开通）→ `active`（正常）→ `grace`（订阅到期宽限）→ `frozen`（限制使用）→ `terminated`（终止，进入保留/清理）

### 2.2 合法迁移（唯一权威表）

| from | action（触发方） | to | 前置条件 | 副作用 |
|---|---|---|---|---|
| pending | activate（运营 API / 开通流程） | active | 存在生效订阅 | 审计 + 通知 |
| active | freeze（运营 API） | frozen | — | 审计 + 通知 + 失效租户缓存 |
| grace | freeze（宽限期满，系统任务） | frozen | grace 截止时间已过 | 同上 |
| active | expire（系统任务） | grace | 订阅 expireAt 已过且宽限窗口 > 0 | 审计 + 通知 |
| grace / frozen | resume（运营 API；含续订） | active | 存在有效订阅（grace→active）或新订阅（frozen→active） | 审计 + 通知 |
| active / grace / frozen | terminate（运营 API） | terminated | — | 审计 + 通知 + 启动保留期任务 |
| terminated | （系统任务）保留期满处置 | 终态，无迁出 | 保留期满 | 按策略导出/删除业务数据，审计留存 |

**其余全部迁移非法**，返回 `LIFECYCLE_TRANSITION_INVALID` **4030**（details 含 from/action/to）。

### 2.3 实现约束

1. **写权唯一归属**：`TenantLifecycleService.transition(tenantId, action, reason, actor)`。控制器、定时任务、seed 一律不得直写 `tenants.status`（review 门禁人工执行项 + 服务不导出底层 update）。
2. **幂等 = 状态条件更新**：`UPDATE tenants SET status=:to ... WHERE id=:id AND status=:from`；affected rows = 0 → 重读判定（已是目标态则返回幂等成功标记 `alreadyApplied: true`，否则 4030）。
3. **双保险**：任务执行外加 `@fw/cache` 分布式锁（`lifecycle:sweep` 单键），多实例部署下避免重复扫描浪费；锁不可用时条件更新仍保证正确性——**正确性不依赖锁**。
4. **到期扫描任务**：分布式定时（复用 @fw/scheduler db 驱动），扫描 `expireAt` 过期且 `status=active` 的订阅 → grace；grace 截止已过且 `status=grace` → frozen。每次循环只处理批次上限，失败单条记录不中断整批；进程重启无内存态、自然续跑（AC-13-08）。

## 3. 冻结/终止的作用点与白名单

### 3.1 作用点

全局 Guard（RbacGuard 之后、业务 Handler 之前）校验请求上下文租户的生命周期状态：`frozen/terminated` → 拒绝业务请求 **4031**（`TENANT_SUSPENDED`）。

- 判定读生命周期服务的缓存（60s TTL）+ 迁移写路径主动失效（与 ADR-0029 §4 同一失效协议）。
- 状态来源是 `tenants.status`（派生列，ADR-0029），Guard 不额外查订阅表——冻结是租户级事实，不是订阅级。

### 3.2 放行白名单（仅冻结场景）

| 能力 | frozen | terminated |
|---|---|---|
| 管理端登录 / 自身信息读取 | ✅ | ❌（4031） |
| 业务数据导出 API | ✅ | 保留期内 ✅（期满后 ❌） |
| 生命周期查询 / 账单查询 | ✅ | ✅（只读） |
| 其余业务写/读 | ❌ 4031 | ❌ 4031 |

白名单以路由元数据（`@LifecycleExempt()` 装饰器）登记，默认拒绝；装饰器使用点入检查清单，防止业务代码随手豁免。

## 4. 数据保留策略（terminated 之后）

- 保留期默认 30 天（配置键 `SAAS_TERMINATED_RETENTION_DAYS`，入 `.env.example` + PRD/60 登记门禁）。
- 处置动作（策略可配，默认 `export_then_delete`）：归档业务数据到审计存储 → 删除业务表行 → **审计记录与生命周期日志永不删除**（AC-13-12）。
- 处置任务逐租户事务执行，失败可重跑（条件：status=terminated 且保留期满且未处置标记）。

## 5. 错误码与审计

- 4030 `LIFECYCLE_TRANSITION_INVALID`（http 409）、4031 `TENANT_SUSPENDED`（http 403）——error-codes.ts 三副本同步。
- 全部迁移与任务副作用走 M12 审计契约（actor_type=system/user、reason、六字段），AC-13-10 的跨租户隔离由既有 RbacGuard + 数据权限四档承载，不新增机制。

## 6. 后果

- 状态机成为唯一权威，非法迁移不可能落库；存量 `status` Int 值经回填映射后语义收敛（ADR-0029 §2.2）。
- 到期自动化不再需要人工盯 `expireAt`；宽限期时长配置化（`SAAS_GRACE_PERIOD_DAYS`，默认 7 天）。
- 代价：所有状态写路径收口到单服务，短期灵活性下降——这是有意的（该灵活性正是缺口来源）。
