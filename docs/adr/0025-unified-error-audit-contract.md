<!--
@file ADR-0025 · 统一错误与审计事件契约
@description M12 W1（PRD-012 OBS-01~OBS-08）的决策记录：错误三类治理、判别符≠错误码、
  统一审计事件契约与 audit_logs 软增列、replay 安全事件九要素。
@author donttemo
@created 2026-10-17
-->

# ADR-0025 · 统一错误与审计事件契约

- 状态：**已采纳**（2026-10-17）
- 修订：2026-10-17 W1 批次逐族落地时按既有测试锁与包依赖方向修正两类归属（§2.1 表内「改判」行），
  并登记禁裸抛门禁豁免清单——改判均为证据驱动（测试零改动 / 包循环依赖），登记于本文件 §2.1
- 关联：PRD-012（OBS-01~OBS-08）、ADR-0010（traceId 统一）、ADR-0014（错误码文案前端接管）、ADR-0020/0022/0024（replay 安全事件与审计口径的前序）

## 1. 背景

框架自 M1 起已有统一错误类 `@fw/core BizError`（`code` / `http`（码表派生）/ `details` / `message`）与集中码表
`ErrorCode` / `ERROR_CODE_META` / `HTTP_TO_ERROR_CODE`，`GlobalExceptionFilter` 把一切异常归一化进
`ErrorBody = { code, message, data: null, traceId, details? }`（`details` 在**顶层**）。但实际状态是
「机制在、契约不在」：

1. **平行错误族**：`TransportError` / `TelemetryUnavailableError` / `TelemetryConfigError` /
   `PermanentJobError` / `JobTimeoutError` / `TokenVerifyError` / `ConfigValidationError` 各自继承裸 `Error`；
2. **裸抛降级**：生产代码大量 `throw new Error()`（如 `tenant-admin.controller.ts` 的并发冲突、`key-ring.ts`
   的配置校验），被 Filter 一律收敛为 `9001`，丢失 `1004` / `5002` 等精确语义；
3. **码表三副本**：core `ErrorCode` / 前端 `BIZ_CODE` / mock `CODE` 人肉「同源」；
4. **文档口径分歧**：`docs/40-api-spec.md` 曾称 `details` 在 `data.details`，实现与前端在顶层；
5. **审计断链**：replay 安全事件审计行 `traceId` 硬编码 `null`，主泄漏路径丢 `ip` / `userAgent`，
   `familyId` 只能塞 `target_id`，无 `event` / `result` / `jti` / `request_id` 落点——
   「看到 replay_detected 只有一句话」，无法定位九要素。

## 2. 决策

### 2.1 错误三类治理（OBS-01）

| 类 | 处置 | 成员 |
|---|---|---|
| ① 对外业务错误族 | 继承 `BizError`，显式声明默认码，保留各自 `name` 与额外字段 | `TransportError`、`TelemetryUnavailableError`、`ConfigValidationError` 等 |
| ② 内部信号类 | **保留独立类，禁止上浮到 `GlobalExceptionFilter`**——必须由调用方转换为 `BizError` | `TokenVerifyError`（verify 失败判别）、`JobTimeoutError` / `PermanentJobError`（队列控制流） |
| ③ 基础设施 fail-fast | 保留独立类，启动期即失败；文案与码走统一表 | storage / queue / config-center 缺依赖与配置校验 |

逐族迁移、每族一提交；既有 `instanceof <原类>` 断言必须仍成立（子类关系不破坏）；对外信封零变化。

**逐族落地结果（2026-10-17 W1 批次，含两类基于既有测试锁的归属修正）**：

| 族 | 归属 | 处置与证据 |
|---|---|---|
| `TelemetryUnavailableError` | ① | 继承 `BizError`（默认码 9002）；`instanceof TelemetryUnavailableError` 既有断言零改动通过 |
| `TelemetryConfigError` | ③ | 继承 `BizError`（默认码 5002），保留独立类名与启动期 fail-fast 语义 |
| `TransportError` 族 | **②（改判）** | 原判①。但既有测试 `errors-registry.test.ts` 以 `expect(rebuilt).not.toBeInstanceOf(BizError)` 锁定跨进程重建契约——**重建身份由载荷 code 决定**（已知码重建 BizError、未知码重建 TransportError），类继承 BizError 必然击穿「既有用例零改动通过」。改判理由：该族是跨进程错误**载体**而非业务错误源；「调用方转换」已在 demo-transport 控制器落地（`mapTransportError` → BizError），满足②类「禁止上浮、调用方转换」要求 |
| `ConfigValidationError` | **③（改判）** | 原判①。`@fw/config` 不依赖 `@fw/core`，而 `@fw/core` 依赖 `@fw/config`——继承 BizError 将制造包循环依赖（core→config→core）。启动期聚合校验错误（bootstrap 打印即退出，不经 HTTP 面）归③：保留独立类，多行聚合文案即统一表达 |
| `TokenVerifyError` / `JobTimeoutError` / `PermanentJobError` | ② | 保留独立类；verify 失败由守卫映射 3001/3003，队列控制流由驱动消费，不上浮 Filter |
| `CasLostError`（example-api / 模板，非导出） | ② | CAS 控制流内部信号，调用方捕获转译 |

**禁裸抛门禁豁免登记（OBS-02；全部为行级显式注解 `fw-allow-raw-throw:`，非目录级通配）**：

| 位置 | 形态 | 理由 |
|---|---|---|
| `packages/auth/src/token.service.ts`（4 处：JWT_SECRET 校验 ×2、replacement 密钥路由 ×2） | **门禁单文件白名单**（非行内注解——AC-OBS-10 要求 TokenService 文件 diff = 0，加注解本身即制造 diff） | ADR-0020 Rule 8 冻结 TokenService（NG12-6）；前两处为启动期配置 fail-fast，后两处为②类解密路由内部信号（调用方捕获映射） |
| `apps/example-api/src/modules/demo/demo.controller.ts`（行级注解） | 行级 `fw-allow-raw-throw:` | 演示端点本体——该行就是「未知异常收敛 9001」的演示对象 |
| `apps/example-api/src/modules/demo-queue/demo-queue.jobs.ts`（行级注解） | 行级 `fw-allow-raw-throw:` | 演示任务本体——故意失败驱动重试/死信演示 |

**存量迁移摘要（约 60 处 → BizError 统一码）**：配置非法/缺依赖 → `5002` / `9002`（key-ring ×13、
auth.module、storage.module、nacos/file driver、redis-client、queue.module 等）；请求/入参语义 → `1001` /
`1002`（storage key ×6、job 驱动、memory-auth-store、tenant-admin 迁移校验）；状态语义 → `1004`
（tenant-admin 并发修改/租户已移除——OBS-02 点名的「9001 降级」修正）；内部不变量 → `9001`
（redis 令牌桶脚本契约、S3 Body 形态、db-url 密文损坏）。行为修正（`9001`→精确码）已登记 CHANGELOG。

### 2.2 判别符 ≠ 错误码（NG12-2）

`outcome: 'replay_detected'`（`AuthStore`）、`TokenVerifyReason`、`ReplayReason` 等字符串判别符是**内部状态
判别**，服务层据此映射为 `3001` / `3003` 等统一码后对外。**错误码段位不重排、数字码不改字符串码、
不新增字符串错误码进码表**——码表保持单一进制（PRD-001 分段），杜绝 `AUTH_REFRESH_REPLAY` 之类的
双进制并存。本 PRD **零新增错误码**。

### 2.3 统一审计事件契约（OBS-06）

`audit_logs` 与 `audit_log_archives` 同构软增列 6 列（全 nullable，migration `20261017110000` 三方言 +
admin 模板；旧数据 / 旧代码零回归）：

| 列 | 语义 |
|---|---|
| `category` | 低基数大类：`auth` / `security` / `admin` / `data` / `config` / `tenant` / `system` |
| `event` | 点分事件名（`refresh.replay_detected`），细分检索键 |
| `result` | `success` / `denied` / `failed` |
| `family_id` | 令牌家族 ID（M11.1 rotation family） |
| `jti` | 令牌标识（非令牌本体，可安全落库） |
| `request_id` | 单次请求 ID（OBS-09 / W2 起填充，列先行落位） |

**字段全量落位**：`AuditService.persist` 对所有审计行写入全部契约字段（缺省 NULL）——序列化形状不随
调用方漂移（OBS-08「字段完整」的前置）。新增索引 `event` / `family_id` / `request_id` / `(category, created_at)`
（归档表用 `idx_audit_archive_*` 独立命名）。

### 2.4 replay 安全事件九要素（OBS-07）

`RefreshTokenService.handleReplay()` 的审计行统一为：

```
category='security'  event='refresh.replay_detected'  result='denied'
familyId=<familyId>  jti=<复用方令牌 jti>            requestId=<W2 起填充>
traceId=<请求上下文>  ip / userAgent=<全部调用点强制传入>  createdAt=<now>
after_value={ detail: <人读描述>, reason: <低基数结构化原因> }
```

- `traceId` 取 `getTraceId()`（修复硬编码 `null` 的唯一断链点）；无请求上下文（进程内调用）落 NULL，不抛错；
- `ReplayReason` 枚举：`not_found` / `no_replacement` / `fingerprint_mismatch` / `grace_expired` /
  `family_revoked` / `restore_failed` / `replacement_invalid`；
- **不改 M11.1 rotation 判定语义**（ADR-0020 Rule 8 组件边界不动：编排者唯一 = `RefreshTokenService`，
  `TokenService` / `AuthStore` 零改动），只补「记录什么」；
- 落库失败仍降级日志兜底、不阻塞主流程（ADR-0022 决策 7 语义保持）。

## 3. 备选与取舍

| 备选 | 否决理由 |
|---|---|
| 把错误类全仓改名 `FrameworkError`（NG12-1） | 纯叙事收益、击穿 800+ 单测与前端 `instanceof`；如需对外名，加纯别名 `export { BizError as FrameworkError }`（零行为变化） |
| 数字码改字符串码（`3001` → `AUTH_REFRESH_REPLAY`） | 段位被 PRD-001/009/010/011、前端、mock、契约文档四方引用；改基座=全仓破坏性变更，且字符串码无段位语义 |
| 安全事件建独立 `security_events` 表 | 现有 `audit_logs` 已有 `action='security'` 口径（ADR-0024 决策 4）与 admin 审计页过滤；软增列复用同一张表避免双写与两套保留策略 |
| `handleReplay` 改注入 `AuditService` | 会把 `AuditService` 拉进 `RefreshTokenService` 构造签名（破坏既有装配与测试 harness）；改为直连 `store.writeAuditLog` + 自取 `getTraceId()`，语义与 `AuditService.persist` 等价 |

## 4. 影响

- `AuditLogRecord` / `NewAuditLog` 新增 6 个必填（nullable）字段 ⇒ 所有审计写入方（`AuditService`、
  replay 编排、测试桩）显式或经默认补齐；`PrismaAuthStore` / `PrismaAuditArchiveStore` / admin-store /
  模板副本同步映射；前端与 mock 的审计类型同源补字段。
- `LogRecord` 新增顶层 `code?: number`（PRD-012 OBS-05，ADR 与本文件同批交付）：级别方法增可选
  `LogOptions`，`GlobalExceptionFilter` 不再把 `code` 内嵌 ctx。
- 后续 W2（OBS-09~OBS-14）只消费本契约：`requestId` 进 ALS / 信封 / 审计检索，`fw_auth_*` /
  `fw_security_*` 指标段按本契约的 `event` / `result` 维度聚合。
