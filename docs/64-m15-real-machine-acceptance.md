<!--
@file M15 真机验收报告（cs.donttemo.top）
@description 2026-10-21 在真机（腾讯云 2C2G4M / 1Panel / PostgreSQL 18.6 / cs.donttemo.top）上完成
  M15 审计线（PRD-015）的部署与端到端验收记录：部署过程与实测数据、七类事件触发与查库取证、
  四档 dataScope 范围、租户隔离端到端（P1 安全修复）、导出范围与脱敏扫描、性能 sanity、
  三处同口径抽样；以及环境限制（单租户档位 / 配置中心未启用 / 归档未运行）与真机暴露的缺陷线索。
  验收对象：origin/main @ 2f30084（含 d806a82 平台审计前端与双租户验收自动化，CI run 107 四腿全绿）。
  本报告是证据登记材料；PRD-015 §7.4 的 13 步真机取证清单中，步骤 1~8（API 侧）已执行，
  步骤 9~13（浏览器/前端）与归档腿待后续窗口，均未达到 AC 勾选标准，零 AC 关闭。
@author donttemo
@created 2026-10-21
@module docs
-->

# M15 真机验收报告（cs.donttemo.top）

> 验收时间：2026-10-21 12:49~13:55 CST｜部署版本：`2f30084`（origin/main）｜服务：`fw-api`（systemd）
> 数据库：1Panel PostgreSQL 18.6（容器 `1Panel-postgresql-MXHt`，宿主 5432）｜缓存/队列：Redis（bullmq）
> 结论：**API 侧验收全部通过（A 段 32/32 + B 段范围/租户/导出/性能/同口径全过）**；三项环境限制与四项
> 缺陷线索如实登记（§5 #1 空 tenantId 校验、#4 seed 清场范围均已于 2026-10-21 修复，真机复测待部署窗口）；
> **零 AC 勾选**（证据不足以签字的项保持未勾选，口径见 PRD-015 §7）。

## 1. 部署记录（c192885 → 2f30084）

真机原运行 `c192885`（2026-10-18，pre-M15，落后 32 个提交）。本次按 `docs/62` 手册的发版路径升级：

| 步骤 | 命令/动作 | 结果 |
|---|---|---|
| 备份 | `docker exec 1Panel-postgresql-MXHt pg_dump -U fw -d fw \| gzip` → `/opt/fw/shared/backups/fw-pre-m15-20261021124950.sql.gz` | 37 KB（旧数据量小） |
| git 凭据 | PAT 经 stdin 落 `/opt/fw/.git-credentials`（600 root）+ root `credential.helper=store` + `safe.directory` | 后续 fetch/clone 免交互 |
| 常驻 clone | `git clone https://github.com/donttemos/TY.git /opt/fw/shared/repo`（chown fw:fw） | 手册设计的 `$SHARED_DIR/repo` 此前不存在，本次自建 |
| 发版 | `sudo PRISMA_SCHEMA=prisma/pg/schema.prisma WEB_SYNC_DIR=/opt/1panel/www/fw-web bash deploy/scripts/bare-metal-deploy.sh`（nohup  detached，日志 `/tmp/deploy-2f30084.log`） | **12:53:52 起 → 12:55:26 发布成功**，总计约 94s |
| 构建 | pnpm install 16.5s（store 热）→ prisma generate（PG，358ms）→ 15 包 tsc → admin-web vue-tsc+vite（1928 模块，含 `platform-*.js` 新 chunk）→ bin 补链 → 前端 rsync 到站点目录 | 产物断言「含 /api/v1 基址」通过 |
| 迁移 | `fw db:migrate --schema=prisma/pg/schema.prisma`：11 个迁移，新应用 `20261020120000_add_audit_business_snapshot` | `audit_logs` 新增 5 列（summary/target_label/actor_label/reason/audit_source）已核实 |
| 切换+重启 | 软链 `20261020122812 → 20261021125353-2f30084`，`systemctl restart fw-api` | 健康检查通过，自动回滚机制待命未触发 |
| reseed | `sudo -u fw bash -c 'set -a; . /opt/fw/shared/.env; set +a; pnpm exec tsx prisma/seed.ts'` | 6 角色（四档 dataScope + tenant_auditor）/ 21 账号 / 4 租户 / 45 权限点 |
| 公链链路 | 服务器侧 `curl -k https://cs.donttemo.top/api/v1/auth/login` → token（422 字符）→ `/audit-logs/events`（32 条注册表） | nginx → 127.0.0.1:3000 全链路通 |

> 证据目录：`/opt/fw/shared/verify-20261021-m15/`（原始响应、CSV 产物、DB 查询输出）。
> 旧版回滚：`bash deploy/scripts/bare-metal-deploy.sh --rollback`（迁移不随回滚撤销，本次迁移为加列，向前兼容）。

## 2. 事件触发与数据库取证（对应 AC-15-13 / 15-03 / 15-02）

通过管理 API 真实触发并用 PG 直查取证（`audit_logs` 分组统计，证据 `db-events.txt`）：

| 事件类 | 事件码 | 触发方式 | 结果 |
|---|---|---|---|
| 认证 | `auth.login` / `auth.login_failed` | 全员登录；frank 错误口令 | success + denied（3001）均落库 |
| 权限拒绝 | `authz.denied` | grace（无 role:read）打 `/roles`；acmeauditor 打 `/audit-logs/platform` | 两条 3002 均落库 |
| 套餐发布 | `saas.plan.create` / `saas.plan.publish` | 建 `acc-plan` → 发布版本（api_calls=3 hard） | success |
| 订阅 | `saas.subscription.create` / `saas.subscription.cancel` | 开通→取消（带原因）→重建 | success ×4 |
| 配额 | `saas.quota.exceeded` | 用量上报 10 > 限额 3 | **4029 + denied 事件** |
| 生命周期 | `saas.lifecycle.freeze` / `saas.lifecycle.resume` | 冻结→恢复验收租户 | success |
| 配置变更 | `config.change` | — | **环境门控：CONFIG_CENTER_ENABLED=false，在线写入返回 1004，真机不可触发**（见 §4） |
| 附证 | `auth.permission_grant` / `tenant.create` | 角色补授权；建验收租户 | 均落库（后者 module=tenant） |

- **四态**：`success 50` / `denied 10`（`failed`/`unknown` 未触发——需故障注入，见 §4）。
- **audit_source**：`domain 60`（清单内端点领域层显式记录）。
- **快照完整性**：有用户上下文的 domain 行 `summary`/`actor_label` 缺失 **0**；6 条无用户行（登录限流拒绝 `rate_limited`）actor 为空属预期（无用户可命名）。
- **target_label 名称快照（P1 收口的真机证据）**：
  - `saas.subscription.cancel :: 存量单租户 · 基础版`（租户名 · 套餐名）
  - `saas.subscription.create :: 真机验收租户 · 真机验收套餐`
  - `saas.quota.exceeded :: 真机验收租户`
  - 早期脚本空 tenantId 场景落 `名称快照缺失 · 真机验收套餐`（显式缺失声明，非裸 ID）
  - 裸 ID 命中数 **0**（P1 修复在真机生效）。

## 3. 范围 / 租户 / 导出 / 性能 / 同口径（对应 AC-15-07 / 15-09 / 15-11 / 15-12 / 15-06）

### 3.1 四档 dataScope（列表可见集合 + 详情越权）

账号-部门夹具：alice（self，前端组）、dave（org，前端组）、carol（org，研发部）、bob（org_below，研发部负责人）、grace（self，市场部）、admin（all）。

- **集合单调包含**：`{alice} ⊆ dave(rd-fe) ⊆ bob(rd 子树) ⊆ admin`；org 档 carol 只见研发部本人+bob（不见前端组 dave）；bob 不见市场部 grace。**8/8 断言通过**。
- **详情越权（P1 修复直接证据，范围外统一 404）**：alice→bob 404、carol→dave 404、bob→grace 404；alice→自己 200、carol→bob 200、bob→frank（后端组，子树内）200、admin→任意 200。**7/7 通过**。

### 3.2 租户隔离端到端（P1 租户分维）

| 断言 | 结果 |
|---|---|
| acmeauditor（tenantId=1）显式 `tenant_id=0` → **4001**（禁跨租户，不静默改写） | 通过 |
| acmeauditor `tenant_id=1`（同租户收窄）→ 放行 | 通过 |
| acmeauditor 详情租户 0 行 → **404**（归属人 + 租户双维度） | 通过 |
| acmeauditor 打 `/audit-logs/platform`（列表/详情）→ **3002**（无 `system:tenant:ignore`，维护入口不因租户身份放宽） | 通过 |
| admin 普通列表可见租户集合 = {0}（`all` 只解除归属人限制，**不跨租户**） | 通过 |
| admin `/audit-logs/platform` 全局检索 100 行；`?tenant_id=1` 收窄放行；platform 详情 200 | 通过 |

### 3.3 导出（范围一致 + 业务列 + 脱敏）

- **范围无泄露**：carol（org）导出 22 行、alice（self）导出 11 行，CSV `userId` 集合与各自列表**完全一致**；admin（all）导出 165 行 ⊇ 列表 100 行（无丢失；多出行为验收期间并发新增，见 §4）。
- **列序**：23 列，前 15 列原样，末尾追加 `eventName,summary,targetLabel,actorLabel,reason,result,auditSource,risk`（AC-15-11 真机确认）。
- **脱敏零命中**：CSV 与详情响应对 `eyJ`（JWT）/ `Bearer` / 密码字面量 / `secret` / `passwordHash` / token 字段扫描 **0 命中**；`"via":"password"` 为登录方式元数据（合法，非敏感）。

### 3.4 性能 sanity（AC-15-12 链路口径）

n=30/组：无过滤列表 p50=29ms / p95=30ms；带 `result+event` 过滤 p50=29ms / p95=31ms；注册表端点 p50=29ms。带过滤/无过滤比值 **0.99~1.01（≤1.2）**。**注意**：种子数据量下数字只证链路，不满足 AC-15-12「真机数据量」口径（见 §4）。

### 3.5 三处同口径（AC-15-06）

同一 `saas.plan.publish` 行：注册表名称「发布套餐版本」/风险 high **==** CSV `eventName`/`risk`；详情 `summary`/`result` **==** CSV 对应列。名称经注册表唯一权威供给（列表/详情前端 join、CSV 服务端 join），`summary`/`result` 为行内快照——三处同源同口径成立。**归档腿未取证**（归档表 0 行，见 §4）。

## 4. 环境限制与未取证项（不满足 AC 勾选标准的部分）

| # | 限制 | 影响 | 处置 |
|---|---|---|---|
| 1 | **单租户档位**：`TENANT_ENABLED=false`（现网单域名部署）。开启后 `TenantService.resolve` 对无租户标识请求 fail-closed 抛 4001——**apex 域名的登录请求（无 JWT/子域名/头）会被拒**，与现网不兼容，故未开启 | 审计写入 `tenant_id` 恒 0（请求上下文无租户）；租户 1 的**写入侧**真机取证不可行 | 查询侧（4001/404/platform）已完整取证；写入侧多租户证据以 CI 真实库集成 + 双账号冒烟（`d806a82` → run 107，A 级）为准；真机多租户写入需专门部署窗口 |
| 2 | **配置中心未启用**：`CONFIG_CENTER_ENABLED=false`，在线改配置返回 1004 | `config.change` 事件真机不可触发（七类缺一类） | 环境门控记录；该类证据以单测/CI 为准 |
| 3 | **归档任务未运行**：`audit_log_archives` 0 行 | 三处同口径的归档腿、归档双账号核对（PRD-015 §7.4 步骤 11~12）未取证 | 待归档任务触发后补测 |
| 4 | `failed`/`unknown` 四态、前端「未知/存量」标注截图、浏览器步骤（§7.4 步骤 9~10、13）未做 | AC-15-03/15-09 的部分证据 | 需故障注入与浏览器窗口 |
| 5 | 性能数字为种子数据量 | AC-15-12 不满足「真机数据量 p95」口径 | 部署窗口以真实数据量复测 |
| 6 | **并行会话并发**：验收期间另一会话在同机跑自有验收（selfscope/acmeadmin 登录与本验收交错） | 行计数有漂移（admin 导出 165 vs 列表 100 的时间差即此故） | 集合级断言不受影响；并发写只增不减 |

## 5. 真机暴露的缺陷与线索（需后续处理）

| # | 现象 | 性质 | 建议 |
|---|---|---|---|
| 1 | `POST /saas/tenant-subscriptions` 接受**空 tenantId**（`{"tenantId":""}` 返回 code 0 并建出 `tenant_id=''` 的订阅行） | **输入校验缺口**（CreateSubscriptionBody 未校验非空）→ **已修复（2026-10-21）**：控制器拒绝空白 `tenantId`/`planCode`（`400/1001`）并校验租户存在（`404/1002`），`SubscriptionService.create` 补领域不变量 + `trim` 归一；`smoke-saas-ops` 新增 S4.0~S4.2 负例（本地 37/37）。真机残留 2 条已在本次清理，真机复测待下一次部署窗口 | 控制器/DTO 补非空校验（已落地）；真机按 S4.0~S4.2 复测 |
| 2 | `dept_leader`/`dept_member`/`self_updater` 示范角色未授 `auth:me`，`/auth/me` 返回 3002 | 种子缺口（示范角色连本人信息都取不到） | seed 的 scopeDemoGrants 补 `PERM.AUTH_ME` |
| 3 | 登录限流约 10 次/分钟/IP，批量验收连登即 9003 | 既有安全策略，验收脚本需 12s+ 间距 + 65s 退避（已适配） | 文档化即可 |
| 4 | seed 的 `truncate()` 不清 SaaS 表（plans/subscriptions/quotas），reseed 后旧 SaaS 数据被新租户 ID 继承（租户 0 沿用旧生效订阅） | 观察项 → **已修复（2026-10-21）**：`truncate()` 追加**租户级** SaaS 数据（tenant_subscriptions / tenant_quotas / tenant_quota_windows / usage_events / usage_rollups / tenant_lifecycle_logs）与 audit_log_archives——ID 复用即数据归属错误（新租户「已有生效订阅」→ 开通 1003、继承旧用量）；目录类（plans / plan_versions / plan_quotas / quota_definitions）**刻意保留**（非租户数据，且保留 reseed 后的可操作样本）。验证：reseed 后 7 张表计数归零、目录数据保留，`smoke-saas-ops` 连续两次 37/37 | 已落地；`smoke-saas-ops` S4 兼作该缺陷的回归探针 |

## 6. 复跑方式

```bash
# 部署（手册路径）
sudo PRISMA_SCHEMA=prisma/pg/schema.prisma \
     WEB_SYNC_DIR=/opt/1panel/www/fw-web \
     bash /opt/fw/shared/repo/deploy/scripts/bare-metal-deploy.sh

# reseed（验收夹具）
cd /opt/fw/current/apps/example-api && sudo -u fw bash -c \
  'set -a; . /opt/fw/shared/.env; set +a; pnpm exec tsx prisma/seed.ts'

# 证据目录
/opt/fw/shared/verify-20261021-m15/   # list-*.json / export-*.csv / db-*.txt / detail-sample.json
```

> ⚠️ reseed 是破坏性操作：2026-10-21 起清场范围含**租户级 SaaS 数据**（订阅 / 配额覆盖 / 窗口用量 /
> 用量事件 / 用量汇总 / 生命周期日志）与 `audit_log_archives`（口径见 docs/60 §15 注）。验收期间重跑会清空
> 已有订阅与用量——与他人并行验收时先确认，必要时先 `pg_dump` 备份。

## 7. 结论与后续

- **已取证（A 级，真机）**：七类中六类事件触发 + 查库；四档 dataScope 列表/详情/导出范围与越权 404；租户隔离查询侧全断言；导出范围一致 + 业务列 + 脱敏零命中；三处同口径（在线+CSV）；名称快照无裸 ID。
- **仍未取证**：多租户写入侧（环境门控）、`config.change`（环境门控）、归档腿、failed/unknown 四态、浏览器步骤、真机数据量性能。均登记于 PRD-015 §7.4 清单，待部署窗口。
- **AC 状态**：本次 **零 AC 勾选**（证据口径见 PRD-015 §7「代码 ≠ 证据」）；§7.4 步骤 1~8 已完成，9~13 待后续。
- **缺陷线索 4 项**见 §5，建议排入下一迭代。
