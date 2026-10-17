<!--
@file ADR-0027 · 运维端点安全边界
@description M12 W3（PRD-012 OBS-15~OBS-19）的决策记录：maintenance 三层边界、默认受保护原则、
  OQ-4 鉴权形态定案、demo 自检面收敛、部署侧一致性断言。
@author donttemo
@created 2026-10-17
-->

# ADR-0027 · 运维端点安全边界

- 状态：**已采纳**（2026-10-17）
- 关联：PRD-012（OBS-15~OBS-19）、ADR-0024（key-ring 零敏感契约）、ADR-0025（审计事件契约）、`docs/46` 矩阵

## 1. 决策

### 1.1 三层模型与默认受保护原则（OBS-15）

```
Public 自检层      /health /ready /metrics /metrics/queue   无鉴权（探针/抓取），零敏感
Protected 层       /api/v1/auth-maintenance/*               权限码 ops:read 守卫 + 全端点 no-store
业务公开面         login/register/refresh/oauth2/client-errors/events   本身要求公开，逐条登记理由
```

**关键原则反转**：默认受保护，公开需**显式白名单 + 书面理由 + 契约测试**（`docs/46` 矩阵为登记处）。
落地：`MaintenanceController` 移除类级 `@Public()`，改 `@Permissions(PERM.OPS_READ)`；未登录 3001 /
无权限 3002；三条路由统一 `Cache-Control: no-store`（此前仅 key-ring 有）。

### 1.2 OQ-4 定案：权限码方案（`ops:read`）

- **采纳权限码**：进 `PERM` 权威表 + example-api seed 声明 + admin 角色全量授权——复用既有 RBAC、
  审计链路与菜单权限模型，零新体系。
- **`OPS_TOKEN` 逃生门：登记备选，未启用**。理由：当前所有部署形态都有用户体系与 admin 角色；
  「无用户体系部署」场景尚未出现，先不加双轨鉴权（守卫叠加的判定顺序复杂度不划算）。触发条件
  （未来出现无 RBAC 的部署）成立时再补：Guard 前置校验 `X-OPS-Token`（常量时间比较），配置键
  `OPS_TOKEN` 登记即用。
- key-ring 维持 Protected 层（不再公开自检）：其零敏感契约（ADR-0024）继续由契约测试锁定，公开性
  收敛后损失为零（运维仍可经 admin 持权访问）。

### 1.3 demo 自检面收敛（OBS-16）

`DemoEndpointsGuard` 应用到 `demo*` / `cache-demo` / `demo-queue` / `demo-transport` 四个自检控制器：
`DEMO_ENDPOINTS_ENABLED` 显式 true/false 优先；未设置按 `APP_ENV=dev`/`NODE_ENV=development` 判定
（默认安全方向：非 dev 即关）。关闭时 **404**（不暴露端点存在性，而非 403）。`demo-item` 等业务演示
数据源走 RBAC，不在自检面范畴（`docs/46` §4）。

### 1.4 快照契约统一（OBS-18）

任务快照公共字段集冻结为 `{ name, expression, enabled, runs, lastRunAt, lastDurationMs, lastError }`
+ 各自特有段（refresh-cleanup：`lastCutoff/lastRemoved/lastCiphersCleared`；audit-archive：
`retentionDays/batchSize/lastCutoff/lastArchived/lastCounts`；key-ring：独立零敏感形状）。本批 additive
补 `enabled`（= `MQ_CRON_ENABLED`）与 audit-archive 的 `lastDurationMs`；`lastCutoff` 在两任务中语义
同为「最近一次运行截止线」（非同义字段并存，保留并由契约测试锁定形状）。

### 1.5 部署侧一致性（OBS-19）

三份 Nginx 配置（`fw.conf` / `fw-host.conf` / `fw-1panel-locations.conf`）由 `check:helm` 扩展轴断言：
① 免鉴权探针白名单覆盖集一致（health/ready/metrics）；② **maintenance 不上公网**——任何一份都不得为
`auth-maintenance` 建立公开放行（应用层权限码为主，部署侧为纵深，不放大暴露面）。真机实测（1Panel
环境）登记待执行（与 AC-OBS-13 排障样例实测同批）。

## 2. 备选与取舍

| 备选 | 否决理由 |
|---|---|
| `OPS_TOKEN` 运维 token 为主 | 双轨鉴权（token vs RBAC）判定顺序复杂；现有部署均有 admin 角色，权限码零新体系 |
| maintenance 保持公开 + 仅部署侧白名单 | 边界靠部署层「碰巧」而非设计；应用层与部署层双保险（本 ADR）才是纵深 |
| demo 面关闭返回 403 | 403 暴露端点存在性；404 与「路由不存在」不可区分 |
| `/health` 改名 `/liveness` | K8s 探针映射与监控配置已按现路径登记，改名即破坏部署契约（OBS-17 明确不重命名） |

## 3. 影响

- `PERM.OPS_READ`（'ops:read'）进权威表；seed 变更 ⇒ 存量环境需 reseed 或手工补权限点 + admin 授权。
- demo 面在 test/prod 默认 404 ⇒ smoke-auth 等演示相关冒烟需在 dev 环境或显式 `DEMO_ENDPOINTS_ENABLED=true` 下运行。
- 新配置键 `DEMO_ENDPOINTS_ENABLED`（ENV_KEY_PATHS + `.env.example` + `docs/60` §3）。
- 锁定测试：`auth-maintenance.contract.spec.ts`（元数据 + 快照公共字段集）、`demo-endpoints.guard.spec.ts`。
