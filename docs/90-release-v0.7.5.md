<!--
@file v0.7.5 发版记录（M14：Admin Web 产品化与 SaaS 运营体验升级 B1~B3）
@description 三批内容的发版事实：正确性修复 / 运营 API 闭环 / 页面产品化。零迁移、零 seed 变更、
  零新错误码——存量环境纯代码更新即用。验证矩阵与遗留清单见 §3/§4。
@author donttemo
@created 2026-10-20
-->

# v0.7.5 发版记录（M14：Admin Web 产品化与 SaaS 运营体验升级 B1~B3）

- 关联：PRD-014（docs/prd/prd-014-admin-web-productization.md，M14 草案）；无新 ADR（沿 ADR-0025/0026/0029~0031 既有契约）
- 特性：**零迁移 / 零 seed 变更 / 零新错误码**（沿 1001/1002/1003 与 M13 十表）；版本升版 17 个 package.json（0.7.0 → 0.7.5）
- 验证基线：admin-web 206/206 + vue-tsc 全绿；@fw/saas 29/29（覆盖率 91.6/81.8/88.2/94.1）；example-api saas 30/30；smoke-saas-ops 29/29；smoke-mock 140/140；headers（673）/ api-parity / triway 七轴 / no-raw-throw 门禁全绿（均为本机实测，CI 结论见推送后 run）

## 1. 本版变化清单（相对 v0.7.0）

| 批次 | 类别 | 内容 |
|---|---|---|
| B1 | 行为修正 | 生命周期迁移与订阅取消的**操作原因端到端落库**（M13 缺陷：确认框输入被丢弃，U-14-1） |
| B1 | 新端点 | `GET /saas/tenants/:id/lifecycle/status`（`{status, allowedActions}`，allowedActions 由 ADR-0031 迁移表派生） |
| B1 | 前端 | 生命周期页真实状态驱动（非法动作禁用 + 提示 + 无状态空态）；SaaS 四页写按钮补 `v-permission`（`ops:saas:write`）；用量页切换租户即重置（消除残留） |
| B2 | 新端点 | `POST /saas/plans`（创建，code 唯一 → 1003）；`POST /saas/plans/:id/versions`（发布版本，版本 +1 不可变，limitValue 归一 BigInt，字典未登记 → 1002）；`GET /saas/tenant-subscriptions`（分页 ≤200 + 五参数白名单过滤 + tie-breaker 排序）；`GET /saas/tenants/:id/subscriptions/history`；行内补 `planCode/planName/planVersion` |
| B2 | 存储 | `SaasStore` 端口 +`listSubscriptions`/`listSubscriptionsByTenant`（Fake 与 Prisma 双实现同语义；三库矩阵由 CI 集成用例覆盖） |
| B2 | 审计 | 新事件 `saas.plan.create` / `saas.plan.publish`（M12 六字段契约 + after 快照） |
| B3 | 组件 | `ConfirmWithReason`（全站唯一原因收集入口：trim 归一 / required 拦截 / 取消=null；危险动作必填）；`TenantPicker`（可搜索租户选择器，复用 /tenants keyword 查询） |
| B3 | 前端 | 订阅页重构为**列表优先视图**（全局列表/筛选/分页 + 详情抽屉含租户订阅历史）；套餐页**创建 + 发布闭环**（FormDialog 新建；发布 = 复制上版 → 行级编辑 → 差异预览（added/removed/changed）→ 确认）；生命周期/用量/订阅三页租户输入换 TenantPicker |
| 同步 | 契约 | api-spec §3.21 九端点 → 十四端点；mock handlers 同构同步；前端 API 封装同步 |

## 2. 部署步骤（纯代码更新，无迁移）

1. 服务器 `cd /opt/fw && git fetch && git checkout <release-tag>`（release 目录范式沿 docs/63）。
2. `pnpm install --frozen-lockfile`（版本号变更不引入新依赖；如 CI 提示 lockfile 无关可跳过）。
3. `pnpm build`（全仓构建；**无需** migrate / seed / backfill）。
4. 重启 systemd：`systemctl restart fw-api`；Nginx/1Panel 静态产物更新（index.html no-cache 头已由 v0.7.0 根治）。
5. 用户浏览器强刷或等 no-cache 生效（前端产物 hash 变更）。

**回滚**：切回上一 release 目录重启即可（无 schema/seed 依赖，纯代码版本）。

## 3. 验证矩阵

| 项 | 结果 |
|---|---|
| admin-web vitest（26 文件） | 206/206 ✓（190 基线 + 16 新增：组件 8 + SaaS 视图 8） |
| admin-web vue-tsc | 0 错 ✓ |
| @fw/saas（含 test:coverage） | 29/29 ✓；覆盖率 91.62 / 81.81 / 88.23 / 94.11（门禁达标） |
| example-api saas（控制器 + 集成） | 30/30 ✓（控制器 12 例；Prisma 集成含列表过滤/分页/排序，CI 三库矩阵覆盖） |
| smoke-saas-ops（端到端，dist 实测） | 29/29 ✓（S14 七项：创建/重复 1003/字典 1002/发布/列表/历史/状态端点） |
| smoke-mock（全链路 + bundle 门禁） | 140/140 ✓ |
| 门禁 | headers 673 文件 / api-parity / triway 七轴 / no-raw-throw 全绿 ✓ |
| CI 三库矩阵 | 025df3f 与 15fb621 两个提交四腿全 success（base + pg/mysql/sqlite）✓ |
| **真机部署 + E2E（2026-10-20，release 20261020122812）** | 零迁移纯代码更新（拉包 → install → prisma generate → 双端 build → systemd 重启 → 1Panel 站点同步）；**AC-14 E2E 24/24 通过**：AC-14-01 原因端到端（API + PG DB 双层断言 `tenant_subscriptions.reason` / `tenant_lifecycle_logs.reason`）、AC-14-05 菜单/路由/越权（permissions 2/2、menus 4 条、alice 403/3002 跨租户维护守卫拦截）、AC-14-11 核心旅程（创建含重复 1003 → 发布 v1 → 订阅绑定 → 用量上报 → 趋势 25 桶 → 明细 → 总览 → 状态端点）；错误通道修正实测 400/1001。注意：真机 `quota_definitions` 为空表（v0.7.0 backfill 未含字典），E2E 以幂等 INSERT 前置，且「字典未登记 → 1002」校验恰好被首轮实测证效 |

## 4. 遗留与后续

- **B4（P2，待评审）**：已交付（2026-10-20，commit 025df3f，未含本版版本号，CHANGELOG 归 [Unreleased]）——用量趋势/明细/overview 三端点 + 用量页看板化 + 工作台运营首页；OQ-14-3 定案查询时聚合零迁移；**错误通道修正（15fb621）补齐 M13 遗留三处信封直返**，SaaS 运营端点 15 处入参校验全部走异常过滤器。
- **OQ-14-1~5 待评审**：发布差异预览前后端分工（当前前端 diff）、订阅升级/降级/续期（默认不进 M14）、租户上下文载体（路由 query 语义未固化）、原因必填策略（当前 freeze/terminate/dispose 必填）。
- **真机窗口验收项**：AC-14-02/03/04/06/07/12 的浏览器级回归（按钮渲染层已由 admin-web 212 单测覆盖，浏览器抽查留人工）；AC-14-11 的浏览器菜单点击回归（API 层已过）。
- **数据缺口（本次 E2E 发现）**：`quota_definitions` 无运营面 CRUD 端点——新指标只能经 `publishVersion` 的 `definitions` 入参补登记或 DBA 直写；真机空表现已由 E2E 幂等 INSERT 补 `api_calls(day/hard)`。建议后续批次补配额字典运营端点（小 FR）。
