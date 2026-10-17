<!--
@file PRD-012 · 统一可观测契约与运维暴露
@description 承接 M1–M11 已交付能力，本 PRD 是 M12 的唯一交付单元，按依赖顺序合并三件事：
  【W1 / P0】M12.2 统一 Error / Audit Contract——把 6+ 平行错误族、三份码表副本、只存在于日志字符串里的
  错误码收敛为唯一 `BizError` + 唯一 `ErrorBody` + 唯一 `AuditEvent`，并加「禁裸抛」门禁；
  【W2 / P1】M12.1 Observability 贯穿——requestId / traceId / userId / familyId / jti 进同一 ALS 上下文，
  logger 结构化输出身份，补齐 auth/security 指标段，使 replay_detected 可一次性定位到 requestId/userId/
  familyId/token/IP/UA/timestamp/event/result 九要素；
  【W3 / P2】M12.3 Maintenance / Health 暴露——把 `/auth-maintenance/*` 从「类级 @Public 裸奔 + 部署层
  白名单不覆盖」改为「公开自检 / 受保护运维 / 内部诊断」三层显式边界。
  编号 OBS-01~OBS-19，每项含关键约束与含反向验证的验收口径；本 PRD 不新增任何错误码。
@author donttemo
@created 2026-10-17
-->

# PRD-012 · 统一可观测契约与运维暴露

> 里程碑：M12（v0.6.0 候选）｜ 状态：**草案**（2026-10-17）｜ 优先级：P1 ｜ 依赖：M1–M11 已交付能力（重点 M1 `@fw/core` 错误与信封、M3 `@fw/auth` 审计、M8 `@fw/telemetry` OTel 桥接、M10 审计归档 / E-17 RUM、M11.3/11.5 replay 安全事件与 Key Ring 可观测）｜ 负责人：donttemo ｜ 更新：2026-10-17
>
> **变更记录**
>
> - 2026-10-17 donttemo 起草——**立项缘由**：框架已经「能跑、能扩、能运营（PRD-011 在办）」，但三件横切基础设施仍是「机制在、契约不在」的状态：
>   1. **错误面**：`@fw/core` 早已有统一类 `BizError` 与集中码表，但框架内并存 **6+ 套平行错误族**（`TransportError` / `TelemetryUnavailableError` / `TelemetryConfigError` / `PermanentJobError` / `JobTimeoutError` / `TokenVerifyError` / `ConfigValidationError`）各自继承裸 `Error`；生产代码里仍有大量 `throw new Error()`（如 `tenant-admin.controller.ts` 的并发冲突、`key-ring.ts` 的配置校验），被 `GlobalExceptionFilter` 一律降级为 `9001`，丢失 `1004` / `5001` 等精确语义；码表在 `@fw/core ErrorCode`、前端 `BIZ_CODE`、mock `CODE` 存在 **三份人肉同源副本**；`docs/40-api-spec.md` 说 `details` 在 `data.details`，而实现与前端实际都在**信封顶层**。
>   2. **观测面**：链路有 `traceId`（ALS + `X-Trace-Id` + OTel 桥接）与 `userId`（`RbacGuard` 写入 ALS），**但日志 `LogRecord` 根本不输出 `userId`**；`familyId` / `jti` 只活在 `request.user` 内存对象里，**从未进统一上下文**；replay 安全事件虽然同时写日志与 `audit_logs`，但审计行的 `traceId` 是**硬编码 `null`**（绕过了 `AuditService.persist` 的自动取值）——这正是「HTTP → Auth → Audit 一条链」唯一的断点；`/metrics` 只有 `fw_cache_*` 与 `fw_rate_limit_*` 段，**没有 `fw_auth_*` / `fw_security_*`**，安全事件无法被 Prometheus 抓到。
>   3. **暴露面**：`/api/v1/auth-maintenance/{refresh-cleanup,audit-archive,key-ring}` 由**类级 `@Public()`** 放行，无权限码、无运维 token、无应用层 IP 白名单；部署层 Nginx 三份配置的内网白名单正则**只覆盖 `/health|/ready|/metrics`**，`auth-maintenance` 落到普通 `/api/` 反代分支——即**公网可达**；三条路由里只有 `key-ring` 加了 `Cache-Control: no-store`。
> - 用户口述的**依赖顺序**（本 PRD 的波次划分依据）：`M12.2 统一 Error/Audit Contract` → `M12.1 Observability 贯穿` → `M12.3 Maintenance/Health 暴露`。三者共用同一份「统一契约」，故合并为一个交付单元、一个文件，分 W1/W2/W3 三波独立验收。
> - 2026-10-17 donttemo **W1 首批交付**（OBS-04/05/06/07 + ADR-0025）：① 统一审计事件契约落地——`AuditLogRecord`/`AuditEntry` 增 `category`/`event`/`result`/`familyId`/`jti`/`requestId`（必填 nullable，`AuditService.persist` 字段全量落位，形状不漂移）；`audit_logs` + `audit_log_archives` 软增列 6 列，migration `20261017110000_add_audit_event_contract` 三方言（example-api SQLite / PG 变体 / MySQL init）+ admin 模板同构，索引 `event`/`family_id`/`request_id`/`(category, created_at)`（归档表独立命名）；存储映射同步 PrismaAuthStore ×2 / PrismaAuditArchiveStore / admin-store ×2；web 侧 `AuditLogRecord` 三副本（contracts/api-web、admin-web、模板）同源补字段，mock 种子补齐。② replay 安全事件九要素（OBS-07）：`handleReplay` 审计行走统一契约（`category='security'` + `event='refresh.replay_detected'` + `result='denied'` + `familyId` + `jti`（复用方令牌解出）），`traceId` 取 `getTraceId()`（修复硬编码 null 断链），**全部 5 个调用点强制传 `ip`/`userAgent`**（修复主泄漏路径丢失），新增 `ReplayReason` 低基数枚举进 `afterValue.reason`；rotation 判定语义零改动（ADR-0020 Rule 8 保持）。③ 日志错误码一等字段（OBS-05）：`LogRecord.code` + `LogOptions`，`GlobalExceptionFilter` 改传顶层 `code`（不再内嵌 ctx）。④ 契约文档收口（OBS-04）：api-spec §1.3 `details` 顶层口径修正 + `data.details` 兼容分支标注 Deprecated；`docs/contracts/api-web.ts` `ApiEnvelope` 补 `details`。**AC-OBS-07 未勾**：九要素中 `request_id` 待 OBS-09（W2）填充，其余七要素已由 `audit-event-contract.test.ts` 6 条锁定。**回归**：auth 216/216（新增 6）、logger 20/20（新增 3）、core 18/18、example-api **112/112**（含 rotation 集成 11/11 真库）、admin-web 183/183 + `vue-tsc` 0 + build + smoke-mock **140/140**、smoke-template-admin 全过（含模板 SQLite 新迁移应用）。**过程登记**：期间 example-api 集成 spec 曾三次 hook 超时，二分定位为**并行会话 pnpm 活动的间歇性争用**（隔离探针同命令 2.8s 通过、恢复后默认超时连续三过），非本批改动引入；构建另抓出并修复 mock 种子 `${module}` 自由变量误用（ESM 下 ReferenceError）。> - 2026-10-17 donttemo **W1 收口 + W2 交付**（OBS-01/02/03/08 + OBS-09~OBS-14；ADR-0025 修订 + ADR-0026 已采纳）：① **错误族收敛（OBS-01）**：`@fw/telemetry` 族继承 `BizError`（9002 / 5002）；两类证据驱动改判登记 ADR-0025——`TransportError` 族改②类（既有测试以 `not.toBeInstanceOf(BizError)` 锁定跨进程重建契约，「调用方转换」已在 demo-transport `mapTransportError` 落地）、`ConfigValidationError` 改③类（config→core 包循环依赖禁止）。② **禁裸抛门禁（OBS-02）**：`check-no-raw-throw` 门禁接入 CI；白名单 = CLI（不暴露 HTTP）+ TokenService 单文件精确豁免（Rule 8 diff=0，不能加行内注解）+ demo 演示本体行级注解 ×2；**存量迁移约 60 处 → BizError 统一码**，`tenant-admin` 并发冲突修复为 **1004**（9001 降级行为修正登记 CHANGELOG）。③ **码表单一来源（OBS-03）**：triway 门禁升七轴（轴 G）——`error-codes.json` 工件（`pnpm gen:error-codes`）+ 前端/模板/mock 三副本值集合逐一相等，篡改即构建失败；mock 补齐 4001/9002/2001。④ **契约测试（OBS-08）**：core 16 码信封/http 逐码锁定 + 未知异常 9001 反向验证 + details 顶层锁死；audit 序列化零敏感材料；i18n 双语言键覆盖。⑤ **requestId 双 ID（OBS-09）**：ULID 进 ALS + `X-Request-Id` 回带（合法复用/非法替换/`REQUEST_ID_ENABLED=false` 零差异回退，core 单测 6 条）；错误信封 additive；前端 `BizError.requestId` + trace 旁路记忆同步（**范围边界：mock 服务端响应暂不携带 requestId，前端类型/记忆层已同步，W3 批次补**）。⑥ **ALS 扩展（OBS-10）**：`RequestContext` 增 `requestId/familyId/jti`，RbacGuard / rotate 边界写入；**`TokenService` git diff = 0 验证通过**。⑦ **logger 自动身份（OBS-11）**：`LogRecord` 自动输出 `userId/requestId`（`LOG_IDENTITY_FIELDS` 门控），手塞 ctx 不覆盖（反向验证）。⑧ **auth/security 指标段（OBS-12）**：`@fw/core` 指标段注册表 + `/metrics` 追加 `fw_auth_*` / `fw_security_*` 五指标；基数护栏单测（label 仅 result/reason，身份值禁入）；`METRICS_AUTH_SECTION_ENABLED` 开关。⑨ **链路贯通（OBS-13）**：`observability-chain.integration.spec.ts`（SQLite 真库）——replay 场景 requestId+traceId 在审计行/日志/metrics 三处一致 + 九要素断言；`docs/45-observability-contract.md` 契约手册 + 排障样例。⑩ **审计检索扩展（OBS-14）**：`trace_id/request_id/family_id/category/event` 过滤（Prisma/Memory 同语义）+ **未知过滤参数 400**（白名单单测）；CSV 列与 mock 逐字节同构。**回归**：logger 25/25、core 29/29、auth 224/224、cache 149/149、transport 93/93、queue 156/156、db 83/83、config-center 54/54、tenant 34/34、storage 45/45、telemetry 53/53、example-api 115/115（+observability-chain 1 + 白名单 2）、admin-web 186/186 + vue-tsc 0 + build + smoke-mock、smoke-template-admin；门禁 7 项全绿（新增 no-raw-throw；triway 升七轴）。

> - 2026-10-17 donttemo **W3 交付**（OBS-15~OBS-19；ADR-0027 已采纳，OQ-4 定案）：maintenance 三端点 `@Public` → `ops:read` 守卫 + 全端点 no-store（PERM.OPS_READ + seed + admin 授权）；`docs/46-ops-endpoints.md` 全量普查矩阵；`DEMO_ENDPOINTS_ENABLED` + DemoEndpointsGuard（四个自检控制器非 dev 404，反向验证单测）；健康语义文档化（路径不重命名，别名未做登记）；快照公共字段集冻结（补 enabled/lastDurationMs，additive）；`check:helm` Nginx 三份一致性轴（探针覆盖集一致 + maintenance 不上公网）。**范围边界（如实登记）**：真机 1Panel 边界实测与 AC-OBS-13 排障样例实测同批待执行（需部署窗口）；`OPS_TOKEN` 逃生门登记未启用；存量环境 reseed 提示登记 ADR-0027。



## 1. 背景与目标

### 1.1 已完成能力（基线，逐项带源码锚点）

| 能力 | 现状 | 锚点 |
|---|---|---|
| 统一错误类 | `BizError extends Error`，字段 `code` / `http`（由码表派生）/ `details` / `message` | `packages/core/src/errors/biz-error.ts` |
| 集中错误码 | `ErrorCode`（16 个码）+ `ERROR_CODE_META`（码→http+文案）+ `HTTP_TO_ERROR_CODE`（三方异常归一） | `packages/core/src/errors/error-codes.ts` |
| 失败信封 | `ErrorBody = { code, message, data: null, traceId, details? }`（**details 在顶层**） | 同上 `:92-98` |
| 全局归一 | `GlobalExceptionFilter`（`@Catch()`）+ `ResponseInterceptor`，未知异常收敛 `9001`，堆栈只落日志 | `packages/core/src/exception/global-exception.filter.ts`、`packages/core/src/response/response.interceptor.ts` |
| traceId | `traceMiddleware` 生成/透传 + 回带 `X-Trace-Id`；ALS 承载；OTel 启用时就地回写 span 的 traceId/spanId | `packages/core/src/trace/trace.middleware.ts`、`packages/logger/src/context.ts`、`packages/telemetry/src/otel.middleware.ts` |
| userId 入上下文 | 鉴权通过后 `patchRequestContext({ userId, tenantVerified })` | `packages/auth/src/rbac.guard.ts` |
| 审计 | `audit_logs` 表（含 `trace_id` / `ip` / `userAgent` / `user_id`）+ `AuditService.record/persist` + `@Audit()` 拦截器；`persist` 自动取 `getTraceId()` | `packages/auth/src/audit.service.ts`、`audit.interceptor.ts` |
| 安全事件 | `RefreshTokenService.handleReplay()` 同时写 `logger.error` + `audit_logs(action='security')` | `packages/auth/src/refresh-token.service.ts` |
| 指标 | 自研 Prometheus 文本渲染（无 `prom-client`）：`/metrics`（cache + rate_limit 段）、`/metrics/queue` | `packages/cache/src/metrics.controller.ts`、`packages/queue/src/metrics.controller.ts` |
| 健康 | 自研：`/health`（liveness 语义）、`/ready`（readiness 语义，逐探针，失败 503） | `packages/core/src/health/health.controller.ts` |
| 运维快照 | `GET /api/v1/auth-maintenance/{refresh-cleanup,audit-archive,key-ring}`（三条，类级 `@Public`） | `apps/example-api/src/modules/auth/maintenance.controller.ts` |

一句话：**「同一个错误有同一种表达」「同一个请求有同一条链」「运维端点有明确边界」这三句话，框架目前都只兑现了一半——机制齐了，契约没收敛。**

### 1.2 五类结构性缺口（评估结论）

| # | 缺口 | 现状证据 | 影响 |
|---|---|---|---|
| U-1 | **错误模型未收敛** | 6+ 平行错误族各自继承裸 `Error`（transport/telemetry/queue/auth-token/config）；生产代码大量 `throw new Error()`（`key-ring.ts`、`tenant-admin.controller.ts`、`job-executor.ts`、`storage/key.ts`、`tenant/resolver.ts` 等）；码表三份副本（core / 前端 `BIZ_CODE` / mock `CODE`） | 同一语义在不同模块得到不同错误码甚至退化为 `9001`；前端无法按码分支，i18n 文案失准；跨进程（transport）只保证「已知码可往返」 |
| U-2 | **可观测链在身份维度断链** | `LogRecord` 无 `userId` 字段（只有 `tenantId`）；`familyId` / `jti` 只存在于 `request.user`，`patchRequestContext` 从未写入；`handleReplay()` 写审计时 `traceId: null` 硬编码，且主泄漏路径不传 `ip`/`ua`；无 `fw_auth_*` / `fw_security_*` 指标段 | 看到 `replay_detected` 只能拿到「一句话 + 一个 userId」，无法凭 ID 拉出 IP/UA/家族/请求上下文；安全事件不可被监控抓取 |
| U-3 | **运维暴露面失守** | `MaintenanceController` 类级 `@Public()`；Nginx 三份配置白名单只含 `/health|/ready|/metrics`；仅 `key-ring` 有 `no-store` | 公网可读运维快照（虽当前内容无敏感材料，但边界靠「碰巧」而非「设计」；新增端点即扩大攻击面） |
| U-4 | **文档与实现口径分歧** | `docs/40-api-spec.md` 称 `data.details`，实现与前端为顶层 `details`；无 `requestId` 概念（框架自 M1 起用 `traceId` 兼任）；`ErrorBody` 未作为一等契约类型被单独锁定 | 契约文档不可信；跨端解析靠注释与经验兜底 |
| U-5 | **审计/安全事件结构表达弱** | `action='security'` 是普通字符串（DB 层无约束）、无 `category`、无 `event` / `result`；`familyId` 只能塞进 `target_id`（靠 `target_type='refresh_family'` 关联）；`jti` 无落点；审计行不承载错误码 | 「完整定位」能力缺失；安全事件无法结构化检索与统计 |

### 1.3 目标

| # | 目标 | 衡量 |
|---|---|---|
| G12-1 | **一个错误，一种表达**：全框架错误经唯一模型产出，HTTP 信封 / RPC / 日志 / 审计 / 测试五处同源 | 契约测试覆盖每个错误码→信封形状；`check-no-raw-throw` 门禁在生产目录零命中；码表单一来源（前端/mock 构建期断言同源） |
| G12-2 | **一个请求，一条链**：`requestId` / `traceId` / `userId` / `familyId` / `jti` 在同一 ALS 上下文，并在日志与审计中自动落地 | 端到端用例：同一次 replay 场景的 `requestId`+`traceId` 在响应头、结构化日志、`audit_logs` 行、`/metrics` 计数四处一致可关联 |
| G12-3 | **看到事件，能完整定位**：任一安全事件可凭 `traceId`（或 `requestId`）一次拉出九要素 | 「排障样例」文档 + 集成用例断言九要素齐全（`requestId` / `userId` / `familyId` / token(`jti`) / IP / UA / timestamp / event / result） |
| G12-4 | **运维端点边界显式化**：公开 / 受保护 / 内部三层各自有定义、有理由、有门禁、有部署侧一致 | 运维端点矩阵文档（逐条标注必要性/暴露面/敏感度）；Nginx 三份配置一致覆盖；反向验证未授权访问被拒 |

### 1.4 衡量口径（本 PRD 完成时）

- W1/W2/W3 三波各自的 AC 全部勾选（或不做的项**显式登记理由**，不得静默缺失）。
- **零新增错误码**（本 PRD 只收敛既有码；运维鉴权复用 `3002`）。
- 新增配置键全部登记 `@fw/config` 的 `ENV_KEY_PATHS` + `docs/60` §3 + `.env.example`（既有硬规则）。
- 新增表列 ≥ 5（`audit_logs` + 归档表同构）/ 索引 ≥ 3，数据字典同步。
- 新文档：`docs/45-observability-contract.md`（可观测与错误契约手册）、`docs/46-ops-endpoints.md`（运维端点安全边界矩阵）；新 ADR：ADR-0025（统一错误与审计契约）/ ADR-0026（可观测 ID 分层与贯穿）/ ADR-0027（运维端点安全边界）。

## 2. 范围

### 2.1 做（按依赖顺序三波）

**W1 — M12.2 统一 Error / Audit Contract（P0 · 地基，先做）**

- 错误族收敛到唯一基类（`OBS-01`）+ 禁裸抛门禁与存量迁移（`OBS-02`）+ 码表单一来源（`OBS-03`）。
- `ErrorBody` / 信封契约唯一化与文档收口（`OBS-04`）+ 错误码进结构化日志（`OBS-05`）。
- `AuditEvent` 契约统一与 `audit_logs` 结构增强（`OBS-06`）+ replay 安全事件走统一审计路径（`OBS-07`）+ 契约测试门禁（`OBS-08`）。

**W2 — M12.1 Observability 贯穿（P1 · 依赖 W1，其次）**

- `requestId` 与 `traceId` 双 ID 分层（`OBS-09`）+ ALS 上下文扩展（`OBS-10`）+ logger 自动输出身份（`OBS-11`）。
- auth/security 指标段 + 基数护栏（`OBS-12`）+ 链路贯通端到端验证与排障样例（`OBS-13`）+ 审计检索面扩展（`OBS-14`）。

**W3 — M12.3 Maintenance / Health 暴露（P2 · 依赖 W2，最后）**

- maintenance 三层安全边界重定义（`OBS-15`）+ 运维端点全量普查与登记（`OBS-16`）+ 健康语义完整化（`OBS-17`）+ 快照契约统一（`OBS-18`）+ 部署侧边界同步（`OBS-19`）。

### 2.2 不做（明确划界）

| # | 不做 | 理由 |
|---|---|---|
| NG12-1 | **重命名 / 替换 `BizError` 类**（如全仓改叫 `FrameworkError`） | 会击穿 800+ 单测与前端 `instanceof` 契约，收益仅是叙事名。约定 `BizError` 即「框架统一错误模型」；如需对外名，加纯别名 `export { BizError as FrameworkError }`（见 OQ-1） |
| NG12-2 | **错误码段位重排 / 数字码改字符串码**（如 `3001` → `AUTH_REFRESH_REPLAY`） | 段位已被 PRD-001/009/010/011 与前端/mock/契约文档四方引用，改基座=全仓破坏性变更。字符串判别符（`outcome` / `reason`）保留为**内部状态判别**，不进对外错误码（见 6.2） |
| NG12-3 | **引入 `prom-client` 或自建指标存储** | 既有自研文本渲染已满足抓取；保持零新依赖（与 PRD-011 S-33 的命名规范协同，不重复建设） |
| NG12-4 | **自建 Trace 存储 / 查询 UI（APM）** | 与 PRD-011 NG11-7 同源；本 PRD 只保证 ID 正确、可关联、可检索于**既有**日志/审计面 |
| NG12-5 | **把 `requestId` 做成跨服务透传 ID** | 跨服务链路语义归 `traceId`（OTel）；`requestId` 只标识**单次 HTTP 请求**，跨进程不保证（避免双 ID 语义重叠，见 6.1） |
| NG12-6 | **改动 M11.1 rotation 核心 / Key Ring 密钥语义** | 严格沿 ADR-0020 Rule 8 组件边界与 ADR-0023/0024 冻结项；本 PRD 只**消费** `jti` / `familyId` / Key Ring 快照，不重定义其生产逻辑 |

## 3. 用户故事 / 场景

**oncall / 运维**

- 作为 oncall，我收到一条 `replay_detected` 告警，凭告警里的 `traceId` 一次拉出：这一条 HTTP 请求的 `requestId`、`traceId`、`userId`、`familyId`、`jti`、IP、UA、时间戳、事件名、结果——不用在日志里翻十行、不用去数据库里猜。
- 作为运维，我一眼能看出哪些端点是对外可访问的、哪些是运维专用的、哪些只在集群内网开，而不是逐个 `grep @Public`。

**落地项目开发者**

- 作为开发者，我在任何模块抛错都得到同一样式的信封（`{code,message,data,traceId,requestId,details?}`）；我不用猜这个模块是回 `AUTH_001` 还是 `3001`，也不会因为忘写错误码就静默变成 `500/9001`。
- 作为开发者，我调 REST 失败时，前端能直接拿 `code` 分支、拿 `details` 定位到具体字段，且文档与实现说的是一回事。

**SRE / 安全负责人**

- 作为 SRE，我能用 `fw_security_replay_detected_total` 直接建告警规则，不必解析日志。
- 作为安全负责人，`/auth-maintenance/*` 不再是公网可读——默认受保护，公开的每一条都有书面理由与契约测试锁定「零敏感」。

## 4. 功能需求（FR）

> 编号 `OBS-xx`（Observability & Contract）。每项可独立验收；**关键约束**列须在本项交付时逐条满足。⚠ 标记项为「动既有已全量验证的交付物」，回归判据为「既有 smoke 零改动通过」。

### W1 · M12.2 统一 Error / Audit Contract

| 编号 | 需求 | 关键约束 | 优先级 |
|---|---|---|---|
| OBS-01 | **错误族收敛**：确立 `@fw/core BizError` 为**唯一**错误基类。治理分三类：① 对外可表达为业务错误的族（`TransportError` / `TelemetryUnavailableError` / `ConfigValidationError` 等）改继承 `BizError` 并**显式声明默认码**，保留各自 `name` 与额外字段；② **内部信号类**（如 `TokenVerifyError` 作为 verify 失败判别、`JobTimeoutError` / `PermanentJobError` 作为队列控制流）保留独立类，但**禁止其上浮到 `GlobalExceptionFilter`**——必须由调用方转换为 `BizError`；③ 纯基础设施错误（懒加载/缺依赖，如 storage/queue/config-center 启动期失败）保持 fail-fast，但文案与码走统一表 | 三类归属清单写入 ADR-0025（一族一条，注明「为什么这样归」）；①类改继承后既有 `instanceof <原类>` 断言必须仍成立（子类关系不破坏）；对外信封**零变化**（回归以既有单测/冒烟零改动通过为准）；⚠ 逐族迁移，禁止一次性大改 | P0 |
| OBS-02 | **禁裸抛门禁 + 存量迁移**：新增门禁 `check-no-raw-throw`（沿既有 4 门禁范式），扫描 `packages/*/src` 与 `apps/*/src` 生产代码的 `throw new Error(`；白名单仅限：测试文件、CLI（不暴露 HTTP）、**启动期 fail-fast**（须以文件级注释豁免并在 ADR 登记）。存量迁移按批次推进，优先修「语义被降级为 9001」的点：`tenant-admin.controller.ts`（并发冲突应为 `1004`）、`key-ring.ts`（配置非法应为 `5002`/fail-fast 归类）、`job-executor.ts`、`storage/key.ts`、`tenant/resolver.ts` | 门禁只对生产目录生效；豁免以**显式注解**登记（非目录级通配），每处豁免给理由；迁移不得改变对外可观测行为（除「9001 → 精确码」这一预期修正，须在 CHANGELOG 登记）；门禁接入 CI 与本地同款命令 | P0 |
| OBS-03 | **码表单一来源**：`@fw/core ErrorCode` + `ERROR_CODE_META` 为唯一权威；导出为可消费工件（`error-codes.json` 或生成 TS），前端 `BIZ_CODE`（`apps/admin-web/src/utils/biz-error.ts`）、mock `CODE`（`apps/admin-web/mock/handlers.ts`）、模板副本改为**从同一源生成或构建期断言一致**（替换人肉「与后端同源」注释） | 前端既有 `Record<BizCodeValue,string>` 编译期同构校验保留；mock 与后端零差异纪律不变（N-02）；同源断言失败即构建失败（不给「警告通过」留口）；工件生成进既有构建链，不新增手工步骤 | P0 |
| OBS-04 | **错误契约唯一化 + 文档收口**：`ErrorBody` 提升为一等契约类型（`@fw/core` 导出 + `docs/contracts/api-web.ts` 与之对齐）；信封冻结为 `{ code, message, data, traceId, requestId?, details? }`（`details` **在顶层**）；修正 `docs/40-api-spec.md` §1.3 的 `data.details` 口径并补反向说明（历史 mock 形态已废弃） | 字段级契约写入 `docs/45-observability-contract.md`；前端 `request.ts` 的「顶层优先、兼容 `data.details`」兼容分支保留但标注 Deprecated（一个版本后移除，CHANGELOG 登记）；`requestId` 字段为**additive**（见 OBS-09），前端 BizError 与 mock 同步 | P0 |
| OBS-05 | **错误码进结构化日志**：`LogRecord` 增加错误码字段（顶层 `code?: number`），`GlobalExceptionFilter` 与业务 `logger.error` 统一填充；`error` 级日志支持从 `Error` 提取 `name`/`message`/`code`（`stack` 仅 error 级且仅落日志） | 不破坏既有日志字段与既有断言（`tenantId` 先例）；脱敏规则（`redact.ts`）覆盖新字段；日志中 **code 为数字一等字段**，使「按错误码检索」在日志侧成立 | P0 |
| OBS-06 | **AuditEvent 契约与 `audit_logs` 结构增强**：定义 `AuditEvent` 类型（`module` / `category` / `action` / `event` / `result` / `targetType` / `targetId` / `before` / `after` / `ip` / `userAgent` / `userId` / `familyId` / `jti` / `traceId` / `requestId` / `createdAt`）；`audit_logs` **软增列**（全 nullable）：`category`、`event`、`result`、`family_id`、`jti`、`request_id`；离线归档表 `audit_log_archives` **同构增列** | 全 nullable ⇒ 旧代码/旧数据零回归（M11.1 先例）；migration 三方言（example-api SQLite + PG 变体 + admin 模板）同构；新增索引 `event` / `family_id` / `request_id` / `(category, created_at)`；`action` DB 层保持 String，应用层枚举收敛；数据字典 §3.13/§3.17 同步；`category` 是否新增见 OQ-3 | P0 |
| OBS-07 | **replay 安全事件走统一审计路径**：`RefreshTokenService.handleReplay()` 不再直接 `store.writeAuditLog({ ..., traceId: null })`，改经 `AuditService`（或在调用处传 `getTraceId()` / `getRequestContext()`）；补齐 `AuditEvent` 九要素，尤其 **主泄漏路径（`refresh-token.service.ts:185` 当前只传 4 参 → `ip`/`ua` 为 `null`）必须补 `ip`/`userAgent`** | 不阻塞主流程（既有 try/catch 保留，落库失败降级日志）；事件名用点分命名 `refresh.replay_detected`（含 reason 变体：`grace_expired` / `no_replacement` / `expired` / `fingerprint_mismatch`）；`result='denied'`；**零改动 M11.1 rotation 核心与 replay 副作用语义**（只补「记录什么」，不改「判定什么」）；⚠ 回归以 M11.1/M11.3 既有 auth 用例零改动通过为准 | P0 |
| OBS-08 | **契约测试门禁**：为错误面建契约测试——每个错误码 → （信封形状 + http 映射 + 前端可解析 + i18n 键存在）；审计面——`AuditEvent` 序列化后字段完整且无敏感材料 | 含**反向验证**：未知异常收敛 `9001` 且响应体不含 `stack`/内部类名；`details` 顶层位置由断言锁死（防回退到 `data.details`）；安全事件审计序列化不得含 token 明文 / secret / cipher 段（沿 ADR-0024 `auth-maintenance.contract.spec.ts` 先例）；契约测试进 CI | P0 |

### W2 · M12.1 Observability 贯穿

| 编号 | 需求 | 关键约束 | 优先级 |
|---|---|---|---|
| OBS-09 | **`requestId` 与 `traceId` 双 ID 分层**：新增 per-request `requestId`（ULID，进程内唯一、单请求生命周期），在请求入口生成、写入 ALS、回带 `X-Request-Id` 响应头；`traceId` 保持跨服务语义（OTel，`X-Trace-Id` 透传/回带不变）；错误信封新增 `requestId`（additive） | `requestId` **不跨服务透传**（跨服务用 `traceId`，见 NG12-5）；若上游已带合法 `X-Request-Id` 则复用（与 traceId 同款正则校验）；生成位置早于业务逻辑、晚于或同于 traceId 均可（同一中间件内）；前端 `BizError` 增 `requestId`、`utils/trace.ts` 可记住最近 `requestId`；mock 同构（N-02 逐字节纪律）；`Cache-Control` 与既有响应头不变 | P1 |
| OBS-10 | **ALS 上下文扩展**：`RequestContext` 增加 `requestId` / `familyId` / `jti`（可选）；`RbacGuard` 写 `userId` 时**同时**写 `jti` / `familyId`（取 `request.user` 的 `jti` / `fam`）；refresh 流程在 `RefreshTokenService` 边界补写 `familyId` / `jti` | `patchRequestContext` 仍是唯一写入入口（既有 4 处调用点 + 新增）；**不改 `TokenService`**（严守 ADR-0020 Rule 8：编排者唯一 = `RefreshTokenService`，`TokenService` 纯计算）；`tenantDbUrl` 等既有敏感字段的「禁入日志」约束扩展到新字段：`familyId` / `jti` / `requestId` 属**可记**（非凭证），须在 ADR-0026 逐一说明安全属性；无上下文时（启动期）patch 为 no-op（既有语义） | P1 |
| OBS-11 | **logger 自动输出身份**：`LogRecord` 增加 `userId`（opaque id）+ 可选 `familyId` / `jti` / `requestId`，由 logger **自动从 ALS 读取**，无需调用方手塞 `ctx` | 沿用 `tenantId` 的「顶层字段 + 自动取」先例；**调用方手塞的 ctx 不覆盖自动字段**（防止误改）；脱敏规则覆盖；jti 是 token **标识**非 token 本体，可记（ADR-0026 记录安全论证）；⚠ 回归：既有日志断言零改动通过（新增字段为 additive，断言不得因新增字段失败） | P1 |
| OBS-12 | **auth / security 指标段**：`/metrics` 增 `fw_auth_*`（登录成功/失败、refresh 成功/失败、令牌校验失败按 `reason`）+ `fw_security_*`（`fw_security_replay_detected_total`、族撤销数、指纹不匹配数）；自研渲染延续（不引 `prom-client`） | **基数护栏**：label 仅允许**低基数枚举**（`reason` / `result` / `driver`），**禁止** `userId` / `familyId` / `jti` / `tokenId` 入 label；加**基数护栏单测**（断言渲染文本不含高基数字段值）；命名遵循 `fw_<域>_<指标>_<单位>`（与 PRD-011 S-33 收敛规范一致，避免两套命名）；指标段可开关（`METRICS_AUTH_SECTION_ENABLED`，默认 on） | P1 |
| OBS-13 | **链路贯通端到端验证 + 排障样例**：构造一次真实 replay 场景，断言同一请求的 `requestId`+`traceId` 在**四处**一致可关联——① 响应头（`X-Request-Id` / `X-Trace-Id`）② 结构化日志 ③ `audit_logs` 行 ④ `/metrics` 计数；产出「看到 `replay_detected` 如何一次拉全链」的排障样例文档 | 九要素齐全断言：`requestId` / `userId` / `familyId` / token(`jti`) / IP / UA / timestamp / event / result；样例文档命令**必须实测可跑**（不接受未验证命令块，沿 PRD-011 S-46 纪律）；用例进 CI 集成矩阵（依赖 SQLite 真库即可，不需 K8s） | P1 |
| OBS-14 | **审计检索面扩展**：既有审计查询端点支持按 `traceId` / `requestId` / `familyId` / `userId` / `action` / `category` / `event` 过滤与组合；补索引 | 列表参数（`sort` / `page` / `keyword` / 新增过滤项）**一律白名单解析**，未知字段 `400` 不静默忽略（既有约定）；导出端点（CSV / 归档）同步支持新过滤项；前端审计页可增筛选控件（可选，随 i18n 双表） | P1 |

### W3 · M12.3 Maintenance / Health 暴露

| 编号 | 需求 | 关键约束 | 优先级 |
|---|---|---|---|
| OBS-15 | **maintenance 三层安全边界重定义**：① **Public 自检**：`/health`、`/ready`、`/metrics`、`/metrics/queue`（无敏感，保持公开）；② **Protected maintenance**：`refresh-cleanup` / `audit-archive` / `key-ring` 及后续运维端点**默认受保护**（权限码或运维 token，见 OQ-4）；③ **内部诊断**：含运维细节的端点仅内网可达。默认**不留类级 `@Public` 裸奔**——公开项须显式白名单 + 书面理由 | 受保护方案二选一并 ADR 冻结：① 权限码 `ops:read`（进 `PERM` 权威表 + seed + 菜单/mock 四处同步）或 ② 运维 token（`OPS_TOKEN`，独立于用户体系）；**key-ring 若维持公开自检**须在 ADR-0027 明确「只暴露元数据、零敏感」并保留既有契约测试（`auth-maintenance.contract.spec.ts`）为锁定证据；**所有 maintenance 响应统一加 `Cache-Control: no-store`**（现仅 `key-ring` 有）；反向验证：未授权访问返回 `3002`（或 token 缺失 `401`） | P2 |
| OBS-16 | **运维端点全量普查与登记**：把全仓 `@Public` 端点与路径级公开项列成矩阵（`auth-maintenance/*` / `auth/login`·`register`·`refresh` / `oauth2/*` / `demo*` / `cache-demo` / `demo-queue` / `demo-transport` / `client-errors` / `events` SSE），逐条标注**必要性 / 暴露面 / 敏感度 / 环境约束**；`demo*` 自检控制器在**非 dev 环境默认关闭**（加 `DEMO_ENDPOINTS_ENABLED`，默认 `NODE_ENV==='development'`） | 产出 `docs/46-ops-endpoints.md`（矩阵文档）；关闭 demo 端点须反向验证「未开启时 404、开启时可用」；**不改 auth 登录/注册/refresh/回调/上报的必要公开性**（这些本就要求公开，只登记理由）；SSE 路径票据核销逻辑不变 | P2 |
| OBS-17 | **健康语义完整化**：`/health`（liveness，进程存活）与 `/ready`（readiness，依赖探针）语义标签文档化；如需 `liveness`/`readiness` 具名路径，以**同 handler 多路由别名**实现，零行为变化；readiness 探针集可配 | **不重命名既有路径**（K8s 映射 `/ready`、`/health` 已登记，改名=破坏部署契约）；别名若做必须与原名同 handler（同返回体、同 503 语义）；探针集配置化并登记 `ENV_KEY_PATHS`；`docs/60` §K8s 探针映射同步 | P2 |
| OBS-18 | **maintenance 快照契约统一**：三条（及后续）端点统一信封字段命名与含义（`name` / `expression` / `enabled` / `runs` / `lastRunAt` / `lastDurationMs` / `lastError` + 各自特有段）；纳入 api-spec §3.1 与矩阵文档 | 字段命名统一为同一套（消除 `lastCutoff` 类同义字段）；响应体形状由契约测试锁定（防字段漂移）；新增端点必须复用同一信封（防「随手 return 对象」）；api-spec 变更记录登记 | P2 |
| OBS-19 | **部署侧边界同步**：Nginx 三份配置（`deploy/nginx/fw.conf` / `fw-host.conf` / `fw-1panel-locations.conf`）白名单正则**补 maintenance**（或明确「maintenance 不上公网」）；K8s/Helm 侧加 NetworkPolicy / Ingress 限制；`check:helm` 门禁延伸校验三份配置一致 | 三份 Nginx 配置**逐项一致**（列同名单、同 allow 段），由门禁断言（不靠人眼）；真机 `106.55.32.251`（1Panel）验证一次实际边界；**部署侧与 OBS-15 应用层防护双保险**（应用层为主，部署侧为纵深）；文档同步 `docs/60` §Nginx | P2 |

## 5. 非功能需求（NFR）

| 维度 | 要求 |
|---|---|
| 兼容性 | 信封、日志、审计三处新增字段**一律 additive**（旧代码/旧数据/旧断言零回归）；`requestId` 为新增字段，前端 `BizError` 与 mock 同步（N-02 逐字节纪律）；错误族改继承后 `instanceof <原类>` 仍成立；`audit_logs` 增列全 nullable（M11.1 先例）；**M11.1 rotation 核心 / ADR-0023·0024 冻结项零改动** |
| 性能 | `requestId` 生成为 µs 级（ULID）；logger 新增自动字段**不得显著增加单请求日志序列化开销**（给出基线前后对比）；指标 label 低基数 ⇒ 基数不随租户/用户增长；审计增列不改变写入路径条数 |
| 安全 | maintenance 默认受保护（应用层 + 部署侧双保险）；公开端点逐条有理由与契约测试；脱敏规则覆盖 `userId` / `familyId` / `jti` / `requestId` 新字段；**日志/审计/响应/启动输出永不含 token 明文、secret、cipher 段**（ADR-0024 口径延伸，反向验证 grep） |
| 可观测 | 本 PRD 自身可被观测：错误码分布、安全事件计数进 `/metrics`；「错误全采」理念保持（`error` 级不被采样削弱，与 PRD-011 S-36 协同） |
| 可维护性 | 码表、`AuditEvent`、`ErrorBody`、运维信封四类契约各有**唯一权威定义**与**契约测试**；禁裸抛门禁零例外（豁免显式登记）；单测覆盖率不低于既有包基线 |
| 文档 | 收尾必同步：`docs/40-api-spec.md`（信封/details/错误码/maintenance 章节）+ `docs/30-data-dictionary.md`（audit 两表增列）+ `docs/60`（新配置键 + Nginx + K8s）+ `.env.example` + 根 README 导航 + CHANGELOG；新决策出 ADR |

## 6. 关键设计

### 6.1 双 ID 分层模型（`requestId` vs `traceId`）

| 维度 | `requestId`（新增） | `traceId`（既有） |
|---|---|---|
| 生成 | 请求入口，ULID | 请求入口，`X-Trace-Id` 复用或服务端生成；OTel 启用时=span traceId |
| 生命周期 | 单次 HTTP 请求 | 跨服务分布式链路 |
| 传输 | 进程内（ALS）+ `X-Request-Id` 响应头；**不跨服务透传** | ALS + `X-Trace-Id` 请求/响应头透传；OTLP 上报 |
| 用途 | 「这一次请求」的唯一锚点（日志/审计/响应三方关联） | 「这条链路」的锚点（跨服务排障、OTel 关联） |
| 唯一性 | 进程内唯一即可 | 全局（跨服务）一致 |

**取舍理由**：`traceId` 一旦被上游复用（`X-Trace-Id` 透传），同一 traceId 会覆盖多个 HTTP 请求，无法回答「这一条请求」；`requestId` 补足该语义。**代价**（如实登记）：新增一个 ID 概念与响应头、前端/mock 同步成本。若用户倾向「只用 `traceId`」，本项可整体降档（OQ-2 定夺），届时 `requestId` 相关列与字段一并移除。

### 6.2 错误模型收敛的三类治理规则（ADR-0025）

```
                  ┌──────────────────────────────────────┐
                  │  @fw/core BizError（唯一错误基类）      │
                  │  code / http（码表派生）/ details      │
                  └───────────────┬──────────────────────┘
                                  │
        ┌─────────────────────────┼─────────────────────────┐
        ▼                         ▼                         ▼
   ①对外业务错误族            ②内部信号类                ③基础设施 fail-fast
   继承 BizError             保留独立类，              保留独立类，
   （显式默认码）            禁止上浮到 Filter           启动期即失败
   TransportError           TokenVerifyError           （缺依赖/配置非法）
   TelemetryUnavailable     JobTimeoutError            文案走统一表
   ConfigValidationError    PermanentJobError
```

- **判别符（字符串）不进对外错误码**：`outcome: 'replay_detected'`（`auth-store.ts`）、`TokenVerifyReason`（`token.service.ts`）是**内部状态判别**，服务层据此映射为 `3001`/`3003` 等统一码后对外。ADR-0025 明确「判别符 ≠ 错误码」，杜绝未来把 `AUTH_REFRESH_REPLAY` 之流塞进码表造成双进制。
- **码表单一来源**：`@fw/core` 导出 `error-codes.json`（由 `ErrorCode` + `ERROR_CODE_META` 生成）；前端与 mock 构建期断言与之一致。前端**不直接依赖后端包**（避免打包后端代码），而是消费 JSON 工件。

### 6.3 `AuditEvent` 契约与 `audit_logs` 增列（ADR-0025）

**`audit_logs` 现状**（`apps/example-api/prisma/schema.prisma`）：`id / tenantId / userId / module / action / targetType / targetId / beforeValue / afterValue / ip / userAgent / traceId / createdAt`（索引含 `trace_id`）。

**软增列（全 nullable，旧代码零回归）**：

| 列 | 类型 | 语义 | 索引 |
|---|---|---|---|
| `category` | String? | 低基数大类：`auth` / `security` / `admin` / `data` / `config` / `tenant` / `system` | `(category, created_at)` |
| `event` | String? | 点分事件名：`refresh.replay_detected` / `auth.login` / `auth.logout` … | `event` |
| `result` | String? | `success` / `denied` / `failed` | — |
| `family_id` | String? | 令牌家族（M11.1） | `family_id` |
| `jti` | String? | 令牌标识（**非令牌本体**，安全可记） | — |
| `request_id` | String? | 单次请求 ID（OBS-09） | `request_id` |

离线归档表 `audit_log_archives` **同构增列**（保持「先写归档后删在线」不变量不受影响）。`action` DB 层保持 `String`（应用层 `AuditAction` 联合收敛），`category` 的**是否新增**见 OQ-3（若嫌列多，可由 `module + action` 派生，但失去低基数分区能力）。

**安全事件九要素落点**（OBS-13 断言对象）：

```
request_id ← OBS-09 请求入口生成              jti        ← OBS-10 RbacGuard 写 ALS
user_id    ← RbacGuard / AuditService.persist  ip / user_agent ← 请求对象（主路径补齐）
family_id  ← RefreshTokenService 边界         created_at ← now
event      ← 'refresh.replay_detected'        result     ← 'denied'
```

### 6.4 一条链（用户口述链路的落地形态）

```
HTTP request
  │  traceMiddleware：traceId（复用 X-Trace-Id 或生成）→ ALS + X-Trace-Id
  │                 requestId（复用 X-Request-Id 或生成 ULID）→ ALS + X-Request-Id
  ▼
Auth（RbacGuard：patchRequestContext { userId, tenantId, tenantVerified, jti, familyId }）
  │      refresh 流程：RefreshTokenService 边界补 familyId / jti
  ▼
Audit（AuditService.persist：自动取 ALS 的 traceId / requestId / userId + 显式 familyId / jti
  │    → audit_logs{ module, category, action, event, result, target_type, target_id,
  │                  before_value, after_value, ip, user_agent, trace_id, request_id,
  │                  user_id, family_id, jti, created_at }）
  ▼
security event（refresh.replay_detected → audit_logs 一行 + fw_security_replay_detected_total++ + error 级结构化日志）
```

**排障样例（G12-3 的验收形态）**——看到 `replay_detected` 后可完整定位：

```
$ curl -s "$API/api/v1/audit-logs?event=refresh.replay_detected&traceId=<tid>" -H "Authorization: Bearer $T"
→ { requestId, traceId, userId, familyId, jti, ip, userAgent, createdAt, event, result }
```

### 6.5 maintenance 三层安全边界（ADR-0027）

| 层 | 端点 | 鉴权 | 理由 |
|---|---|---|---|
| **Public 自检** | `/health`、`/ready`、`/metrics`、`/metrics/queue` | 无（路径白名单） | 探针与抓取需免鉴权；无敏感材料 |
| **Protected maintenance** | `refresh-cleanup`、`audit-archive`、`key-ring`、后续运维端点 | 权限码 `ops:read` **或** `OPS_TOKEN`（OQ-4） | 运维快照不宜公网可读；默认受保护 |
| **内部诊断** | 含运维细节的端点（如未来 `audit` 诊断） | 仅内网（Nginx/K8s 白名单） | 纵深防御第二层 |

**关键原则**：**默认受保护，公开需显式白名单 + 书面理由 + 契约测试**（反转当前「默认 `@Public`」的隐含约定）。`key-ring` 的既有公开自检模型若保留，须在 ADR-0027 登记「零敏感」评估与证据（`auth-maintenance.contract.spec.ts`）。

### 6.6 指标命名与基数护栏

- 命名：`fw_<域>_<指标>_<单位>`——如 `fw_auth_login_total{result="success|failed"}`、`fw_auth_token_verify_failed_total{reason="expired|invalid|missing"}`、`fw_security_replay_detected_total`、`fw_security_family_revoked_total`。
- **基数护栏（硬约束）**：label 只允许低基数枚举；**禁止** `userId` / `familyId` / `jti` / token 入 label（租户/用户维度走审计表或 PRD-011 S-03 聚合表，不进 Prometheus）。
- 与 PRD-011 S-33 的关系：**命名规范共用**，本 PRD 只新增 auth/security 段，不重复实现「标准指标集收敛」（那属 S-33）。

### 6.7 配置键规划（预估新增 ~6 键）

| 键 | 默认 | 归属 | 备注 |
|---|---|---|---|
| `REQUEST_ID_HEADER` | `X-Request-Id` | OBS-09 | 请求/响应头名 |
| `REQUEST_ID_ENABLED` | `true` | OBS-09 | 关闭则回退为「仅 traceId」（零行为差异） |
| `LOG_IDENTITY_FIELDS` | `userId,requestId` | OBS-11 | 决定 logger 自动输出哪些身份字段（低开销默认集） |
| `METRICS_AUTH_SECTION_ENABLED` | `true` | OBS-12 | auth/security 指标段开关 |
| `DEMO_ENDPOINTS_ENABLED` | `NODE_ENV==='development'` | OBS-16 | 生产默认关闭框架自检控制器 |
| `OPS_TOKEN`（可选） | 空 | OBS-15 | 若选运维 token 方案（OQ-4）；空则走权限码方案 |

> 全部键登记 `@fw/config` 的 `ENV_KEY_PATHS`；boot 键禁入热更白名单（E-16 教训）；`.env.example` 与 60 手册 §3 同步。**本 PRD 不新增错误码**（运维鉴权复用 `3002`；如需专用码由 OQ-4 决定后补，并同步 `docs/40` §2 与 PRD-001）。

### 6.8 计划新增文档与 ADR

| 类型 | 名称 | 内容 |
|---|---|---|
| ADR-0025 | 统一错误与审计契约 | 三类治理规则 / 判别符≠错误码 / `AuditEvent` 字段集 / `audit_logs` 增列 |
| ADR-0026 | 可观测 ID 分层与贯穿 | `requestId` vs `traceId` 语义 / ALS 字段 / jti 可记性安全论证 |
| ADR-0027 | 运维端点安全边界 | 三层模型 / 默认受保护原则 / key-ring 公开自检评估 |
| 文档 | `docs/45-observability-contract.md` | 错误契约字段级 + 一次拉全链排障样例 |
| 文档 | `docs/46-ops-endpoints.md` | 运维端点矩阵（必要性/暴露面/敏感度/环境） |

## 7. 验收标准（AC）

### W1 · P0（M12.2）

- [x] AC-OBS-01（OBS-01）：ADR-0025 三类归属清单逐族登记（含两类改判与证据）；①类族继承 `BizError` 后既有 `instanceof <原类>` 断言仍成立（反向验证）；对外信封零变化（既有单测/冒烟零改动通过）。（2026-10-17 W1 收口）ADR-0025 三类归属清单逐族登记；①类族继承 `BizError` 后既有 `instanceof <原类>` 断言仍成立（反向验证）；对外信封零变化（既有单测/冒烟零改动通过）。
- [x] AC-OBS-02（OBS-02）：`check-no-raw-throw` 门禁在生产目录零未豁免命中（291 文件 / 行级豁免 2 + 白名单文件 1）；豁免均显式登记且每处有理由（ADR-0025）；`tenant-admin.controller.ts` 并发冲突返回精确码（`1004`）而非 `9001`（BizError 迁移 + 消息不变既有断言零改动通过）；CHANGELOG 登记行为修正。（2026-10-17 W1 收口）`check-no-raw-throw` 门禁在生产目录零未豁免命中；豁免均为显式注解且每处有理由；`tenant-admin.controller.ts` 并发冲突场景返回精确码（`1004`）而非 `9001`（反向验证前后对照）；CHANGELOG 登记行为修正。
- [x] AC-OBS-03（OBS-03）：前端 `BIZ_CODE` 与 mock `CODE` 由 triway 轴 G 构建期断言与 `error-codes.json`（core 生成工件）一致；**人为篡改码表其一即构建失败**（反向验证实况：mock 缺 2001/4001/9002 时门禁红，补齐后绿）；前端 `Record<BizCodeValue,string>` 同构校验保留。（2026-10-17 W1 收口）前端 `BIZ_CODE` 与 mock `CODE` 由 `error-codes.json` 生成或构建期断言；**人为篡改码表其一即构建失败**（反向验证）；前端 `Record<BizCodeValue,string>` 同构校验保留。
- [x] AC-OBS-04（OBS-04）：`docs/40-api-spec.md` 的 `details` 位置口径与实现一致（顶层）；`data.details` 兼容分支标注 Deprecated 并给出移除版本；`ErrorBody` 与 `docs/contracts/api-web.ts` 对齐。（2026-10-17 W1）
- [x] AC-OBS-05（OBS-05）：`GlobalExceptionFilter` 与业务 `logger.error` 均输出 `code`；`error` 级日志含 `name`/`message`/`code`（`stack` 仅日志侧）；反向验证：响应体不含 `stack`。（2026-10-17 W1：`LogRecord.code` 一等字段 + `LogOptions`，logger.code.test 3 条 + core e2e 既有「不外泄堆栈」断言）
- [x] AC-OBS-06（OBS-06）：`audit_logs` 与 `audit_log_archives` 新增 6 列（全 nullable）三方言同构（example-api SQLite / PG 变体 / MySQL 变体 init + admin 模板）；新增索引生效；反向验证：全列 nullable 由 schema 锁定、旧数据无需回填即可落库（admin 模板冒烟 migrate+seed 实测）；数据字典 §3.13/§3.17 同步。（2026-10-17 W1）
- [x] AC-OBS-07（OBS-07）：replay 安全事件审计行含 `trace_id`（非 null）+ `request_id`（W2 起由 ALS 填充，直连 store 路径同取）+ `family_id` + `jti` + `event` + `result='denied'`；主泄漏路径 `ip`/`ua` 非 null；落库失败降级日志且不阻塞主流程（既有断言保留）；M11.1/M11.3 既有 auth 用例零改动通过。（2026-10-17 W2：request_id 贯通后收口，observability-chain 集成用例锁定）replay 安全事件审计行含 `trace_id`（非 null）+ `request_id` + `family_id` + `jti` + `event` + `result='denied'`；**主泄漏路径 `ip`/`ua` 非 null**（反向验证：构造无 UA 请求时行为明确）；落库失败降级日志且不阻塞主流程（既有断言保留）；M11.1/M11.3 既有 auth 用例零改动通过。
- [x] AC-OBS-08（OBS-08）：每个错误码契约测试通过（16 码信封 + http + i18n 键双语言覆盖 + 前端可解析由轴 G 同源保证）；未知异常 → `9001` 且不含内部细节（反向验证）；`AuditEvent`/maintenance 快照序列化零敏感材料（grep 断言无 token 明文 / secret / cipher 段；maintenance 侧沿 ADR-0024 既有契约测试）。（2026-10-17 W1 收口）每个错误码契约测试通过（信封 + http + 前端可解析 + i18n 键）；未知异常 → `9001` 且不含内部细节（反向验证）；`AuditEvent`/maintenance 快照序列化零敏感材料（grep 断言无 token 明文 / secret / cipher 段）。

### W2 · P1（M12.1）

- [x] AC-OBS-09（OBS-09）：`X-Request-Id` 请求/响应头生效；上游合法复用、非法替换（反向验证）；信封含 `requestId`（additive）；前端 `BizError.requestId` 与记忆层同步；`REQUEST_ID_ENABLED=false` 回退仅 traceId 零差异。**范围边界**：mock 服务端响应暂不携带 requestId（前端类型已同步、mock 模式该字段为 null 不影响行为，W3 批次补齐）。（2026-10-17 W2）`X-Request-Id` 请求/响应头生效；上游合法 `X-Request-Id` 被复用、非法值被替换（反向验证）；信封含 `requestId`；前端 `BizError.requestId` 与 mock 同构；`REQUEST_ID_ENABLED=false` 时回退为仅 `traceId`（零差异）。
- [x] AC-OBS-10（OBS-10）：`RequestContext` 含 `requestId`/`familyId`/`jti`；鉴权后这些字段可从 ALS 读出（RbacGuard + rotate 边界写入，logger/audit 自动消费）；`TokenService` 文件 **diff = 0**（git diff 实测 0，豁免改走门禁单文件白名单）；无上下文时 patch no-op。（2026-10-17 W2）`RequestContext` 含 `requestId`/`familyId`/`jti`；鉴权后这些字段可从 ALS 读出；`TokenService` 文件 **diff = 0**（守住 ADR-0020 Rule 8，git diff 为证）；无上下文时 patch no-op。
- [x] AC-OBS-11（OBS-11）：日志自动输出 `userId`/`requestId`（默认集，`LOG_IDENTITY_FIELDS` 门控）无需手塞；调用方手塞同名 ctx 不覆盖自动字段（反向验证）；既有日志断言零改动通过（additive）。（2026-10-17 W2）日志自动输出 `userId`（+ `requestId` 等）无需调用方手塞；**调用方手塞同名 ctx 不覆盖自动字段**（反向验证）；既有日志断言零改动通过；grep 日志断言无 token 明文。
- [x] AC-OBS-12（OBS-12）：`/metrics` 出现 `fw_auth_*` 与 `fw_security_*` 段且计数正确（登录/verify/replay 构造用例计数锁定）；**基数护栏单测**：身份进 ALS 时渲染文本不含 `userId`/`familyId`/`jti`/`requestId` 值且 label 键仅 result/reason（反向验证）；`METRICS_AUTH_SECTION_ENABLED=false` 时该段消失。（2026-10-17 W2）`/metrics` 出现 `fw_auth_*` 与 `fw_security_*` 段且计数正确（构造登录失败/replay 各一例后计数 +1）；**基数护栏单测**：断言 label 不含 `userId`/`familyId`/`jti` 值（反向验证）；`METRICS_AUTH_SECTION_ENABLED=false` 时该段消失。
- [ ] AC-OBS-13（OBS-13）：**部分完成**——同一次 replay 场景 `requestId`+`traceId` 在 `audit_logs` 行 / 结构化日志 / `/metrics` 计数**三处一致** + 九要素齐全已由 `observability-chain.integration.spec.ts`（SQLite 真库）锁定；响应头第四处由 core `trace-request-id.test.ts` 锁定（2026-10-17 W2）。**剩**：`docs/45` 排障样例命令逐条实测（需起真实服务，并入 W3 真机验证批次执行，与 OBS-19 真机实测同批）。同一次 replay 场景下 `requestId`+`traceId` 在响应头、日志、`audit_logs` 行、`/metrics` 计数四处一致可关联；九要素齐全断言通过；排障样例文档命令**实测可跑**（逐条执行验证）。
- [x] AC-OBS-14（OBS-14）：审计查询支持按 `traceId`/`requestId`/`familyId`/`userId`/`action`/`category`/`event` 过滤与组合（Prisma/Memory 存储同语义单测 + 集成用例）；未知过滤字段返回 `400`（反向验证，白名单单测锁定）；导出端点同步支持（params/重建/CSV 列，mock 逐字节同构）。（2026-10-17 W2）审计查询支持按 `traceId`/`requestId`/`familyId`/`userId`/`action`/`category`/`event` 过滤与组合；未知过滤字段返回 `400`（反向验证，不静默忽略）；导出端点同步支持。

### W3 · P2（M12.3）

- [x] AC-OBS-15（OBS-15）：maintenance 端点默认**不再**类级 `@Public` 裸奔（元数据断言：类级无 @Public + `@Permissions('ops:read')`）；未授权访问被拒（未登录 3001 / 无权限 3002，权限码语义 + 守卫单测；真机 HTTP 实测待部署窗口）；公开项逐条有书面理由 + 契约测试（`docs/46` 矩阵 + key-ring 零敏感断言保留）；**全部 maintenance 响应含 `Cache-Control: no-store`**（三端点元数据断言）。（2026-10-17 W3）maintenance 端点默认**不再**类级 `@Public` 裸奔——未授权访问被拒（`3002` 或 `401`，反向验证）；公开项逐条有书面理由 + 契约测试；**全部 maintenance 响应含 `Cache-Control: no-store`**（含 refresh-cleanup / audit-archive，现仅 key-ring 有）；`key-ring` 零敏感契约测试保留。
- [x] AC-OBS-16（OBS-16）：`docs/46-ops-endpoints.md` 矩阵覆盖全部 `@Public` 与路径级公开项，逐条标注四要素；`demo*` 自检控制器在 `DEMO_ENDPOINTS_ENABLED=false`/非 dev 时不可达（404，反向验证 guard 单测；真机 HTTP 404 待部署窗口）；登录/注册/refresh/回调/上报的公开性不变（矩阵登记理由）。（2026-10-17 W3）`docs/46-ops-endpoints.md` 矩阵覆盖全部 `@Public` 与路径级公开项，逐条标注四要素；`demo*` 自检控制器在 `DEMO_ENDPOINTS_ENABLED=false` 时不可达（反向验证：默认生产 404、dev 可用）；登录/注册/refresh/回调/上报的公开性不变。
- [x] AC-OBS-17（OBS-17）：`/health` 与 `/ready` 语义标签文档化（`docs/46` §1 + `docs/60` K8s 探针映射既有）；**路径未改名**（零行为变化，反向验证=既有探针配置与 K8s 清单不动）；别名未做（无消费方，登记）；readiness 探针集既有配置化保持（`READINESS_PROBES`）。（2026-10-17 W3）`/health` 与 `/ready` 语义标签文档化；**路径未改名**（K8s 映射不变，反向验证既有探针配置仍有效）；别名若做则同 handler 同返回体；readiness 探针集可配且登记 `ENV_KEY_PATHS`。
- [x] AC-OBS-18（OBS-18）：三条 maintenance 端点信封字段命名统一（公共字段集 `{name,expression,enabled,runs,lastRunAt,lastDurationMs,lastError}` + 各自特有段，additive 补 enabled/lastDurationMs）；响应形状由契约测试锁定（快照公共字段集断言）；api-spec maintenance 口径同步。（2026-10-17 W3）三条 maintenance 端点信封字段命名统一（消除同义字段）；响应形状由契约测试锁定；api-spec §3.1 与矩阵文档同步。
- [ ] AC-OBS-19（OBS-19）：**部分完成**——Nginx 三份配置逐项一致地覆盖探针白名单 + **maintenance 不上公网**由 `check:helm` 扩展轴断言（65/65，非人眼）；`docs/60` 同步。**剩**：K8s/Helm 侧 NetworkPolicy/Ingress 限制（现仅探针路径，待评估是否加策略资源）；真机 `106.55.32.251` 实测边界一次（与 AC-OBS-13 同批，需部署窗口）。（2026-10-17 W3）Nginx 三份配置逐项一致地覆盖 maintenance（门禁断言，非人眼）；K8s/Helm 侧有 NetworkPolicy/Ingress 限制；真机 `106.55.32.251` 实测边界一次（记录结果）；`check:helm` 扩展校验三份一致；`docs/60` §Nginx 同步。

## 8. 依赖与风险

| 项 | 说明 | 缓解 |
|---|---|---|
| **依赖既有冻结项** | 本 PRD 大量「读」M11 系列成果（`jti`/`familyId`/Key Ring 快照/replay 语义） | 严守 NG12-6：只消费不重定义；每项 AC 含「rotation 核心 diff = 0」或「M11 用例零改动通过」 |
| **同时动三大面（错误/观测/暴露）** | 三波都碰 `@fw/core` / `@fw/auth` / `@fw/logger` / `example-api`，并行改易互相踩 | 按 W1→W2→W3 **串行**推进；W1 先冻结契约（`ErrorBody`/`AuditEvent`/码表），W2/W3 只在其上扩展 |
| **信封新增 `requestId` 的跨端成本** | 触碰前端契约 + mock（N-02 逐字节纪律）+ 前端单测 | 作为 **additive** 字段；同步四件（前端类型 / `request.ts` / mock / 单测）；若成本超预期走 OQ-2 降档（整体移除 requestId） |
| **错误族迁移的回归风险** | OBS-01/02 改动面广（6 族 + 存量裸抛），既有 800+ 单测依赖现状 | 逐族小步迁移，每族一提交；回归判据「既有用例零改动通过」；门禁先「警告」后「阻断」（两阶段上线） |
| **审计增列的迁移成本** | 三方言 + 归档表同构 + 数据字典 + 索引 | 沿用 M11.1 增列先例（全 nullable、模板同构、`migrate diff` 生成）；一次 `migrate deploy` 验证 |
| **`@Public` 反转可能误伤** | 反转默认值可能拒掉合法公开端点（登录/SSE/上报） | 先做 OBS-16 全量普查再动 OBS-15；逐端点显式分类；反向验证「该公开的仍公开」 |
| **部署侧配置漂移** | Nginx 三份 + Helm 易不一致（人工维护） | `check:helm` 扩展为断言三份一致；真机实测兜底 |
| **文档同步成本** | 5 处同步（api-spec / 数据字典 / 60 / README / CHANGELOG）× 19 项 | 文档同步写进每项 AC；波次收尾做一次一致性核对（复用 docs/95 六维度方法论） |

## 9. 待定问题（Open Questions）

| # | 问题 | 建议结论 | 负责人 / 时间 |
|---|---|---|---|
| OQ-1 | **统一错误类名**：保留 `BizError` 还是引入 `FrameworkError`？ | 建议**保留 `BizError` 为唯一基类**（零回归），文档称其为「框架统一错误模型」；如需对外叙事名，加纯别名 `export { BizError as FrameworkError }`（零成本、零行为变化）。理由：改名是纯叙事收益、全仓破坏成本 | donttemo / W1 开工前 |
| OQ-2 | **`requestId` 是否独立于 `traceId`？** | 建议**独立**（分层语义见 6.1）——`traceId` 被上游复用后无法回答「这一次请求」。若评估跨端成本过高，可整体降档为「仅 `traceId`」，届时 OBS-09 相关字段/列移除 | donttemo / W2 开工前 |
| OQ-3 | **`audit_logs` 是否新增 `category` 列？** | 建议**新增**（低基数大类，利于分区/粗筛与运营界面分组）；若嫌列多，可由 `module + action` 派生（但失去低基数索引能力）。`event` / `result` / `family_id` / `jti` / `request_id` 五列为**必需** | donttemo / W1 开工前 |
| OQ-4 | **maintenance 运维鉴权形态**：权限码 `ops:read` vs 运维 token（`OPS_TOKEN`）vs 仅内网白名单？ | 建议**权限码 `ops:read` 为默认**（复用既有 RBAC 与审计链路，零新体系）+ `OPS_TOKEN` 作为「无用户体系部署」的可选逃生门 + 内网白名单作纵深；纯内网部署可只留白名单但在 ADR 登记 | donttemo / W3 开工前 |
| OQ-5 | **平行错误族是否全部继承 `BizError`？** | 建议**分两批**：W1.1 迁移①类（对外业务错误族）；W1.2 处理②③类（内部信号 / fail-fast）按「保留但禁止上浮」处理。内部信号类（`TokenVerifyError` 等）**不继承**，避免污染基类语义 | donttemo / W1 开工前 |
| OQ-6 | **码表工件形式**：JSON 生成 vs 共享 TS 包？ | 建议**导出 `error-codes.json`**（由后端生成、进构建链），前端/mock 消费 JSON + 构建期断言；**不让前端直接依赖后端包**（避免打包后端代码与循环依赖） | donttemo / W1 开工前 |
| OQ-7 | **`requestId` 是否进错误信封？** | 建议**进**（与 `traceId` 并列，additive）——前端弹错时能同时展示两个 ID 便于用户报障；若前端展示不必要，可只在响应头 + 日志 + 审计落地（信封不加），此取舍由 W2 实测成本定 | donttemo / W2 开工前 |

> **依赖前序 PRD 的交叉项（登记，不在本 PRD 范围）**：PRD-011 S-33（标准指标集收敛）/ S-34（Grafana 面板与告警规则）/ S-35（日志聚合）/ S-36（OTel 采样策略）/ S-37（RUM 多实例聚合）与本 PRD 的 W2 观测面**语义相邻**——本 PRD 负责「ID 正确 + 契约统一 + 指标段补齐」，S-33~S-37 负责「命名收敛 + 面板 + 聚合 + 采样」。**命名规范两者共用（`fw_<域>_<指标>_<单位>`）**，实现时以先落地者为准，避免两套命名；若 S-33 先行，本 PRD 的 `fw_auth_*`/`fw_security_*` 直接并入其标准集。
