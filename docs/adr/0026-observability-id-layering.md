<!--
@file ADR-0026 · 可观测 ID 分层与贯穿
@description M12 W2（PRD-012 OBS-09~OBS-14）的决策记录：requestId 与 traceId 的语义分层、
  ALS 上下文扩展、logger 自动身份输出、auth/security 指标段与基数护栏、审计检索键扩展。
@author donttemo
@created 2026-10-17
-->

# ADR-0026 · 可观测 ID 分层与贯穿

- 状态：**已采纳**（2026-10-17）
- 关联：PRD-012（OBS-09~OBS-14）、ADR-0025（统一错误与审计契约）、ADR-0010（traceId 统一）、ADR-0020 Rule 8（组件边界）

## 1. 决策

### 1.1 双 ID 分层（OBS-09；OQ-2 / OQ-7 定案）

- **`requestId` 独立于 `traceId`**：ULID（26 位 Crockford Base32，进程内唯一、按时间有序），单次 HTTP 请求
  生命周期，`X-Request-Id` 回带；上游合法值复用、非法值替换；**不跨服务透传**（跨服务语义归 `traceId`，
  NG12-5 不做双透传）。`REQUEST_ID_ENABLED=false` 回退仅 traceId（零行为差异）；`REQUEST_ID_HEADER` 可换头名。
- **进错误信封（OQ-7 采纳「进」）**：`ErrorBody.requestId` 为 additive 字段，仅请求上下文存在时输出——
  旧断言（不含该键）零回归；前端 `BizError.requestId` + `utils/trace.ts` 记忆 + mock 同构同步。
- `requestId` 进 `audit_logs.request_id`（W1 列先行）：`AuditService.persist` 自动取 ALS；**replay 直连
  store 的审计路径（ADR-0025 备选决策）同样自取** `getRequestContext()?.requestId`。

### 1.2 ALS 上下文扩展（OBS-10）

`RequestContext` 增 `requestId?` / `familyId?` / `jti?`；`patchRequestContext` 仍是唯一写入入口：

- `RbacGuard` 写 `userId` 时同写 `jti` / `familyId`（取 `request.user.jti` / `request.user.fam`，存在才写）；
- `RefreshTokenService.rotate` 边界补写 `familyId` / `jti`（编排者职责，ADR-0020 Rule 8 不动判定语义）；
- **`TokenService` 文件 diff = 0**（NG12-6 的 AC 证据）。

### 1.3 身份字段安全论证（jti / familyId / requestId 可记）

| 字段 | 属性 | 论证 |
|---|---|---|
| `userId` | opaque ID | 既有先例（审计表已落） |
| `requestId` | 随机 ULID | 无业务含义，不可用于重放或越权 |
| `familyId` | 随机 UUID | 令牌家族标识，非凭证；泄漏只能查表，不能构造有效令牌 |
| `jti` | 随机 UUID | **token 标识非 token 本体**——JWT 本体含签名与 claim，jti 只是数据库行指针；且 `redact.ts` 管道覆盖新字段 |

对照红线：`tenantDbUrl`（租户连接串明文）维持禁入日志与审计；token 明文 / secret / cipher 段由
`audit-no-secrets.test.ts` 反向锁定。

### 1.4 logger 自动身份（OBS-11）

`LogRecord` 顶层增 `userId` / `requestId`（默认集）/ `familyId` / `jti`，logger 从 ALS 自动读取；
`LOG_IDENTITY_FIELDS` 门控（未配置=默认集；显式空串=关闭全部）。调用方手塞同名 ctx **不覆盖**顶层自动字段
——身份以鉴权事实为准，伪造值只可能出现在 `ctx`（经脱敏管道）。

### 1.5 指标段注册表与 auth/security 段（OBS-12）

- `@fw/core` 新增模块级指标段注册表（`registerMetricsSection` / `renderExtraMetricSections`）：各域包注册
  自己的 Prometheus 文本渲染器，`/metrics` 控制器（@fw/cache）输出尾部统一追加。零新依赖（NG12-3），
  渲染异常静默缺席不拖垮整体。
- `@fw/auth` 注册 `auth_security` 段：`fw_auth_login_total` / `fw_auth_refresh_total` /
  `fw_auth_token_verify_failed_total{reason}` / `fw_security_replay_detected_total{reason}` /
  `fw_security_family_revoked_total`。计数点：AuthService.login（包装收敛成败）、
  RefreshTokenService.rotate（包装收敛）+ handleReplay / revokeFamily、RbacGuard verify 失败按 reason。
- **基数护栏**：label 仅 `result` / `reason` 低基数枚举；userId / familyId / jti / requestId 禁入 label
  （单测反向锁定）。
- 命名规范与 PRD-011 S-33 共用（`fw_<域>_<指标>_<单位>`）；本 PRD 只补 auth/security 段。

### 1.6 审计检索键（OBS-14）

`AuditQuery` 增 `traceId` / `requestId` / `familyId` / `category` / `event`；Prisma 与 Memory 存储同语义过滤；
控制器以 `AUDIT_FILTER_PARAMS` 白名单收敛——**未知过滤参数 400**（不静默忽略，既有约定）；导出 params /
重建 / CSV 列同步；mock 与前端类型三副本对齐（N-02）。

## 2. 备选与取舍

| 备选 | 否决理由 |
|---|---|
| 只用 `traceId` 兼任请求 ID（OQ-2 降档） | 上游复用 `X-Trace-Id` 后同一 traceId 覆盖多个请求，无法回答「这一条请求」；且改动已落地的审计列与信封契约 |
| `requestId` 只进响应头不进信封（OQ-7 降档） | 前端报障时用户只看得到弹错信封，双 ID 同展示才能闭环报障 |
| 指标计数埋在各调用点逐个打点 | 登录/轮换失败路径多（多个 throw 点），包装收敛一处 try/catch 语义等价且防漏 |
| prom-client / 指标存储 | NG12-3：自研文本渲染已满足，零新依赖 |
| HTTP 端到端响应头断言进集成矩阵 | 起真实服务成本高；中间件回带 + 信封 additive 已由 `trace-request-id.test.ts` 单测锁定，集成矩阵覆盖其余三处 |

## 3. 影响

- 信封 / 日志 / 审计三面新增字段全部 **additive**；旧断言零回归（既有 800+ 用例不改通过）。
- 新配置键 4 个：`REQUEST_ID_ENABLED` / `REQUEST_ID_HEADER` / `LOG_IDENTITY_FIELDS` /
  `METRICS_AUTH_SECTION_ENABLED`（登记 `ENV_KEY_PATHS` + `.env.example` + `docs/60` §3）。
- 新文档：`docs/45-observability-contract.md`（契约手册 + 实测排障样例）。
