# v0.5.0 发布验收报告

> 版本：**v0.5.0** ｜ 发布范围：**M10（PRD-010）P0 + P1 阶段交付**——多实例一致性收口（E-01 任务中心驱动化 / E-02 配置中心多实例语义 + nacos 转正 / E-03 框架级 API 限流 / E-04 权限树契约落地）+ 规模化遗留（E-06 Redis Cluster 实测收口 / E-07 OAuth2 授权码端到端 + apikey 签名验签）+ 遗留缺陷收口（N-03 / R4-06 / R4-05）｜ 验收日期：2026-10-15 ｜ 验收人：donttemo（L0 编排）

## 1. 发布物与范围

| 包 / 应用 | 变更要点 | 证据 |
|---|---|---|
| `@fw/auth` | E-07：OAuth2 授权码流服务（`OAuth2FlowService`：state 一次性消费 + 回调域名白名单边界校验 + RFC 6749 form 交换）、`AuthService.loginByOAuth2`、ApiKeyStrategy 可选 HMAC 强制验签（`apiKeySignature` 导出） | 单测 **129/129**（E-07 新增 18 条，含 state 重放 / 跨提供方 / 白名单边界绕过反向验证） |
| `@fw/config` | E-07 三键 `AUTH_OAUTH2_PROVIDERS / AUTH_OAUTH2_REDIRECT_WHITELIST / AUTH_API_KEY_SIGN_SECRET`（`ENV_KEY_PATHS` 77→80，全 boot 键禁热更） | **16/16**（键集护栏） |
| `@fw/cache` | E-03 令牌桶原语与限流器（memory / redis Lua 原子多实例共享） | **88/88** |
| `@fw/queue` | E-01 bullmq 驱动接入任务中心 + E-06 cluster 连接与 hash-tag 告警 | **150/150** |
| `@fw/config-center` | E-02 `ConfigHistoryPort` 持久层多实例语义 + `NacosConfigDriver` 转正 | **53/53** |
| 其余框架包 | logger/core/db/cli/tenant/transport/telemetry 本轮无行为变更 | 17/18/83/116/34/83/53 全绿 |
| `example-api` | E-07 三端点 `/auth/oauth2/providers|:provider/authorize|:provider/callback` + `/api/v1/open/ping`（`@AuthStrategy('apikey')` 载体）；E-01~E-04 装配；`/demo/ok` 自报版本补更 v0.5.0（v0.3/v0.4 两轮漏更一并收口） | **52/52** |
| `admin-web` | E-07 登录页 OAuth2 入口（providers 驱动）+ fragment 回调接管；E-04 两处选择器换接；N-03 整页 403 视图 | **94/94** + `vue-tsc` 0 错误 |
| 新文档 | [docs/41 认证策略端到端指南](./41-auth-strategies.md)（OAuth2 配置 / 流程 / 反向验证清单 + apikey 签名约定与示例） | README 树与索引已挂 |

**不做 / 未入本版**：E-05 真实 K8s 部署冒烟（环境依赖，暂缓待集群）、E-11 长压实测（同前）；两者按 AC8 纪律在后续发布报告重申状态。P2（E-08~E-10）与 P3（E-12~E-17）未开工。

## 2. 版本与升级影响

- **版本**：全仓 15 个 package.json `0.4.0` → `0.5.0`（`0.x` 次版本，允许含新增能力）。
- **配置键**：65（v0.4.0）→ **80**。新增 15 键全部 boot 键不入热更白名单：E-01 `JOB_CENTER_DRIVER`、E-02 六键 `CONFIG_CENTER_NACOS_*`、E-03 五键 `RATE_LIMIT_*`、E-07 三键 `AUTH_OAUTH2_*` / `AUTH_API_KEY_SIGN_SECRET`。升级零必填：全部有默认值，默认行为不变（jobs=memory、config-center off、限流 600/10、OAuth2 未启用、apikey 不验签）。
- **契约**：api-spec §1.2 加「名实相符状态」列；§3.2 悬空契约 `/auth/oauth/:provider`（M3 起未实现）订正为 `/auth/oauth2/*` 三端点；§3.10 多实例注记、§3.11 任务中心驱动化、§3.4 权限树。无既有端点的破坏性变更。
- **数据库**：v0.5.0 相对 v0.4.0 **无新迁移、无 seed 变更**（M10 两表 `jobs` / `config_snapshots` 的 PG 迁移已随 release9 上真机）。

## 3. 发布门禁

### 3.1 完成定义（DoD）

- [x] AC1（E-01）：多副本任务面——`smoke-jobs-db.mjs` 双进程 10/10；memory 驱动 N-02 段零改动
- [x] AC2（E-02）：跨实例配置一致——`smoke-config-multi.mjs` 双进程 10/10；nacos 入枚举
- [x] AC3（E-03）：429/9003 + Retry-After + 白名单豁免 + `/metrics` 计数——`smoke-rate-limit.mjs` 8/8
- [x] AC4（E-04）：三层树 + 前端两处选择器消费 + parity 零提示——smoke-admin E-04 段
- [x] AC6（E-07）：OAuth2 授权码端到端（跳转→回调→换 token→登录会话）+ 越权与回调白名单反向验证——`smoke-oauth2.mjs` **15/15**
- [x] AC8（E-06 部分）：Redis Cluster 实测收口（[docs/94b](./94b-queue-transport-cluster-live-test.md) 14 断言）
- [ ] AC8（E-05/E-11）：环境依赖项，本版继续重申「到位即做」

### 3.2 非功能基线（本版复核项）

- 兼容性：E-01/E-02 memory 驱动冻结原行为（既有单测零改动通过）；新配置键全部有默认值，升级零必填。
- 安全：E-03 限流默认开启（白名单是唯一豁免出口）；E-07 回调域名白名单未配置即全拒、state 一次性消费防 CSRF/重放、apikey 签名常量时间比对、`clientSecret` / 令牌不进日志与审计（`SENSITIVE_FIELDS` 同源脱敏）。
- 可观测：限流计数进 `/metrics`（`fw_rate_limit_*`）；E-01/E-02 跨实例行为有 traceId 贯通。

### 3.3 安全基线

- 新增外部输入面（OAuth2 `redirect_uri` / `code` / `state`）全部过校验：白名单边界完整匹配、state 取后即删、provider 与 state 登记一致才继续。
- `AUTH_API_KEYS` 未配置签名密钥时保持原行为（内网可信形态可用），配置后强制验签——升级不静默改变既有部署行为。

## 4. 验证证据清单（本轮全部实跑）

### 4.1 类型检查与单测（逐包，2026-10-15 实跑）

| 包 | 结果 |
|---|---|
| config / logger / core / config-center / db | 16 / 17 / 18 / 53 / 83（+12 skipped 矩阵） |
| **auth** | **129/129**（含 E-07 新增 18 条） |
| cache / cli / queue / tenant / transport / telemetry | 88 / 116 / 150 / 34 / 83 / 53 |
| example-api / admin-web | 52/52；94/94 + `vue-tsc` 0 错误 |
| 全量构建 | 12 包 CI 依赖序 + example-api + admin-web（vite build）全部通过 |

### 4.2 端到端冒烟（本机，逐套独立进程）

| 套件 | 结果 | 说明 |
|---|---|---|
| **smoke-oauth2.mjs（新）** | **15/15** | stub IdP 全链路 + 反向验证 9 条 + apikey 签名 4 条 |
| smoke-auth | 28/28 | 含排序断言与锁定链路 |
| smoke-admin | 111/111 | 含 E-04 树、N-01/N-02 段 |
| smoke-mock | 119/119 | mock 与真实后端同构复核 |
| smoke-jobs-db / smoke-config-multi / smoke-rate-limit / smoke-config | 10/10 / 10/10 / 8/8 / 35/35 | E-01/E-02/E-03 专项（随交付轮实跑） |
| smoke-queue / smoke-transport（cluster） | 31 断言 / 17 断言 | E-06 实测（docs/94b） |

### 4.3 静态门禁（2026-10-15 实跑）

`check:headers`（447 文件）、`check-no-raw-sql`（297 文件）、`check-api-parity`（OK，`/auth/oauth2/*` 与 `/open/ping` 后端路由 ↔ 前端调用面对上）、`check:helm`（63/63）全绿。

### 4.4 CI 远端复核（GitHub Actions，推送后实跑）

发布链（`4030e2a` / `2ec5d19` / `68063e7`）对应 run [38753586347](https://github.com/donttemos/TY/actions/runs/38753586347)（结论见 §8）。

### 4.5 真机验收（`106.55.32.251` / `https://cs.donttemo.top`，2026-10-15 实跑）

- **备份**：`pg_dump -U fw -d fw | gzip` → `/opt/fw/pre-v0.5.0-20261015224341.sql.gz`（13 256 B；gzip -t 完整、17 张表、尾部字节完整——三重校验过）。
- **release10 九步全过**（64s）：解包断言（E-07 八个关键文件 + 六项源码断言）→ 依赖安装 → prisma generate（PG）→ 后端拓扑构建（产物含 `oauth2-flow.js` / OAuth2 路由 / apikey 验签）→ 前端构建（产物含 `/api/v1` 与 `oauth2/providers` 调用）→ bin 重链 → **迁移 No pending（零新迁移，预期）+ 免 seed**（E-07 无 seed 语义变更，用户会话保持）→ 原子切换 `20261015204143` → `20261015224417` + fw-api active → 站点同步 48 文件。
- **verify-release10：13/13**——探针双项、`/demo/ok` 自报 `v0.5.0`（升版实证）、admin 登录、E-07 四项（`providers` 公开可访问且真机默认空列表 = 登录页不渲染入口、未注册 provider 401、伪造 state 401/3001、`/open/ping` 无凭证 401）、回归四项（E-04 树 / auth:me / dict / users）。
- **verify-c06：27/27**（管理面端点与字典探针零残留）。
- **HTTPS 站点端到端**：`https://cs.donttemo.top/` 200、`/api/v1/auth/oauth2/providers` 同形、admin 登录 → `/auth/me` 会话成立。

## 5. 本次验收中发现并处理的问题

| # | 问题 | 处理 |
|---|---|---|
| 1 | apikey 策略在 example-api 无任何路由载体——「枚举有、路径无」缺口本体（冒烟首轮 401 暴露） | 新增 `/api/v1/open/ping`（`@AuthStrategy('apikey')`），冒烟 F 段改以该路由断言身份与 scope 回显 |
| 2 | `/demo/ok` 自报版本停在 v0.2.0（v0.3/v0.4 两轮发版均漏更） | 本次补更至 v0.5.0 并在文件头留痕；冒烟无该值断言，零回归 |
| 3 | api-spec §3.2 `/auth/oauth/:provider` 两行契约自 M3 起悬空 | 按落地形态订正为 `/auth/oauth2/*`，与「契约诚实」一致 |
| 4 | `AuthOptions` 新增必填字段未同步 `test-helpers`（vitest 不查类型而 tsc 会） | 同步补齐，CI 前置拦截 |
| 5 | 并行跑两组 pnpm 循环出现资源竞争假失败（admin-web build `errors:[Getter/Setter]`） | 构建/测试一律串行复跑，全绿 |

## 6. 遗留问题

| 项 | 状态 |
|---|---|
| E-05 真实 K8s 部署冒烟（L-01） | 暂缓待集群环境（用户决策）；每轮发布重申 |
| E-11 长压与百万行分页复测（R2-03） | 暂缓待压测环境 |
| OAuth2 真机端到端 | 真机默认未启用 providers（`providers` 返回空列表、登录页不渲染入口）——真实 IdP 接入属落地项目配置，框架侧已具备全部能力与反向验证 |
| session 策略端到端演示 | 设计为端口注入语义（业务侧提供 SessionStore），已文档化（docs/41 §1），不在本版范围 |

## 7. 判定

**通过**。P0 四项 + P1 两项全部达成 AC，冒烟与门禁全绿；遗留项均为环境依赖或明确的范围外决策，不阻塞本版发布。

## 8. 发布后的仓库与真机状态

- 仓库：`origin/main` = `68063e7`（chore(release): v0.5.0），发布链三提交（E-07 功能 `4030e2a` / E-07 文档 `2ec5d19` / 发版 `68063e7`），CI run 38753586347 结论以 Actions 页为准（推送时执行中）。
- 真机：**v0.5.0 已上真机**——current = `/opt/fw/releases/20261015224417`，fw-api active，四探针 ok；verify-release10 **13/13** + verify-c06 **27/27** + HTTPS 站点端到端全通。回滚路径：`current` 指回 `20261015204143` + 重启（本版零迁移零 seed，回滚无数据风险）。

## 9. 真机升级指引

沿用 [62 手册](./62-1panel-real-deploy.md) 与 release 脚本九步流程：pg_dump 备份（`| gzip` 三重校验）→ git archive 产物 → 后端 dist 上传 → 前端静态产物上 `www` 目录 → `current` 软链切换 → systemd 重启 → `migrate deploy`（本版无新迁移，输出 No pending 为预期）→ `verify-release` + `verify-c06` 冒烟。回滚：`current` 指回上一 release 目录 + systemd 重启（配置与库结构本版零变更，回滚无数据风险）。
