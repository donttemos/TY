<!--
@file docs/45 · 可观测与错误契约手册
@description M12（PRD-012）的契约唯一权威：错误信封字段级契约、双 ID 分层、日志/审计/指标三面的
  身份字段与检索键，以及「看到 replay_detected 一次拉全链」的排障样例。与 ADR-0025（统一错误与审计
  契约）/ ADR-0026（可观测 ID 分层与贯穿）配套。
@author donttemo
@created 2026-10-17
-->

# docs/45 · 可观测与错误契约手册（M12 / PRD-012）

> 状态：**正式**（2026-10-17，随 W1+W2 交付冻结；§6 排障命令于 2026-10-17 v0.6.0 真机逐条复测）｜ 关联：ADR-0025 / ADR-0026 / `docs/40-api-spec.md` §1.3 / `docs/30-data-dictionary.md` §3.13

## 1. 错误信封（ErrorBody，字段级冻结）

失败响应信封 `{ code, message, data, traceId, requestId?, details? }`：

| 字段 | 类型 | 语义 | 备注 |
|---|---|---|---|
| `code` | number | 业务错误码（`docs/40` §2 分段） | 唯一权威 `@fw/core ErrorCode`；前端/模板/mock 三副本由 `check:triway-consistency` 轴 G 断言同源，篡改即构建失败 |
| `message` | string | 错误文案 | 默认取码表文案，业务可覆盖 |
| `data` | null | 失败恒为 null | 成功信封才携带数据 |
| `traceId` | string | 跨服务链路 ID | `X-Trace-Id` 透传/回带；OTel 启用时 = span traceId |
| `requestId` | string? | **单次请求 ID**（M12 W2，additive） | 请求上下文存在时输出；见 §2 |
| `details` | Array? | 字段级校验错误 | **在信封顶层**；`data.details` 为历史 mock 形态（Deprecated，一个版本后移除） |

- **响应体永不包含** `stack` / 内部类名 / 异常原始 message（未知异常一律收敛 `9001`，由契约测试反向锁定）。
- 日志 `LogRecord` 一等字段：`code`（OBS-05）与身份字段（OBS-11，见 §3）。

## 2. 双 ID 分层（requestId vs traceId，ADR-0026）

| 维度 | `requestId`（M12 W2 新增） | `traceId`（既有） |
|---|---|---|
| 生成 | 请求入口，ULID（26 位 Crockford Base32） | `X-Trace-Id` 复用或服务端生成 |
| 生命周期 | **单次 HTTP 请求** | 跨服务分布式链路 |
| 传输 | 进程内（ALS）+ `X-Request-Id` 响应头；**不跨服务透传** | ALS + `X-Trace-Id` 请求/响应头透传；OTLP 上报 |
| 上游复用 | 合法 ULID 复用，非法值替换 | 合法值复用 |
| 配置 | `REQUEST_ID_ENABLED`（默认 true）/ `REQUEST_ID_HEADER`（默认 X-Request-Id） | — |

落点：错误信封 `requestId`（additive）、日志 `LogRecord.requestId`、`audit_logs.request_id`（W1 列先行，W2 填充）。

## 3. 日志身份字段（OBS-11）

`LogRecord` 顶层 `userId` / `requestId`（默认集）/ `familyId` / `jti`（按需开启）由 logger **自动从 ALS 读取**；
`LOG_IDENTITY_FIELDS` 逗号分隔门控（空串关闭全部；默认 `userId,requestId`）。调用方手塞同名 ctx **不覆盖**
顶层自动字段（身份以鉴权事实为准）。`familyId` / `jti` 为非凭证标识（jti 是 token 标识非 token 本体），
可安全落日志与审计（ADR-0026 安全论证）；`tenantDbUrl` 维持禁入。

## 4. auth / security 指标段（OBS-12）

`/metrics` 在 `fw_cache_*` / `fw_rate_limit_*` 之后追加（`METRICS_AUTH_SECTION_ENABLED`，默认 on）：

```
fw_auth_login_total{result="success|failed"}
fw_auth_refresh_total{result="success|failed"}
fw_auth_token_verify_failed_total{reason="missing|expired|invalid"}
fw_security_replay_detected_total{reason="<ReplayReason 枚举>"}
fw_security_family_revoked_total
fw_auth_audit_dropped_total{path="login|authz",reason="rate_limited|capacity"}
```

**基数护栏（硬约束）**：label 仅允许低基数枚举（`result` / `reason` / `path`）；`userId` / `familyId` / `jti` /
`requestId` 禁止入 label（用户/租户维度走审计表，见 §5）——由 `auth-metrics.test.ts` 反向锁定。

**审计限流丢弃可观测（M15 P2，FR-15-12 / ADR-0032 R6）**：登录失败（`AuthService.recordLoginFailure`）与
越权拒绝（`RbacGuard`）两条路径的限流器丢弃不再静默——`AuditEventThrottle.onDrop` 把每次丢弃
（`rate_limited` 窗口超限 / `capacity` 容量拒建桶）计入 `fw_auth_audit_dropped_total`（四条固定序列恒输出，
含 0，告警规则可静态引用），并触发**周期性汇总结构化日志**（`module=auth.metrics`，
msg=「审计事件限流丢弃周期性汇总」，每路径每 60s 最多一条，ctx 只含 path 与两种原因的区间计数）。
汇总日志刻意**不含维度键原文**（IP / 账号 / 权限串都是攻击者可控的高基数数据）——「谁在被打」
以保留下来的前 3 条审计样本为准。该序列回答一个此前答不上来的问题：**审计样本是否正在大量丢失**
（丢弃数持续上涨 = 限流器在丢审计，需调大上限 / 加副本 / 处置攻击源）。

## 5. 审计检索键（OBS-14）

`GET /api/v1/audit-logs` 与 `/export` 支持过滤参数（白名单外字段一律 `400/1001`，不静默忽略）：

`user_id` `module` `action` `target_type` `target_id` `from` `to` `sort`
`trace_id` `request_id` `family_id` `category` `event`
`result` `tenant_id`（M15：结果四态 / 租户维度；`tenant_id=0` 表示未知/存量）
`event` 支持逗号分隔多值（M15：风险等级不落库，前端按注册表把「高风险」展开成 `event=a,b,c`，上限 20，
超出 400——避免把 URL 当查询语言）

CSV 导出列同步：`...,traceId,requestId,familyId,category,event,before,after`
（M15 B4 已交付：业务列**追加**在末尾 `eventName,summary,targetLabel,actorLabel,reason,result,auditSource,risk`；
M12 十五列位置与顺序不变。`eventName`/`risk` 由注册表现算，未登记事件留空——
导出面与页面同语义，不另造一套口径）。

**CSV 单元格编码含公式注入防护**（M15 安全加固）：`summary` / `targetLabel` / `actorLabel` / `reason`
等列是用户可控文本（导入数据、历史数据、其他写入路径都会带进来），**引号转义不等于防护**——
`"=1+1"` 在 Excel 里仍是公式（引号只是分隔符，不进单元格值）。统一由 `@fw/auth` 的
`escapeCsvCell` 编码：`= + - @` 与制表符开头的单元格加单引号前缀强制按文本解析，CR/LF 压成空格，
其余字符（含引号）原样转义、不截断。mock 侧 `apps/admin-web/mock/csv-cell.ts` 是同源实现，
两侧锚点由 `check:triway-consistency` 轴 H 对撞，行为由三处同组向量单测锁定；
不能只靠 UI 输入校验防住——导入数据、历史数据与其他写入路径都不经过前端。

**事件语义不在数据库里，在注册表里**（M15/ADR-0032 R1）：`GET /api/v1/audit-logs/events` 返回
`{ version, items }`，`items[]` 定义事件名称/说明/分类/风险/处理指引/摘要模板/变更字段中文名。
日志、审计行、页面、导出四处对同一事件码的解释都必须来自这一份定义——前端不得维护第二份翻译表。
审计行只冻结**事实快照**（`summary` / `target_label` / `actor_label` / `reason` / `audit_source`），
不冻结字典：文案纠错不需要重写历史行。

**快照缺失时的展示口径**：`actor_label` 由 `AuditService.persist` 在**写入时刻**集中补全
（调用方未显式传值时按 `userId` 回查昵称/账号名），因此新行不会有「有操作人 ID 却没有名字」的情况。
历史行（加固前写入）确实没有快照：页面与详情**标注「名称快照缺失（ID: …）」**，绝不拿当前用户列表
的名称回填——管理员「运营 A」改名「运营 B」后，历史行必须仍显示当时的人，否则是把今天的事实写成昨天的。
用户已删除 / 回查失败同样留空，不用后来者的名字冒充。

**`target_label` 的写入口径（P1 收口，2026-10-21）**：SaaS 运营事件（套餐发布 / 订阅开通 / 订阅取消 /
配额超限 / 生命周期迁移含非法）在**写入时刻**经 `SaasStore.findTenantName` / `findPlanById` 把
租户 ID / 套餐 ID 解析为名称快照——运营在对象列看到 `t1` 会误以为是租户名，看到 ID 也不会去查。
解析不到（租户不存在 / 脏引用 / 套餐软删）时写 `snapshotMissingLabel(id)`（`@fw/auth`）：
**「名称快照缺失（ID: …）」**，与展示侧 `ACTOR_SNAPSHOT_MISSING` 同文案、同为「缺失是可核验的事实」；
绝不让 ID 冒充名称，也不静默留空让展示层回退成 `targetType:targetId`。存量行（修复前写入的裸 ID）
**不回填**（ADR-0032 R8），按历史数据处理。

## 6. 排障样例：看到 `replay_detected`，一次拉全链（G12-3）

> 命令按**部署档位**分两式（容器 stdout / 1Panel-systemd journald）；两式均在 **2026-10-17 v0.6.0
> 真机（1Panel）逐条实测可跑**（记录见 [docs/63](./63-1panel-real-deploy-verification.md) §6）。
> `$T` = 持 `audit:read` 的管理员 token；`<traceId>` / `<requestId>` 从告警、响应头或信封取。

```bash
# ① 审计行：一次定位安全事件九要素（也可按 ?request_id=<requestId> 反查，OBS-14）
curl -s "http://127.0.0.1:3000/api/v1/audit-logs?event=refresh.replay_detected&trace_id=<traceId>" \
  -H "Authorization: Bearer $T"
# → items[0]：requestId / traceId / userId / familyId / jti / ip / userAgent /
#   createdAt / event('refresh.replay_detected') / result('denied') / category('security')

# ② 结构化日志：按 requestId grep——同一次请求会命中 2 行（replay 业务行 + 全局异常过滤器行）
#    1Panel/systemd 档（journald；真机实测）：
journalctl -u fw-api -o cat | grep '"requestId":"<requestId>"'
#    容器档（Docker / K8s）：
docker logs fw-app 2>&1 | grep '"requestId":"<requestId>"'
kubectl logs deploy/app | grep '"requestId":"<requestId>"'
# → module=auth.refresh 行：顶层 requestId + traceId；ctx.userId / ctx.familyId / ctx.jti / ctx.reason
#   module=exception-filter 行：顶层 code=3001（错误码一等字段，OBS-05）
#   ⚠ 公共 refresh 路由无鉴权 ⇒ ALS 无 userId：LogRecord 顶层自动身份只有 requestId，
#     userId 在该行 ctx 内；审计行顶层 userId 始终齐全（契约不变，样例按真实形态写）。

# ③ 指标：安全事件计数是否在涨（Prometheus 告警规则直接消费）
curl -s http://127.0.0.1:3000/metrics | grep '^fw_security_replay_detected_total'
# → fw_security_replay_detected_total{reason="fingerprint_mismatch"} 1
#   （label 仅低基数 reason；userId/familyId 不入 metrics，回审计表查）

# ④ 响应头 / 错误信封：该请求响应头 X-Request-Id / X-Trace-Id 与信封 requestId / traceId 同值
#   （真机实测逐字相等；additive 字段 requestId 仅在请求上下文存在时输出）
```

关联链：**响应头 `X-Request-Id`/`X-Trace-Id` ↔ 信封 `requestId`/`traceId` ↔ 日志 `LogRecord` ↔
`audit_logs` 行 ↔ `fw_security_*` 计数** 五处同源，任取其一即可互查。

## 7. 审计事件覆盖矩阵（M15 / PRD-015 FR-15-07）

> 口径：**「必须审计」= 改了权限、动了租户、动了钱（套餐/配额）、动了全局配置、或发生拒绝**。
> 矩阵是评审与门禁的共同依据：新增事件必须同时出现在注册表（`packages/auth/src/audit-events.ts`）、
> 本表与一个真实写入点；三者缺一不算交付——由 `pnpm run check:audit-events` 门禁强制（CI 已接入）。
>
> **「写入点」的判定口径（M15 安全加固后收紧）**：注册表定义文件本身**不算**写入点（它列出全部事件码，
> 是码表不是「有人真的记了这条审计」）；只认 `recordEvent('…')` / `recordEventSync('…')` 直接调用、
> 服务端文件里的 `event: '…'` 属性，以及**显式标注 `@audit-event-map` 的事件映射表**
> （如 saas 的 `LIFECYCLE_EVENTS[action]`）。「任意字面量出现即算」的做法已废弃——那样删掉真实写入调用
> 后门禁依旧是绿的。门禁判定逻辑（`scripts/lib/audit-gate.mjs`）另有反向测试
> （`pnpm run check:audit-events:test`）：删掉某事件唯一写入点后必须判红。
>
> mock 侧注册表（`apps/admin-web/mock/audit-events.ts`）是**自动生成物**：由 `pnpm run gen:audit-events-mock`
> 从 `@fw/auth` 注册表生成，`check:audit-events` 校验其是否最新。手抄副本会漂移——B3 首版只抄 12 条，
> 页面上大半事件显示「未登记」，正是这条护栏的由来。
>
> 记录来源（`audit_source`）：本表全部为 `domain`（领域层显式记录）。
> **example-api 已无 `@Audit` 使用点**——12 处装饰器全部改为领域事件，避免「拦截器 + 领域」双写；
> 拦截器保留在框架内供生成项目使用，其行语义仅为「HTTP 成功返回」，不得作为业务完成证据（ADR-0032 R5）。

### 7.1 认证与权限

| 事件码 | 风险 | 结果 | 写入点 | 目标对象 | 原因来源 | 备注 |
|---|---|---|---|---|---|---|
| `auth.login` | low | success | `packages/auth/src/auth.service.ts`（口令 / OAuth2 两条路径） | 用户（`target_label`=账号名） | — | 摘要含认证方式 |
| `auth.login_failed` | notice | denied | 同上（`login()` 的 catch 收敛，原因按错误码映射） | 用户（尝试的账号） | 枚举：口令错误 / 锁定禁用 / 限流 | 按（IP+账号）3 条/分钟防洪 |
| `auth.logout` | low | success | 同上（`logout`） | 用户 | — | 记录撤销的令牌数 |
| `auth.password_change` | notice | success | 同上（`changePassword`） | 用户 | — | 前后值中的口令哈希已脱敏为 `***` |
| `auth.session_revoke` | high | success | 同上（`revokeUserSessions`）+ `auth.controller.ts`（单设备下线） | 用户 / 会话 | 系统生成（forced） | 单设备下线用显式摘要覆盖模板 |
| `auth.register` | notice | success | 同上（`register`） | 用户 | — | 自助注册受 `AUTH_ALLOW_REGISTER` 开关约束 |
| `auth.profile_update` | low | success | `apps/example-api/.../auth.controller.ts` | 用户 | — | 仅昵称/手机/邮箱，不含账号名与角色 |
| `auth.role_assign` | high | success | `packages/auth/src/auth.service.ts`（`assignUserRoles`） | 用户 | — | 需复核；角色集合走 `after.roleIds` |
| `auth.permission_grant` | critical | success | 同上（`grantRolePermissions`） | 角色 | — | 需复核；影响全部持有该角色的账号 |
| `authz.denied` | notice | denied | `packages/auth/src/rbac.guard.ts`（权限比对失败处） | 接口（`target_label`=url） | 缺少的权限码 | 按（用户+权限码）3 条/分钟防洪 |

### 7.2 账号与角色管理

| 事件码 | 风险 | 结果 | 写入点 | 目标对象 | 原因来源 | 备注 |
|---|---|---|---|---|---|---|
| `user.create` | notice | success | `apps/example-api/.../users.controller.ts` | 用户 | — | 含初始角色集合 |
| `user.update` | notice | success | 同上 | 用户 | — | 资料 + 角色集合前后值 |
| `user.status_change` | high | success | 同上 | 用户 | — | 禁用会连带强制下线（`after.forcedLogout`） |
| `user.delete` | high | success | 同上 | 用户 | — | 需复核；内置管理员不可删 |
| `role.create` | notice | success | `apps/example-api/.../rbac.controller.ts` | 角色 | — | 复制角色用显式摘要（含来源角色） |
| `role.update` | notice | success | 同上 | 角色 | — | 数据范围变更后失效相关用户缓存 |
| `role.delete` | high | success | 同上 | 角色 | — | 需复核；仍有持有者时拒绝 |

### 7.3 租户、套餐与配额

| 事件码 | 风险 | 结果 | 写入点 | 目标对象 | 原因来源 | 备注 |
|---|---|---|---|---|---|---|
| `saas.lifecycle.activate`<br>`saas.lifecycle.freeze`<br>`saas.lifecycle.resume`<br>`saas.lifecycle.terminate`<br>`saas.lifecycle.expire`<br>`saas.lifecycle.dispose` | notice~critical | success | `apps/example-api/.../saas-ops.controller.ts`（动作→码显式映射） | 租户（`target_label`=租户名） | 运营填写 / 系统生成 | freeze/terminate/dispose 需复核；摘要含状态迁移；名称写入时解析，取不到落缺失标记 |
| `saas.lifecycle.invalid` | notice | denied | 同上（捕获 4030 后记录再原样抛出） | 租户（`target_label`=租户名） | 领域错误文案 | 不改写错误语义，只补留痕；名称口径同迁移成功 |
| `saas.plan.create` | notice | success | 同上 | 套餐 | — | `target_label`=套餐名 |
| `saas.plan.publish` | high | success | 同上 | 套餐（`target_label`=套餐名） | — | 含版本号与配额项数；发布后版本不可变；名称写入时解析，取不到落缺失标记 |
| `saas.subscription.create` | notice | success | 同上 | 订阅（`target_label`=租户名 · 套餐名） | — | 含套餐编码/版本/到期时间；两侧名称写入时解析，取不到的一侧落缺失标记 |
| `saas.subscription.create_rejected` | notice | denied | 同上（terminated 分支：先记录再原样抛出 4030） | 租户（`target_label`=租户名） | 领域错误文案 | 未创建订阅、未改变租户状态与配额；`after` 含请求套餐/租户状态/拒绝码；名称解析失败落缺失标记（审计不得反向决定业务成败） |
| `saas.subscription.cancel` | high | success | 同上 | 订阅（`target_label`=租户名 · 套餐名） | 运营填写（必填建议） | 需复核；原因同时落 `reason` 列；名称口径同开通 |
| `saas.quota.exceeded` | notice | denied | 同上（4029 分支） | 租户（`target_label`=租户名） | 系统生成 | 硬限额拒绝，未扣减用量；名称写入时解析，取不到落缺失标记 |

### 7.4 安全、配置与运维

| 事件码 | 风险 | 结果 | 写入点 | 目标对象 | 原因来源 | 备注 |
|---|---|---|---|---|---|---|
| `refresh.replay_detected` | critical | denied | `packages/auth/src/refresh-token.service.ts`（`handleReplay`） | 令牌族 | 低基数枚举（reason） | 需复核；直连 store 写入（九要素齐备） |
| `config.change` | high | success | `apps/example-api/.../config-center/audit-bridge.ts` | 配置项（键名） | 变更入参 reason | `recordEventSync`：先审计后生效，失败整体回滚 |
| `audit.export` | notice | success | `audit.controller.ts` + `audit-archive.controller.ts`（派发成功后） | 导出任务 | — | 摘要描述筛选条件；「全部记录」本身即高风险事实 |

### 7.5 不采集的范围（有意为之）

参数校验 400、资源不存在 404、限流 429 **不落审计**（日志与指标已覆盖）。理由：审计是取证资产，
不是访问日志——把每次 400 都写进去会让真正的安全事件淹没在噪声里，并给攻击者提供刷表放大面
（ADR-0032 R6）。拒绝类只保留清单内的高风险动作，并按主体限流。
