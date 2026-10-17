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
```

**基数护栏（硬约束）**：label 仅允许低基数枚举（`result` / `reason`）；`userId` / `familyId` / `jti` /
`requestId` 禁止入 label（用户/租户维度走审计表，见 §5）——由 `auth-metrics.test.ts` 反向锁定。

## 5. 审计检索键（OBS-14）

`GET /api/v1/audit-logs` 与 `/export` 支持过滤参数（白名单外字段一律 `400/1001`，不静默忽略）：

`user_id` `module` `action` `target_type` `target_id` `from` `to` `sort`
`trace_id` `request_id` `family_id` `category` `event`

CSV 导出列同步：`...,traceId,requestId,familyId,category,event,before,after`。

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
