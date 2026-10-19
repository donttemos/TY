<!--
@file v0.7.0 发版记录（M13：SaaS 运营基础全量）
@description 六批内容 + 主线 B 的发版事实：新迁移/seed 语义/回填/配置键/前端页面/验证矩阵与部署步骤结论。
@author donttemo
@created 2026-10-19
-->

# v0.7.0 发版记录（M13：SaaS 运营基础）

- 提交：`16377db`（六批收口）→ `44e5341`（CI 覆盖率修复）→ `a69de7c`（changelog）→ 升版 0.7.0
- CI：构建/单测/静态检查 + 三库集成矩阵（pg/mysql/sqlite）全 success
- 关联：PRD-013、ADR-0029/0030/0031、`docs/47`（开发指南）、`docs/42/48/49/97`（主线 B）

## 1. 本版变化清单（相对 v0.6.0）

| 类别 | 内容 |
|---|---|
| 新迁移 | `20261019130000_add_saas_operations`（PG 方言：M13 十表，纯 CreateTable/CreateIndex，零存量列改动） |
| seed 语义变更 | 权限点 +2（ops:saas:read/write）、菜单 +4（/saas/plans 等，挂系统管理目录）——**必须重跑 seed；存量用户需重登**（登录快照含权限码/菜单） |
| 数据回填 | `scripts/backfill-saas.mjs`（幂等）：default 套餐 v1 + 存量启用租户 active 订阅、停用租户 cancelled |
| 新配置键 | `SAAS_GRACE_PERIOD_DAYS`（默认 7，走默认零配置；已登记 envSchema/ENV_KEY_PATHS/.env.example/docs/60） |
| 错误码 | 4029 配额超限（429）/ 4030 非法生命周期迁移（409）/ 4031 租户冻结（403）——前端/模板/mock 三副本同源 |
| 新端点 | `/api/v1/saas/*` 九端点（api-spec §3.21；@IgnoreTenant + ops:saas:* 读写分离） |
| 新任务 | `saas-lifecycle-sweep`（@Cron 每小时 + 分布式锁；MQ_CRON_ENABLED 默认开） |
| 新指标 | `fw_saas_*` 段七计数器（/metrics） |
| 前端 | admin-web 运营四页（/saas/plans 等，菜单树动态路由） |
| 主线 B | docs/42/48/49/97 + .devcontainer + `.nvmrc` + CI node pin 22.22.2 |
| 行为修正 | `@fw/tenant` assertUsable 仅拒存量停用（0）；grace/frozen/terminated 透传给业务面 Guard（4031）——frozen 租户登录/导出白名单面可达（ADR-0031 §3.2） |

## 2. 部署步骤（沿 release10 范式，差异点加粗）

1. 解包 + 文件存在性断言（M13 关键文件：`packages/saas/src/index.ts`、PG 迁移、四页、smoke-saas-ops、docs/97）；
2. `pnpm install --frozen-lockfile`；
3. prisma generate（**pg schema**）；
4. 拓扑构建（`example-api...` 过滤器含 @fw/saas）+ 产物断言（saas 路由/指标段编译进产物）；
5. 前端构建（`VITE_API_BASE_URL=/api/v1`）+ 产物断言（saas 调用面）；
6. 重链 workspace bin；
7. **迁移：应用 M13 十表（PG）——预期 1 migration applied**；
8. **seed 重跑（M13 权限点/菜单）+ backfill-saas（幂等回填）——用户需重登**；
9. 原子切换 `/opt/fw/current` + `systemctl restart fw-api` + /health /ready；
10. 前端产物 rsync 到 1Panel 站点目录；
11. 验收：`/metrics` 含 fw_saas_*、admin 登录（新权限码）→ GET /saas/plans、租户订阅数（回填生效）。

## 3. 验证矩阵（部署后）

| # | 项 | 判据 |
|---|---|---|
| 3.1 | /health /ready | 200 + 就绪探针全绿 |
| 3.2 | /metrics | 含 `fw_saas_lifecycle_transitions_total{action="activate"}`（backfill 不产生——为 0 结构也过） |
| 3.3 | admin 登录 → GET /saas/plans | 200 且含 default |
| 3.4 | 租户订阅回填 | `tenant_subscriptions` 行数 = 启用租户数（backfill 报告输出） |
| 3.5 | 前端站点 | 含 saas 四页产物（assets 中 saas/ 路由 chunk） |

## 4. 真机验收结论（2026-10-19，106.55.32.251 / 1Panel）

- 部署：release `202655019215533`（build/switch 两段脚本 `wb-ssh/release11.sh`），原子切换 `/opt/fw/current`：`20261017201501-v0.6.0-fix` → 新 release；`fw-api` active，/health 200，/ready 四探针 ok。
- 迁移：`20261019130000_add_saas_operations` applied；PG 内 M13 十表 = 10。
- seed：45 权限点 / 14 菜单（M13 四页菜单在列）；**存量用户需重登**。
- backfill：default 套餐 v1（fa50269c）+ 订阅 active=3 / cancelled=1（4 租户）。
- 验收：`/metrics` 含 `fw_saas_*` 28 行；E2E（服务器侧 127.0.0.1）——admin 登录 → GET /saas/plans（default）→ acme freeze（frozen 落库）→ acmeadmin 登录（白名单面可用）→ resume（active）→ 迁移历史 freeze,resume ✓。
- **HTTPS 外网**：`https://cs.donttemo.top/` 200，前端产物含 saas 引用。
- **登记（非缺陷）**：真机 `.env` `TENANT_ENABLED=false`（单租户模式）——4031 冻结拦截按 ADR-0031 §3 设计在此模式下不生效（无租户上下文放行）；生命周期迁移本身正常（条件更新/日志全链 ✓）。启用多租户拦截 = `TENANT_ENABLED=true` + 重启（数据层 M8 迁移就绪），属产品形态决策，未擅自变更。
- HTTPS `/api/v1/health` 404 为既有 nginx 路径布局（/health 不在 /api/v1 前缀下），与本版无关。

## 4. 遗留

- 三库矩阵已由 CI 完成（pg/mysql/sqlite 三腿）；真机为 PG 单库；
- admin-web 真机页面的视觉验收（菜单四项出现 + 页面可开）随部署后人工点检。
