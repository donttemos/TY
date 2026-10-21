<!--
@file PRD-015 · 业务可读审计与运营追溯
@description M15：把审计从「技术操作记录」升级为「运营可读的业务事件」——事件注册表作为唯一语义权威、
  不可变业务快照（摘要/对象名/操作人/原因/来源）、结果四态（success/denied/failed/unknown）、
  拒绝与失败路径的采集边界、运营视图与技术详情分层、在线/归档/导出同口径、覆盖矩阵与门禁。
  需求条目基于 2026-10-20 main（7e1be4a）源码逐条核实，证据登记于 §1.2，不是 UI 美化需求。
@author donttemo
@created 2026-10-20
-->

# PRD-015 · 业务可读审计与运营追溯

> 里程碑：M15｜ 状态：**草案**（2026-10-20）｜ 优先级：P1 ｜ 依赖：M12 审计/错误/ID 契约（已交付）、M13 SaaS 领域服务（已交付）、M14 运营面与页面范式（v0.7.5 已交付）、M10 归档与任务中心（已交付）｜ 负责人：donttemo ｜ 更新：2026-10-21
>
> 来源：2026-10-20 运营体验评审意见 + 本仓 main 分支源码逐条核实（证据见 §1.2）。
>
> 与既有 PRD / ADR 的关系：
> - **ADR-0025（统一错误与审计事件契约）继续成立**：本 PRD 不改其字段语义，只在其上补「业务可读层」与写入点治理；`category` 仍为低基数粗筛键，不扩展枚举（ADR-0032 R9）。
> - **ADR-0026（requestId/traceId 分层）继续成立**：技术详情继续按该分层展示，不新增 ID 体系。
> - **ADR-0029 / ADR-0031（套餐订阅模型、租户五态）是事件的事实来源**：M15 只做「记录与解释」，不改领域规则与状态机。
> - **PRD-012 OBS-06/07/14（六字段、replay 九要素、审计检索键）已交付的能力全部复用**，本 PRD 不重做。
> - **PRD-014 的页面范式（四态 / 权限渲染 / 请求竞态守卫）为新页面基线**，沿用不回退。
> - PRD-011 非目标 **NG11-1（不接支付/账单）** 延续：本 PRD 不引入金额类事件。

## 1. 背景与目标

### 1.1 现状基线

v0.7.5 之后，审计的**机制层**已经齐备：统一 `AuditService.record()` 写入通道、`audit_logs` 单表 + 脱敏（`sanitizeForAudit`）、M12 六字段（`category` / `event` / `result` / `familyId` / `jti` / `requestId`）、traceId 串联、归档表与异步导出（任务中心 `audit.export`）、`dataScope` 四档收敛、`audit:read` / `audit:export` 权限。

缺的不是「记录能力」，而是**运营可理解性**与**事件完整性**：记录的是「谁调了哪个接口」，而不是「谁对哪个业务对象做了什么、为什么、结果如何」。因此运营人员打开审计页仍需自行翻译技术字段，高风险操作的成功/拒绝/失败也无法在同一模型中区分。

### 1.2 结构性缺口（2026-10-20 源码核实，含证据）

| # | 缺口 | 现状与证据 | 影响 |
|---|---|---|---|
| U-15-1 | **列表展示技术字段而非业务事件** | `views/system/audit-logs/index.vue:28-36` 列为「操作人/模块/动作/对象/IP/traceId/时间」；`:136-139` 动作标签直接输出 `row.action`（`create`/`update`），`:141` 对象仅 `targetType:targetId`；详情抽屉 `:153-172` 无事件名、结果、原因 | 运营看不出「改变了什么、影响了谁」，必须二次查库 |
| U-15-2 | **已有结构化字段但前端不消费** | `AuditLogRecord`（`packages/auth/src/types.ts:137-165`）含 `category`/`event`/`result`/`familyId`/`requestId`，但页面详情区一项未展示；M12 可观测建设未转化为运营体验 | 已有投入闲置；安全事件（如 `refresh.replay_detected`）在页面上与普通改密码无法区分 |
| U-15-3 | **无业务摘要 / 对象名称 / 操作原因快照** | `audit_logs` 模型（`prisma/schema.prisma:202-234`）只有 `module/action/target_type/target_id/before_value/after_value`，无 `summary`/`target_label`/`reason`；`AuditService.persist`（`audit.service.ts:129-148`）只透传调用方字段 | 用户改名、套餐改版、字典调整后，历史记录无法还原当时的业务语义；`before/after` 仍是 JSON 字段差异 |
| U-15-4 | **事件码是散落字面量，无语义权威** | `saas-ops.controller.ts:125-136` 写 `event: 'saas.plan.create'`，`:499` 拼 `saas.lifecycle.${body.action}`；`refresh-token.service.ts:358-372` 直连 `store.writeAuditLog` 写 `refresh.replay_detected`。全仓无事件目录，`event` 可任意拼写 | 无法回答「系统一共有哪些事件」；新增事件无校验，拼错即产生孤儿码；前端无法翻译 |
| U-15-5 | **成功/拒绝/失败覆盖不对称** | `audit.interceptor.ts:58-72` 只在 `tap`（成功）落审计；`rbac.guard.ts:114-122` 权限拒绝仅 `logger.warn` 后抛 403，不落审计；登录失败（`auth.service.ts:95-101` 仅计 `fw_auth_login_total`）不落审计 | 「有人改了套餐」与「有人尝试改但被拒」在审计里无法区分；越权尝试无痕迹 |
| U-15-6 | **租户维度事实上未落库** | `audit_logs.tenant_id` 列存在（`schema.prisma:204`，默认 0），但 `writeAuditLog`（`prisma-auth-store.ts:569-590`）不写该列；查询白名单（`audit.controller.ts:60-78`）无 `tenant_id` | 运营无法「按租户看这条链路」；跨租户取证只能靠 `target_id` 反推 |
| U-15-7 | **字典与真实取值漂移** | `seed.ts:301-314` `audit_action` 无 `security`（而记录层已大量使用）；`:315-330` `audit_module` 无 `saas`（M13/M14 全部 SaaS 审计 module=`saas`） | 筛选下拉选不到真实存在的模块/动作，运营按「租户」筛会漏掉 SaaS 操作 |
| U-15-8 | **导出与归档无业务列** | `audit.controller.ts:341-342` CSV 表头为 `id/createdAt/userId/module/action/targetType/targetId/ip/traceId/requestId/familyId/category/event/before/after` | 导出给合规/客服的文件仍需人工翻译；归档查询与在线查询口径虽同，但同样不可读 |

### 1.3 产品目标

| # | 目标 | 衡量口径 |
|---|---|---|
| G15-1 | **可读**：运营不理解 NestJS / 数据库字段 / 令牌轮换，也能读懂重点业务事件 | 列表首列即中文事件摘要；详情第一屏回答「谁、对什么、做了什么、为什么、结果如何」；不展开原始 JSON 即可判断 |
| G15-2 | **可追溯**：高风险操作五要素齐全且为不可变快照 | 操作人 / 目标对象（含名称快照）/ 操作原因 / 结果 / 前后变化，DB 可断言；对象改名后历史仍显示当时名称 |
| G15-3 | **可分辨**：成功、拒绝、失败、结果未知四态在同一事件模型中区分 | `result` 四态 + `audit_source`（领域记录 / 拦截器兜底）；高风险端点不存在「仅拦截器成功行」 |
| G15-4 | **可维护**：事件可枚举、可校验、可演进 | 事件注册表为唯一权威；未登记事件码在 CI 即失败；新增一个事件 = 一行定义 + 一个写入点 + 覆盖矩阵一行 |

### 1.4 非目标（不做）

- **不做防篡改 / WORM / 哈希链**：属于存储层信任边界与合规存储选型，需独立 ADR；M15 只解决可读性、完整性与口径一致。
- **不做实时告警 / SIEM 对接 / 审计大屏**：`fw_security_*` 指标与告警规则不在本 PRD 扩面。
- **不做历史数据回填或「补摘要」**：不伪造当时不存在的业务信息（ADR-0032 R8）。
- **不做审计记录的修订/删除能力**（含管理员）：审计只增不改；误记以新事件追加说明，不提供编辑入口。
- **不新建权限码**（沿用 `audit:read` / `audit:export`，避免存量环境 reseed）；不开放租户侧（tenant-facing）审计视图。
- **不引入新 UI 框架 / 图表库 / 全文检索引擎**；不做跨事件的关键词全文检索（见 OQ-15-3）。
- 不改 `BizError` 命名、不改 `TokenService`（ADR-0020 Rule 8 / NG12-6）。

## 2. 范围

### 2.1 做（五批次 · 顺序实施）

| 批次 | 优先级 | 范围 | 对应需求 | 交付目标 |
|---|---|---|---|---|
| **B1 契约与注册表** | P0 | 事件注册表、事件码规则、`recordEvent` 收口、快照列、结果四态、租户列 | FR-15-01~06 | 有「事件目录」可依，写入有唯一入口，模型能承载业务语义 |
| **B2 事件覆盖与写入点治理** | P0 | 高风险操作清单、认证/权限/生命周期/套餐订阅配额/配置运维接入、拒绝与失败边界、拦截器降级 | FR-15-07~13 | 关键业务事件「一个不漏、一个不重」，成功与拒绝可分辨 |
| **B3 运营视图** | P1 | 列表运营视图、详情业务区 + 技术折叠、筛选扩展、旧数据兼容与字典修正 | FR-15-14~17 | 运营不读 JSON 即可完成日常追溯 |
| **B4 查询 · 归档 · 导出同口径** | P1 | 在线/归档同 DTO 同解释、导出增列（追加式）、范围与脱敏不放松 | FR-15-18~20 | 冷热数据与导出文件口径一致，取证可用 |
| **B5 验证与门禁** | P0/P1 | 覆盖矩阵门禁、契约三副本、三库迁移与归档一致性测试 | FR-15-21~23 | 可回归、可 CI 守住、三库同构有证据 |

### 2.2 依赖顺序与硬规则

**B1 → B2 → B3 → B4 → B5**。硬规则：

1. **先注册后写入**：任何新事件码必须先入注册表（含名称/分类/风险/摘要模板），再有写入点；注册表外码不得进主分支。
2. **先契约后页面**：B3 只消费 B1/B2 已交付的字段与端点，禁止前端「先造一个看起来能读的页面」。
3. **每个事件三件套**：注册表条目 + 写入点（含 result 语义）+ 覆盖矩阵行，缺一不算交付。
4. 沿用 PRD-014 §2.2 的四步闭环：需求与契约 → 后端实现 → 前端实现与测试 → CI / 浏览器 / 真机验收。

### 2.3 假设条件（评审前提）

| # | 假设 | 若不成立的影响 |
|---|---|---|
| A-15-1 | 存量审计行不做回填；`before/after` 已是脱敏后快照，字段名可复用为变更明细的键 | 需额外历史数据清洗与隐私评估 |
| A-15-2 | 事件元数据（名称/说明/风险/指引）随代码发布，不做运行时热更新；文案改动不要求历史行变化 | 需事件元数据表 + 版本化存储（ADR-0032 备选 B） |
| A-15-3 | `dataScope` 四档与 `audit:read` / `audit:export` 语义不变，M15 不新增权限码 | 需 reseed + 重新登录，交付窗口变长 |
| A-15-4 | 在线表与归档表结构保持同构（E-10 不变量），增列必须双表同步 | 归档查询会出现列缺失，AC-15-06 无法成立 |
| A-15-5 | 三库（SQLite / PostgreSQL / MySQL）语义等价，不引入方言分支逻辑 | 需按方言降级，破坏「三库一致」验收 |
| A-15-6 | 时间仍按服务端 UTC 存储、前端按本地时区展示（现有行为） | 需引入时区配置项与迁移 |
| A-15-7 | 高风险操作清单以本 PRD §4 B2 冻结版本为准，新增须同批评审 | 覆盖矩阵门禁口径漂移 |
| A-15-8 | 本 PRD 基线为 `main@7e1be4a`（2026-10-20）；评审时若主线变更，§1.2 行号需重新核对 | 证据引用失效（不影响结论，但影响评审效率） |

## 3. 目标用户与场景

### 3.1 角色与诉求

| 角色 | 核心诉求 | 典型问题 |
|---|---|---|
| 平台运营人员 | 看懂「谁对哪个租户/套餐/账号做了什么、为什么、结果如何」 | 「这家租户为什么被冻结？谁操作的？恢复了吗？」 |
| 平台管理员（审计只读） | 能按人/租户/事件/结果检索并导出，但看不到也不该看到敏感值 | 「昨天有多少次越权尝试？都来自哪个账号？」 |
| 安全 / 合规取证 | 一次拉全链（审计行 ↔ 日志 ↔ 指标），要素齐全且不可变 | 「这次 replay 的 familyId、jti、IP、UA、requestId 是什么？」 |
| 框架开发者 | 新增业务事件时有明确规范与校验，不靠记忆 | 「我要加一个『配额覆盖』事件，需要改哪几处？」 |

### 3.2 关键流程（端到端）

**F1 写入（业务发生 → 审计落库）**：领域服务/控制器完成业务动作 → 调 `audit.recordEvent(code, payload)` → 注册表校验并补全 `category`/`targetType`/`summary`（未显式提供时按模板渲染）→ 从请求上下文补 `tenantId`/`requestId`/`traceId`/`ip`/`actorLabel` → 脱敏 → 异步落库（失败只告警，不阻塞业务）。

**F2 运营查询（问题 → 结论）**：运营按「时间 + 租户 + 事件分类/事件 + 结果」筛选 → 列表显示中文摘要 + 结果/风险标签 → 点击详情 → 第一屏业务区（摘要/说明/对象/原因/变更对照/指引），需要排查时展开技术详情（event/requestId/traceId/familyId/jti/IP/UA/原始快照）。

**F3 导出 / 归档追溯**：同一筛选条件 → 在线表与归档表按同一 DTO 返回、按同一注册表解释 → 异步导出 CSV（业务列追加在末尾）→ 产物可直接交客服/合规，原始字段仍在。

**F4 新增事件（开发者）**：在注册表声明（码/名称/分类/风险/摘要模板/变更字段字典）→ 在唯一写入点调用 `recordEvent` 并声明 `result` → 覆盖矩阵加一行 → CI 门禁（注册表完整性 / 未登记码 / 矩阵一致）通过 → 前端无需改代码即可展示。

## 4. 功能需求明细（FR）

优先级：P0 = M15 必交付；P1 = M15 内交付、可降档登记；P2 = 后续迭代，未评审不得提前。

### 主线 A：契约与注册表（B1 · P0）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| FR-15-01 | **事件注册表** | 在 `@fw/auth` 内新增 `AUDIT_EVENTS`（不新建包，理由见 ADR-0032 R1）：每条含 `code` / `name` / `description` / `category`（沿用 M12 七值）/ `risk`（low·notice·high·critical）/ `reviewRequired` / `guidance` / `targetType` / `summaryTemplate` / `changeFields`（字段中文名 + 枚举取值映射）/ `deprecated`；类型级唯一性与必填校验，单测锁定 | P0 |
| FR-15-02 | **事件码命名与稳定性** | 规则 `<domain>.<verb>` 或 `<domain>.<aggregate>.<verb>`（至少两段：`auth.login`、`user.create`、`saas.plan.publish`、`authz.denied`）；码一经发布不可改名，文案可改；语义废弃走 `deprecated`（保留 ≥2 个小版本，标注 `replacedBy`），不得删除条目。（B2 实施修订：原「强制三段」放宽为两段起，理由见 ADR-0032 R1 修订记录） | P0 |
| FR-15-03 | **写入入口收口** | 新增 `AuditService.recordEvent(code, payload)`：注册表校验 + 自动补全 + 摘要渲染；未登记码在测试/开发环境 fail-fast，生产降级为「原样落库 + `logger.error` + 指标/日志告警」，**绝不因审计丢业务**。`record()` 保留为低层通道并标注仅供框架内部/桥接使用 | P0 |
| FR-15-04 | **业务快照列** | `audit_logs` 与 `audit_log_archives` 同构软增列（全可空）：`summary` varchar(255)、`target_label` varchar(128)、`actor_label` varchar(64)、`reason` varchar(255)、`audit_source` varchar(16)（`domain` / `interceptor`）；三库迁移同构；长度超限截断并保留原文完整性说明（不静默丢字段） | P0 |
| FR-15-05 | **结果四态** | `result` 扩展为 `success` / `denied` / `failed` / `unknown`（现行三态 + 新增 unknown）；`unknown` 仅用于「操作已发起但未确认完成」（进程中断、异步任务超时、外部依赖结果不明）；类型、数据字典、前端标签、CSV、契约测试同步 | P0 |
| FR-15-06 | **租户维度** | 写入时从请求上下文取 `tenantId` 落库（修复现状恒 0）；查询与导出支持 `tenant_id` 过滤，但**租户范围与 `dataScope` 是两个正交维度**：普通请求强制服务端当前租户，客户端 `tenant_id` 只能同值（指定他租户 `4001`），`dataScope=all` 不解除租户边界；跨租户读取只经 `@IgnoreTenant()` + `system:tenant:ignore` 维护入口；存量 `tenant_id=0` 语义统一为「未知/存量」，页面明确标注，不回填 | P0 |

### 主线 B：事件覆盖与写入点治理（B2 · P0）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| FR-15-07 | **高风险操作清单与覆盖矩阵** | 冻结「必须审计」的操作清单（账号与权限 / 租户生命周期 / 套餐订阅配额 / 配置与运维），逐项登记：事件码、写入点文件、result 语义、目标对象、原因来源、摘要来源、是否允许拦截器兜底；产出矩阵文档（编号见 OQ-15-1）并纳入门禁 | P0 |
| FR-15-08 | **认证与权限事件** | 登录成功 / 登录失败（`denied`，含锁定、禁用、口令错误，**不记口令与令牌**）/ 登出 / 改密 / 强制下线 / 账号启用禁用 / 角色授权 / 角色权限变更 / 注册；`authz.denied` 覆盖权限拒绝与跨租户越权尝试 | P0 |
| FR-15-09 | **租户生命周期事件** | 六动作（activate/freeze/resume/terminate/expire/dispose）各自独立事件码，禁止用模板拼接掩盖语义；含 `from → to`、原因、`alreadyApplied` 幂等标记；系统任务以 `actor_type=system` 记录并生成系统原因；非法迁移（4030）记 `denied` 并保留请求的 `from/action` | P0 |
| FR-15-10 | **套餐 / 订阅 / 配额事件** | 套餐创建、版本发布（含版本号与配额项数）、订阅建立/取消（含原因）、配额覆盖调整（before/after 逐项）、配额超限（已有 4029 路径补齐对象名与摘要）、订阅到期/宽限；`target_label` 必须是套餐名/租户名而非 ID | P0 |
| FR-15-11 | **配置与运维事件** | 配置变更（补 `summary`/`reason`，保留 `source`/`ok`）、死信任务重放、审计导出行为本身（谁导出、条件摘要、行数）、维护端点调用；运维类事件风险等级默认 `notice` 以上 | P0 |
| FR-15-12 | **拒绝与失败采集边界** | 只对清单内高风险操作采集拒绝/失败：权限拒绝由守卫统一记 `authz.denied`（含所需权限码），按「操作人 + 权限码 + 分钟」去重限流防刷表；参数校验 400、资源 404、限流 429 **不落审计**（保留日志与指标），避免噪声淹没真事件。**限流丢弃可观测（2026-10-21 补）**：丢弃（`rate_limited` / `capacity`）经 `fw_auth_audit_dropped_total{path,reason}` 指标 + 每路径每 60s 一条的周期性汇总结构化日志进入运维面，回答「审计样本是否正在大量丢失」；汇总不含维度键原文（防日志放大） | P0 |
| FR-15-13 | **拦截器降级与禁止双写** | `@Audit` 拦截器降级为兜底：落库标 `audit_source=interceptor`，语义仅「HTTP 成功返回」；清单内端点必须由领域层显式记录，并同步移除/关闭其拦截器元数据，保证同一动作不产生两行；覆盖矩阵标注每个端点的记录来源 | P0 |

### 主线 C：运营视图（B3 · P1）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| FR-15-14 | **列表运营视图** | 主列改为「事件摘要 + 结果标签 + 风险标签 + 对象名称 + 操作人 + 时间」；模块/动作/IP/traceId 移为次要列（可切换「技术视图」）；结果用固定色语义（成功/拒绝/失败/未知），风险用独立标签，不与结果混色 | P1 |
| FR-15-15 | **详情分层** | 第一屏业务区：摘要、事件说明、操作人（快照名）、目标对象（名称 + 类型）、操作原因、变更对照（中文字段名 + 前后值）、处理指引、是否需复核；技术详情折叠区：`event`/`module`/`action`/`category`/`requestId`/`traceId`/`familyId`/`jti`/`ip`/`ua`/原始 `before`/`after`（脱敏后） | P1 |
| FR-15-16 | **筛选扩展** | 新增 `tenant_id`、`result`、`risk`（按事件集合展开，上限 20）、`event`（多值）；保留既有全部筛选；未知参数仍 400；筛选状态可分享（URL query）并受 PRD-014 竞态守卫约束 | P1 |
| FR-15-17 | **旧数据兼容与字典修正** | 降级链：`event` 命中注册表 → 显示名称/摘要；`event` 未登记 → 原始码 + 「未登记事件」标记；`event` 为空（存量/拦截器）→ `module.action` 字典文案 + 「历史记录（无业务摘要）」提示，**不生成摘要、不猜测原因**；`audit_action` 补 `security`、`audit_module` 补 `saas`，并登记存量环境 reseed 步骤 | P1 |

### 主线 D：查询 · 归档 · 导出同口径（B4 · P1）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| FR-15-18 | **在线与归档同口径** | `/audit-logs` 与 `/audit-archives` 共用同一 DTO、同一注册表解释、同一筛选语义（含新过滤项）；归档端点缺列/缺解释即视为缺陷；两处对同一事件返回的名称、结果标签、摘要必须逐字相同 | P1 |
| FR-15-19 | **导出增列（追加式）** | CSV 在**末尾追加** `eventName/summary/targetLabel/actorLabel/reason/result/auditSource/risk`，既有列序与位置不变（保护下游脚本与 mock 逐字节断言）；BOM/CRLF/引号转义规则不变；导出与列表同源筛选、同源范围；**公式注入防护**：单元格以 `=` `+` `-` `@` 或制表符开头时加单引号前缀（M15 安全加固，统一由 `@fw/auth` 的 `escapeCsvCell` 编码，不依赖 UI 校验） | P1 |
| FR-15-20 | **范围与脱敏不放松** | **两个维度分别收敛**：`dataScope` 归属人范围不变（`self/org/org_below/all`），租户范围由服务端强制（客户端 `tenant_id` 只能收窄，`all` 不等于跨租户）；在线列表 / 在线导出 / 归档列表 / 归档导出同一约束，详情同时校验记录 `tenantId`；跨租户只经维护入口（`/audit-logs/platform*`、`/audit-archives/platform*`，`@IgnoreTenant()` + `system:tenant:ignore`）；归档查询同样收敛；脱敏在写入侧保持，导出侧二次校验（令牌/密钥/口令类字段永不出现在任何视图与产物中） | P1 |

### 主线 E：验证与门禁（B5 · P0/P1）

| 编号 | 需求 | 说明 | 优先级 |
|---|---|---|---|
| FR-15-21 | **覆盖矩阵门禁** | 新增 `check:audit-events`：① 注册表条目字段完整、码唯一、命名合规；② 代码内 `event:` 字面量与 `recordEvent` 调用均能在注册表命中（白名单逐步收紧）；③ 矩阵中每个事件在代码中确有写入点；④ 文档清单与注册表一致。门禁失败即 CI 红 | P0 |
| FR-15-22 | **契约三副本同步** | `docs/40-api-spec.md` §3.7（+ 归档端点）、`docs/30` §3.13/§3.17、`admin-web` 类型与 mock handlers 同步；triway 七轴、api-parity、headers、helm 等既有门禁全绿；本 PRD 预计**不新增错误码**，若新增须三副本 + PRD-001 同步 | P1 |
| FR-15-23 | **三库与归档一致性测试** | SQLite / PostgreSQL / MySQL 集成用例断言新列存在、往返读写保真（含 `unknown`、中文摘要、空值）、归档迁移保留新列、导出含新列；三库语义无分支 | P0 |

## 5. 非功能需求（NFR）

| # | 需求 | 口径 |
|---|---|---|
| NFR-15-1 | 向后兼容 | 变更仅新增（列可空、字段 additive、CSV 追加）；旧客户端读旧字段行为不变；旧数据可展示且明确标注缺业务信息 |
| NFR-15-2 | 安全与权限 | 不新增权限码、不放宽 `dataScope`；脱敏字段集合不缩减；审计读取失败与越权一律 fail-closed（404 不泄露存在性） |
| NFR-15-3 | 性能 | 新增过滤必须命中索引（`tenant_id` 已有 `idx_audit_tenant`）；列表 p95 不超过改造前基线 1.2 倍；导出上限（5000 行）与分页批大小不变 |
| NFR-15-4 | 可维护性 | 注册表单源；新增事件改动面固定为「注册表 + 一个写入点 + 矩阵一行」，不得散落到前端翻译表 |
| NFR-15-5 | 可测试性 | 注册表校验、摘要渲染、结果四态、降级链、范围收敛、归档一致、导出列均有自动化用例 |
| NFR-15-6 | 前端体验 | 注册表一次拉取并缓存（带 `version` 失效），不随每次列表请求放大；未知事件不阻塞页面渲染；暗色主题与常用分辨率可用 |
| NFR-15-7 | 文档同步 | 新列 → 数据字典；新事件 → 覆盖矩阵 + `docs/45`；新端点/参数 → api-spec + mock；新文档 → README + CHANGELOG |

## 6. 关键设计（摘要）

### 6.1 事实快照 vs 解释元数据（本 PRD 的核心分层）

| 层 | 内容 | 存放 | 是否随行冻结 |
|---|---|---|---|
| **事实快照** | 摘要、对象名称、操作人名称、操作原因、结果、来源、before/after | `audit_logs` 列 | 是（不可变，改名不影响历史） |
| **解释元数据** | 事件名称、说明、风险等级、处理指引、字段中文名、枚举值翻译、分类 | 注册表（代码） | 否（随版本演进，历史行按当前字典解释） |

这条边界决定了「什么该写进库、什么不该」：**会随时间漂移的业务事实必须快照，纯展示字典不进库**（ADR-0032 R2）。

### 6.2 事件码与分类

- 码形如 `<domain>.<aggregate>.<verb>`；`domain` 由码前缀派生，**不新增 DB 列**（`category` 沿用 M12 七值做粗筛）。
- 分类筛选呈现为「认证 / 安全 / 租户 / SaaS / 配置 / 系统」六组，映射到 `domain`；`category` 仍是底层低基数键。
- 生命周期动作用独立码（`tenant.lifecycle.freeze`），禁止 `saas.lifecycle.${action}` 这类模板拼接（拼接使事件不可枚举）。

### 6.3 摘要生成链

1. **调用点显式提供**（最准确，优先）；
2. 否则用注册表 `summaryTemplate` 渲染（变量取自 `target_label` / `after` 的安全子集）；
3. 否则回退 `"{事件名称}：{对象名称或 ID}"`。

摘要只陈述**事实**（谁把什么从 A 改成 B），不写结论、因果或推测——摘要不可变，写错无法修订，过度解读会污染历史。

### 6.4 变更明细渲染

`before/after` 已是脱敏快照，**不新增 diff 列**。展示层按注册表 `changeFields` 把字段名映射为中文（如 `status` → 「状态」），枚举值映射为业务文案（`3` → 「冻结」）；未登记字段**原样显示字段名与值**（不隐藏、不猜测）。多语言/文案调整只影响展示，不改历史行。

### 6.5 结果语义（四态）

| result | 语义 | 谁写 | 前端表现 |
|---|---|---|---|
| `success` | 业务动作已完成（不是「接口返回 200」） | 领域层 | 绿色「成功」 |
| `denied` | 被权限/状态/策略拒绝，未产生业务效果 | 守卫 / 领域层 | 橙色「已拒绝」 |
| `failed` | 已尝试但失败（校验后失败、下游失败、事务回滚） | 领域层 | 红色「失败」 |
| `unknown` | 已发起、结果未确认（中断/超时/外部不确定） | 领域层 / 任务 | 灰色「结果未知」 |

`audit_source=interceptor` 的行只能表达「HTTP 成功返回」，不得作为高风险操作已完成的证据；覆盖矩阵中清单内端点必须存在 `domain` 行（ADR-0032 R5）。

### 6.6 租户维度

写入取上下文 `tenantId`。读取时**租户范围独立于 `dataScope` 收敛**（2026-10-21 P1 修正）：普通请求使用服务端验证后的当前租户（请求上下文租户 → 用户档案租户），客户端 `tenant_id` 只能同值，指定他租户 `4001`；`dataScope` 只决定归属人集合，`all` 不代表跨租户平台权限；详情同时校验记录 `tenantId`。跨租户检索只经维护入口 `/audit-logs/platform*` 与 `/audit-archives/platform*`（`@IgnoreTenant()` + `system:tenant:ignore`，守卫写豁免审计），该入口只放开租户维度、归属人范围仍按 `dataScope` 收敛。存量 0 值读作「未知/存量」，页面标注且不参与「按租户」精确筛选的默认结果（需显式勾选「含未知」），未知归属行只经维护入口可见。

### 6.7 前端兼容降级链

`event` 有且已登记 → 名称 + 摘要 + 风险；`event` 有但未登记 → 原始码 + 「未登记事件」；`event` 为空 → `module.action` 字典文案 + 「历史记录（无业务摘要）」；字典也缺失 → 原始 `module/action` 字符串。任何一层都**不得**编造业务含义。

### 6.8 写入点治理

- 清单内操作：领域层显式 `recordEvent`，并关闭该端点的拦截器元数据（防双写）。
- 清单外操作：可继续用 `@Audit` 拦截器，但必须显式接受「仅代表请求成功」的语义。
- 同一业务动作在一次请求内只允许一行审计（幂等键：`event + targetId + requestId` 由测试断言，不做 DB 唯一约束以免误伤重试）。

### 6.9 运营视图示意（结构示意，非真实数据）

```
┌ 事件摘要（主列）───────────────────────────────┬ 结果 ┬ 风险 ┬ 对象 ┬ 操作人 ┬ 时间 ┐
│ 平台管理员将租户「示例企业」的套餐由基础版调整为专业版 │ 成功 │ 注意 │ 示例企业 │ 平台管理员 │ 10-20 14:32 │
└──────────────────────────────────────────────┴──────┴──────┴──────┴────────┴──────────┘
详情第一屏：摘要 / 事件说明 / 操作人 / 对象 / 操作原因 / 变更对照（基础版 → 专业版）/ 处理指引
技术详情（折叠）：event · category · requestId · traceId · familyId · jti · IP · UA · 原始快照
```

### 6.10 导出列序（追加式）

`id,createdAt,userId,module,action,targetType,targetId,ip,traceId,requestId,familyId,category,event,before,after` **保持不变**，追加 `eventName,summary,targetLabel,actorLabel,reason,result,auditSource,risk`。追加而非插入，是为了不破坏既有下游脚本与 mock 逐字节同构断言（M12 教训：列序变更须三处同步）。

## 7. 验收标准（AC）

> **状态口径（2026-10-21 起）**：本节把**代码状态**与**证据状态**分开记——「代码已实现」不等于「验收通过」。
> - **代码**：`已实现` / `部分` / `未开始`；**证据**：`已完成` / `部分` / `待补` / `延后`。
> - 只有「代码已实现 **且** 证据已完成」才勾选 `[x]`；**未勾选不代表没写代码**，只代表证据不足以签字。
> - **证据分级**：**A** = 外部可核实的第三方记录（CI run / Actions 检查 / 入库的产物文件），评审方可自行复核；
>   **B** = 实现方本机自检输出（门禁、单测、浏览器脚本），属**实现方报告**，不等于评审方已核实；
>   **C** = 缺失。
> - 每条未勾选项必须能说出「缺哪一份证据、怎么补」，不接受「代码写了就算过」。

### 7.1 状态总览

| AC | 代码 | 证据 | 等级 | 尚需完成 |
|---|---|---|---|---|
| AC-15-01 运营可读性（列表 / 详情） | 已实现 | 已完成 | B（截图未入库） | —（mock 数据；真机多租户不属本条） |
| AC-15-02 五要素 + 名称快照 | 已实现 | 待补 | C | 真实库 SQL 断言：五要素列取值 + 改名后历史行不变 |
| AC-15-03 四态 + `audit_source` | 已实现 | 待补 | C | 端到端核验四态取值、`audit_source` 正确、清单内端点「仅拦截器成功行」为 0 |
| AC-15-04 事件码登记与门禁 | 已实现 | 已完成 | B（门禁可反向证伪） | — |
| AC-15-05 旧数据降级不伪造 | 已实现 | 已完成 | B | — |
| AC-15-06 在线 / 归档 / 导出同码同文案 | 已实现 | 待补 | C | 同一事件在三处返回的名称 / 摘要 / 结果对照断言 |
| AC-15-07 脱敏 + 四档范围不放松 | 已实现 | 部分 | A（单测级，run 104）· 新增真实库 + 双账号冒烟（待推送核实）· 真机部署 C | 归档出口的双账号核对；全视图与产物的敏感字样零命中扫描；真机部署窗口四档取证 |
| AC-15-08 三库迁移与适配 | 已实现 | 已完成 | A | —（run 100 已独立核实，见 7.2） |
| AC-15-09 租户维度 | 已实现 | 部分 | B（本机新增真实库集成 + 双租户冒烟，推送后 A） | 真机部署双账号核对（见 §7.4）；存量 0 标注截图；pg/mysql 方言矩阵未覆盖该用例 |
| AC-15-10 注册表缓存与降级 | 已实现 | 已完成 | B | — |
| AC-15-11 导出列序与同构 | 已实现 | 已完成 | B | — |
| AC-15-12 性能与容量 | 已实现 | 延后 | C | 真机 p95 ≤ 基线 1.2 倍、导出上限与产物限制、注册表下发不与列表耦合 |
| AC-15-13 覆盖矩阵逐项可验证 | 已实现 | 延后 | C | 七类事件运行期各触发一次 + 查库取证 |

### 7.2 证据来源与独立性

**已独立核实的 CI 记录（A 级）**——数据取自 GitHub 公共 API（2026-10-21 实际查询），评审方可按链接复核：

| commit | run | 结论 | 作业结果 |
|---|---|---|---|
| `dac84ca`（M15 安全加固 + 订阅单事务） | 103 · [39455559488](https://github.com/donttemos/TY/actions/runs/39455559488) | `completed` / **success** | 构建/单测(SQLite)/静态检查 ✅ · 集成 sqlite ✅ · 集成 mysql ✅ · 集成 postgres ✅ |
| `8fe98a0`（smoke 断言修复，AC-15-08 的取证 commit） | 100 · [39447355932](https://github.com/donttemos/TY/actions/runs/39447355932) | `completed` / **success** | 四腿全绿 |
| `2f710d6`（M15 P1/P2 收口：target_label 名称快照、限流丢弃观测、审计详情越权修复） | 104 · [39463134812](https://github.com/donttemos/TY/actions/runs/39463134812) | `completed` / **success** | 构建/单测(SQLite)/静态检查 ✅ · 集成 sqlite ✅ · 集成 mysql ✅ · 集成 postgres ✅ |

取数方式：`GET /repos/donttemos/TY/commits/{sha}/check-runs` → `total_count=4` 且四条均 `conclusion=success`；
`GET /repos/donttemos/TY/actions/runs?head_sha={sha}` → `total_count=1`、`conclusion=success`。

> **排障提示**：`GET /commits/{sha}/status` 是 **legacy commit status**；本仓库只产生 Actions 的 **check run**，
> 该端点对上述 commit 返回空属正常现象，据「该端点无记录」判断「没有状态检查」会误判——核对应看
> `check-runs` 或 `actions/runs?head_sha=`。

**实现方本机自检（B 级，非证据核实）**：`check:headers` / `check:api-parity` / `check:triway-consistency`（八轴）/
`check:audit-events` / `check:no-raw-throw`、`tsc --noEmit`、example-api `modules/auth` 45 例
（`vitest run --no-file-parallelism src/modules/auth` → 8 套件 45/45；默认并行下两个 SQLite 集成套件在 Windows
上偶发 `EBUSY` / hook 超时，属环境问题，非用例失败）、`@fw/auth` 相关 28 例。
这些可作为提交说明，但不构成第三方核实。

**2026-10-21 P1 修复的 CI 核实（A 级）**：审计详情 `dataScope` 越权 + 归档范围同源修复（与同批
`target_label` 名称快照、限流丢弃观测一起）已于 2026-10-21 01:05 提交为 `2f710d6` 并推送
`origin/main`；对应 run 104 四腿全绿（见上表），新增/更新单测 13 例（含两次反向变异验证）随之由
B 级升为 CI 可核实。AC-15-07 仍不勾选——真机四档取证仍缺（见 §7.3）。

**2026-10-21 P2 双租户自动化取证（新增，推送后按 run 号升 A 级）**：评审指出「租户隔离测试主要是控制器与
辅助函数层面的测试，PRD-015 仍要求在真实多租户数据下验证行集、导出产物与授权边界」。本次补两层自动化：

| 层级 | 用例 | 覆盖 | 证据形态 |
|---|---|---|---|
| 真实库集成 | `apps/example-api/src/modules/auth/audit-tenant-isolation.integration.spec.ts`（10 例，临时 SQLite 全量迁移 + 真实 `PrismaAuthStore` / `PrismaAdminStore`） | 写入侧 `tenant_id` 落库；普通出口真实行集；`tenant_id` 他租户 4001；详情双维度 404；导出产物行集；**任务重跑按 params 重建查询且期间新增他租户行不混入**；维护入口仅在 `ignoreTenant` 上下文跨租户 | vitest 真库用例（CI base 作业常驻） |
| 真实 HTTP 双账号 | `apps/example-api/scripts/smoke-tenant.mjs` 阶段 E（65/65，含 16 条审计断言） | 多租户启用下 acme 租户审计员（`dataScope=all`、无跨租户码）与 legacy 平台管理员两账号：列表行集、`tenant_id` 放行/4001、详情 404、普通导出产物不含他租户记录、维护入口跨租户检索/收窄/详情、普通账号访问维护入口 3002、平台导出跨租户 | CI base 作业的 M8 多租户冒烟（真实进程 + HTTP + seed 账号） |

配套种子新增 `tenant_auditor` 角色（audit:read/export，`dataScope=all`，**不含** `system:tenant:ignore`）与
`acmeauditor` 账号（tenantId=1），使「普通租户管理员 vs 平台维护管理员」有稳定的 A/B 对照账号。
仍**不能**由自动化替代的部分：生产部署窗口的真机取证（真实数据量、部署形态、归档出口、敏感字样产物扫描），
步骤见 §7.4；因此 AC-15-07 / AC-15-09 仍不勾选。

### 7.3 逐条明细

- [x] AC-15-01（代码 已实现 / 证据 已完成 · B）运营人员不展开原始 JSON，即可从列表与详情理解重点业务事件（摘要、对象名、原因、结果、变更对照齐备）。—— **浏览器实测 15/15 通过**（`apps/admin-web/scripts/e2e-m15-audit-view.mjs`，2026-10-20，本地 Chrome + CDP + mock）：列表主列为事件/结果/风险/对象/操作人、技术列默认收起、摘要为中文、旧行标注「历史记录」；筛选结果/风险后行内容一致；详情业务区含原因与变更对照、技术详情默认折叠（内容区 0px）展开后可见事件码/请求 ID/原始快照；导出派发成功；暗色与 1280×720 / 1920×1080 无横向溢出。证据：`apps/admin-web/e2e-artifacts/report-m15.json`（**已入库**）；截图 `m15-*.png` **仅存在于本机、未入库**，clone 后不可复核。**边界**：mock 演示数据，非真机多租户验收。
- [ ] AC-15-02（代码 已实现 / 证据 待补 · C）清单内高风险操作可追溯「操作人 / 目标对象 / 操作原因 / 结果 / 前后变化」五要素，且对象名称与操作人名称为当时快照（改名后历史不变，DB 断言）。**代码**：B1 在线/归档双表软增列（`summary` / `target_label` / `actor_label` / `reason` / `audit_source`）+ B2 `recordEvent` 写入 + 安全加固把 `actorLabel` 收敛到写入时刻集中固化 + **P1 收口（2026-10-21）把 `targetLabel` 收敛到写入时刻名称解析**：SaaS 六处写入点（套餐发布/订阅开通/取消/配额超限/生命周期迁移含非法）不再落裸 ID，经 `SaasStore.findTenantName` / `findPlanById` 取租户名/套餐名，取不到写「名称快照缺失（ID: …）」显式声明。**已有（B 级）**：`audit-events.test.ts` 四点（未传则回查固化 / 改名不改历史行 / 显式传入优先 / 用户不存在留空）+ `saas-ops.controller.spec.ts` 9 例（六处写入点名称解析与缺失标记双侧）+ saas 集成 spec 真实库 `findTenantName` 断言。**缺**：真实库（sqlite / pg / mysql）对五要素列与「改名后历史行不变」的 **SQL 断言**——内存桩与控制器级用例证明逻辑，不证明落库列与读取路径。
- [ ] AC-15-03（代码 已实现 / 证据 待补 · C）成功、拒绝、失败、结果未知四态可区分；清单内端点不存在「仅拦截器成功行」；`audit_source` 取值正确。**代码**：`result` 扩四态（类型 + 字典 + 前端标签 + CSV）；`recordEvent` 落 `domain`，`@Audit` 拦截器落 `interceptor`。**已有（B 级）**：`audit-events.test.ts`「denied / failed / unknown 必须显式声明，不被默认值吞掉」、`rbac.guard.test.ts` 与 `audit-events.test.ts` 的 `auditSource=domain` 断言。**缺**：① 四态各一条真实落库记录 + 接口/页面可见性的端到端核验；② 清单内端点逐端点确认无 `interceptor` 行（当前只证明「已移除元数据」，未做运行时普查）。
- [x] AC-15-04（代码 已实现 / 证据 已完成 · B）事件码全部登记且稳定；未登记码、码表与写入点不一致时 `check:audit-events` 失败（含反向验证：故意加未登记码，CI 必红）。—— `scripts/check-audit-events.mjs` 已接入 CI base 作业；本机实测：正常状态 `OK（32 条 / 覆盖矩阵一致）`，注入 `event: 'saas.plan.publsh'` 后 `RC=1` 并精确报 `apps/example-api/src/__audit_gate_probe.ts:7`，删除探针后恢复绿。**等级说明**：门禁在 CI 常驻，但反向证伪动作只在本地做过，故记 B。
- [x] AC-15-05（代码 已实现 / 证据 已完成 · B）旧数据可展示且不伪造：无 `event` / 未登记 / 字典缺失三种降级均有明确提示与正确回退。—— `audit-display.test.ts` 11 例锁定三级降级链（摘要 → 事件名+对象 → 原始码 → module/action 中文），详情页对旧行显示「历史记录（无业务摘要）」提示且不补写摘要。
- [ ] AC-15-06（代码 已实现 / 证据 待补 · C）在线查询、归档查询、导出三处对同一事件返回的名称、摘要、结果一致（同码同文案断言）。**代码**：三处同源——导出复用 `buildAuditCsv`、归档与在线同一 DTO（`AuditLogRecord`）、解释性文案统一由注册表现算。**缺**：同一事件经三条路径（`/audit-logs`、`/audit-archives`、CSV）返回的名称/摘要/结果**对照断言**；现有 `audit-csv.spec.ts` 只锁列与编码，不锁「三处一字不差」。
- [ ] AC-15-07（代码 已实现 / 证据 部分 · B）敏感字段持续脱敏；`self/org/org_below/all` 四档范围在列表、详情、归档、导出均不放松（越权一律 403/404）；令牌、密钥、口令不出现在任何视图与产物中。**已有（B 级）**：① 单测级四档范围——`apps/example-api/src/modules/auth/audit-detail-scope.spec.ts`（9 例：四档详情边界 + 共享库多租户正反向 + 列表⇔详情逐条等价 + `all` 仍受租户边界约束）、`audit-archive-scope.spec.ts`（5 例：在线列表/在线导出/归档列表/归档导出四端点归属人与租户条件逐个相同 + `user_id` 放大被交集挡住）、`audit-tenant-scope.spec.ts`（9 例：四出口强制当前租户 + 客户端 `tenant_id` 放大 4001 + 详情双维度 + 维护入口全局访问单独验收）；② 写入侧不落敏感值——`audit-no-secrets.test.ts`。**缺（本条仍不勾选）**：真机多账号 × 真实多租户数据的行集与可见字段核对、全视图与导出产物的 `token` / `secret` / `password` 字样零命中扫描（必须扫产物，不能只扫代码）。—— **「四档范围」的代码缺陷已于 2026-10-21 修复（P1，随 `2f710d6` 提交，run 104 四腿全绿）；同日修复第二处（P1 租户分维）**：`dataScope=all` 此前可借 `tenant_id` 参数 / 猜记录 ID 越过租户边界，现四出口与详情均独立强制服务端租户，跨租户只经 `/audit-logs/platform*`、`/audit-archives/platform*` 维护入口（新增单测 15 + 9 例，见 AC-15-09）。—— **2026-10-21 P2 补自动化**：`smoke-tenant.mjs` 阶段 E 用两个真实租户账号（acme 审计员 / legacy 平台管理员）在真实 HTTP 上验证列表行集、详情 404、普通导出产物不含他租户记录、维护入口跨租户；`audit-tenant-isolation.integration.spec.ts` 用真实 SQLite 验证真实行集与导出产物（详见 §7.2）。**仍缺**：归档出口的双账号核对、全视图与导出产物的 `token` / `secret` / `password` 字样零命中扫描、真机部署窗口的四档账号取证（§7.4）。
- [x] AC-15-08（代码 已实现 / 证据 已完成 · A）三库迁移与适配一致：三库集成用例证明新列存在、往返保真、归档保留新列。—— **独立核实**：run `100`（[39447355932](https://github.com/donttemos/TY/actions/runs/39447355932)，commit `8fe98a0`）`completed / success`，四腿（构建单测静态检查 + sqlite/postgres/mysql 集成）均 success；三份迁移 `20261020120000_add_audit_business_snapshot` 在各自方言下部署成功，集成用例覆盖新列读写。核实方式见 §7.2。
- [ ] AC-15-09（代码 已实现 / 证据 待补 · C）租户维度可用：写入 `tenant_id` 正确；**租户范围与 `dataScope` 分维收敛**（普通请求强制服务端当前租户、客户端 `tenant_id` 只能收窄、`all` 不跨租户、详情校验记录租户、跨租户只经维护入口）；存量 0 值标注「未知/存量」。**代码**：写入取请求上下文 `tenantId`（修复恒 0）；`@fw/auth` 新增 `tenant-scope.ts`（`resolveTenantScope` / `resolveTenantFilter` / `isTenantWithinScope`）与 `data-scope.ts` 分开；`/audit-logs`、`/audit-archives` 及两处导出统一注入服务端租户（客户端他租户 `4001`、导出 params 固化），详情同时校验 `tenantId`；新增维护入口 `/audit-logs/platform*`、`/audit-archives/platform*`（`@IgnoreTenant()` + `system:tenant:ignore`）。**已有（B 级）**：`audit-events.test.ts` 覆盖「租户取自上下文 / 显式优先 / 无上下文落 0」与「`result`+`tenantId` 精确过滤（可组合）」；`tenant-scope.test.ts` 15 例（来源优先级 / legacy `'0'` / 维护入口 / 收窄 4001 / 详情判定）；`audit-tenant-scope.spec.ts` 9 例（四出口强制当前租户、四出口他租户 4001、详情双维度、legacy 无边界、维护入口全局访问与「只放开租户维度」）。**缺**：真实库端到端三条——① 触发一次带租户的写入后 `select tenant_id` 断言；② 同一查询在「有 `tenant_id` 过滤」与「无过滤」下的行集差 = 该租户行；③ 前端对存量 `0` 行的「未知/存量」标注截图；④ 维护入口在真机多租户下的「平台管理员全局检索 / 普通租户 all 用户仍被拦」对照。—— **2026-10-21 P2 自动化补证（真实库 + 双账号）**：① ② ④ 见 `audit-tenant-isolation.integration.spec.ts`（真实 SQLite，10 例：写入侧 `tenant_id` 落库、真实行集、`tenant_id` 他租户 4001、详情双维度 404、导出产物、**重跑按 params 重建且不混入新增他租户行**、维护入口仅在 `ignoreTenant` 上下文跨租户且 dataScope 收敛）与 `smoke-tenant.mjs` 阶段 E（真实 HTTP 双账号 65/65，含普通导出产物不含他租户记录、平台导出跨租户）；③ 前端「未知/存量」标注仍待部署窗口截图；另：真机部署双账号核对（§7.4）与 pg/mysql 方言矩阵未覆盖该用例。
- [x] AC-15-10（代码 已实现 / 证据 已完成 · B）前端对注册表的缓存与失效生效；未知事件不阻塞渲染；注册表不可用时页面降级可用。—— `useAuditEvents` 模块级缓存 + inflight 合并 + `version` 指纹；`use-audit-events.test.ts` 3 例（并发只发一次请求、按风险取码排除 deprecated、注册表失败降级且下次重试）。
- [x] AC-15-11（代码 已实现 / 证据 已完成 · B）导出 CSV 列序为追加式、内容含业务列与原始列，mock 与实现逐字节同构，smoke 断言同步。—— `audit-csv.spec.ts` 9 例（表头 23 列且前 15 列不变、BOM/CRLF、已登记事件补事件名与风险、未登记留空、引号/换行转义、公式注入中和）；mock 与 example-api 同表头，`smoke-mock` 143/143（含 `header=true`），`smoke-admin` 表头断言同批更新。
- [ ] AC-15-12（代码 已实现 / 证据 延后 · C）性能与容量：列表带新过滤 p95 ≤ 基线 1.2 倍；导出上限与任务产物限制不变；注册表下发不随列表请求放大。**代码**：列表过滤走既有索引（`(result, created_at)` 等组合）；导出上限 `EXPORT_MAX_ROWS` 未变；注册表走独立端点 + 前端模块级缓存。**已有（B 级）**：`use-audit-events.test.ts`（并发合并，不随列表放大）；`AuditEventThrottle` 容量硬上限测试（防洪内存有界）。**⏸ 延后取证（2026-10-20 定）**：p95 需要真实数据量与生产级环境，沙箱数字不具代表性；改在**下一个迭代或真机部署窗口**执行：① 以 M14 收口值为基线，真机数据量下对比「带新过滤列表」p95 ≤ 1.2 倍；② 导出上限与产物限制断言不变；③ 以 `/metrics` 请求计数佐证注册表端点不随列表请求增长。
- [ ] AC-15-13（代码 已实现 / 证据 延后 · C）覆盖矩阵所列事件逐项可验证（至少认证、生命周期、套餐发布、订阅取消、配额覆盖、配置变更、权限拒绝七类有真实记录）。**代码**：七类均有唯一写入点，`docs/45` §7 矩阵逐条登记，B5 门禁四方对撞常驻 CI。**⏸ 延后取证（2026-10-20 定）**：「真实记录」需运行期抽样（触发动作后查库），集成测试只证明写入点存在；改在**下一个迭代或真机部署窗口**执行：按 `docs/45` §7 逐类触发一次动作并落库查询，七类各留一条 DB 查询证据。

### 7.4 真机双租户验收步骤（部署窗口执行，未完成前 AC-15-07/09 不勾选）

> 目标：在**真实部署形态 + 真实多租户数据**下，用两个真实租户账号复核对账——普通租户管理员只能看到
> 本租户审计，平台维护管理员经显式维护入口才能跨租户，导出产物与任务重跑不得丢失租户限制。
> 自动化已覆盖同类边界（§7.2），本节补的是部署形态、真实数据量与归档出口。

**前置**

1. `TENANT_ENABLED=true`（三级回退按部署配置），库为 shared 共享库且至少两个启用租户（如 `legacy` / `acme`）。
2. 账号：普通租户管理员侧用 `acmeauditor / AcmeAudit@123456`（`tenant_auditor` 角色：`audit:read` + `audit:export`，
   `dataScope=all`，**不含** `system:tenant:ignore`；本轮种子新增）；平台维护侧用 `admin / Admin@123456`
   （全量权限含 `system:tenant:ignore`）。若线上库未重播种，先在**可清场的验收环境**执行
   `pnpm --filter example-api exec tsx prisma/seed.ts`（清场重建，**禁止**对生产库执行），或按 UI 建同权角色/账号。
3. 账号登录后确认权限快照包含新码（权限码在登录快照里，改角色后需重登）。

**取证步骤（每步留命令输出 / 截图 / 产物文件）**

| # | 账号 | 动作 | 期望 |
|---|---|---|---|
| 1 | acmeauditor（`X-Tenant-Id: acme`） | `GET /api/v1/audit-logs?page=1&pageSize=50` | 200；逐行 `tenantId === '1'`（`dataScope=all` 不跨租户） |
| 2 | 同上 | `GET /api/v1/audit-logs?tenant_id=0` | `4001`（HTTP 403，显式跨租户被拒、不静默改写） |
| 3 | 同上 | 取 legacy 租户一条审计 ID 后 `GET /api/v1/audit-logs/{legacyId}` | `404/1002`（与不存在同口径，不泄露存在性） |
| 4 | 同上 | `GET /api/v1/audit-logs/export` → 轮询 `GET /api/v1/jobs/{id}/progress` → `GET /api/v1/jobs/{id}/download` | 产物 CSV 含本租户记录 ID、**不含**第 3 步 legacy ID |
| 5 | admin（`X-Tenant-Id: legacy`） | `GET /api/v1/audit-logs/platform?page=1&pageSize=100`；再 `?tenant_id=1` | 200；结果同时含 `tenantId 0/1`；收窄后全为 `1` |
| 6 | 同上 | `GET /api/v1/audit-logs/platform/{acmeRowId}`；`GET /api/v1/audit-logs/platform/export` → 下载 | 详情 200 且 `tenantId === '1'`；产物同时含 acme 与 legacy 记录 |
| 7 | acmeauditor | `GET /api/v1/audit-logs/platform`、`/audit-logs/platform/export` | `403/3002`（缺 `system:tenant:ignore`；维护入口不因租户身份放宽） |
| 8 | admin | **任务重跑**：在 `JOBS_DRIVER=db|bullmq` 部署下重放同一导出任务（失败重试或跨实例重跑），下载重跑产物 | 重跑产物行集仍只有派发时固化的租户范围，期间他租户新增审计不得混入；可查 `jobs` 表 `params` 确认 `tenantId` 固化值 |
| 9 | 浏览器 | admin 登录后打开「系统管理 → 平台审计」；acmeauditor 登录后确认**无此菜单** | 页面顶部常驻「查询范围：跨租户（平台维护入口）」横幅、租户列默认可见；普通审计页顶部为「查询范围：单租户（当前租户）」且无租户筛选；acmeauditor 菜单不可见（直输 `/system/audit-logs/platform` 落 403/404） |
| 10 | admin / acmeauditor | 普通审计详情抽屉「租户」字段 | 存量 `tenantId=0` 行显示「未知/存量」，不冒充某个租户 |

**判定**：1~10 全部符合，且产物文件与截图入库（A 级证据）后，才把 AC-15-07 / AC-15-09 的「证据」改为「已完成」并勾选。

## 8. 依赖与风险

| 风险 | 控制措施 |
|---|---|
| 覆盖矩阵遗漏导致「以为都审了」 | FR-15-21 门禁 + 评审 checklist（按 §4 B2 清单逐项签字） |
| 摘要固化后写错且不可修订 | 摘要只写事实不写结论（§6.3）；错误以新事件追加说明；评审时抽检文案 |
| 拦截器与领域层双写，运营看到两条 | FR-15-13 关闭清单内端点的拦截器元数据；`event+target+requestId` 单测断言唯一 |
| 拒绝审计被暴力破解刷表 | FR-15-12 去重限流；仅清单内事件采集拒绝；监控行数增长 |
| 新列导致在线/归档漂移 | 单一迁移同时改两表；FR-15-23 归档集成断言；数据字典同步 |
| CSV 列序/字段变更破坏下游与 mock 断言 | §6.10 追加式；实现 / mock / smoke 三处同步；推送前本机复跑 CI 同款 |
| 前端另建一份事件翻译表，与后端漂移 | 注册表只读端点下发（ADR-0032 R1）；前端无本地文案表；NFR-15-4 评审拒绝 |
| 三库方言差异（JSON/布尔/BigInt） | 只用可空字符串列 + 既有 JSON 列；不新增方言特性；CI 矩阵必跑 |
| 存量环境字典修正需 reseed | FR-15-17 登记 reseed 与重新登录步骤（沿 M13 先例） |
| 共享工作区并行会话卷入提交 | 提交范围固定，禁 `git add -A`（M13/M14 教训） |

## 9. 待定问题（Open Questions）

| # | 问题 | 负责人 | 状态 |
|---|---|---|---|
| OQ-15-1 | 覆盖矩阵文档落点：并入 `docs/45` 附录 vs 新建文档（需先核对 docs 空闲编号，防并行会话占用） | donttemo | 立项评审时核对 |
| OQ-15-2 | 摘要固化 vs 读取时渲染：默认固化（历史准确）；若评审要求「文案可回滚重渲染」需改 ADR-0032 R3 | donttemo | 待评审（默认固化） |
| OQ-15-3 | 关键词全文检索是否进 M15：三库 `LIKE` 语义与性能不一致，倾向不做，用「事件 + 对象 + 操作人」组合筛选替代 | donttemo | 待评审（默认不做） |
| OQ-15-4 | `self` 档是否允许使用租户筛选（默认忽略，避免越权放大） | donttemo | **已定案（2026-10-21 P1）**：租户筛选不是 `dataScope` 档位的开关——普通请求（含 `self`）一律由服务端强制当前租户，客户端 `tenant_id` 只能同值（他租户 `4001`），不存在「某个档位可放开租户过滤」；跨租户只经维护入口 |
| OQ-15-5 | 存量 `tenant_id=0` 的默认展示：默认不参与精确租户筛选，需勾选「含未知」 | donttemo | 待评审（默认不参与精确租户筛选）；归属维度补充（2026-10-21 P1）：`tenant_id=0` 行不属于任何普通租户，只经维护入口可读 |
| OQ-15-6 | 是否扩展 `category` 枚举（默认不扩展，domain 由事件码前缀派生） | donttemo | 待评审（默认不扩展） |
| OQ-15-7 | `authz.denied` 去重窗口与上限（默认「操作人+权限码+分钟」，单窗口 ≤3 条，超出计数合并） | donttemo | 待评审 |
| OQ-15-8 | 注册表下发形态：只读端点 + `version`（默认）vs 构建期共享常量包（会污染前端 bundle，见 ADR-0032 备选 C） | donttemo | 待评审（默认端点） |
| OQ-15-9 | 门禁强度：先 warn 一个版本再 strict，还是首个版本即 strict（默认 strict，存量白名单逐批清零） | donttemo | **已定案（2026-10-20 B5）**：首个版本即 strict——registry/写点/矩阵当前 32 条全部对得上，无需 warn 缓冲；动态事件码仅提示（当前 1 处 `LIFECYCLE_EVENTS[action]` 映射调用） |
| OQ-15-10 | 若评审要求把「完整性/采集边界」独立成第二份 ADR，则拆出 ADR-0033（本 PRD 对应关系不变） | donttemo | 待评审 |

## 10. 变更记录

| 日期 | 变更点 | 影响 |
|---|---|---|
| 2026-10-21 | **P2：平台审计前端入口 + 双租户验收自动化（评审 P2 交付）**：① **前端**——`apps/admin-web` 审计视图支持 `crossTenant` 双模式：普通审计页继续走 `/audit-logs*`（服务端强制当前租户），新增「系统管理 → 平台审计」独立入口（`/system/audit-logs/platform`，菜单权限码 `system:tenant:ignore`），走 `/audit-logs/platform*` 维护端点；页面顶部常驻「查询范围：单租户/跨租户」横幅，跨租户模式增加租户列与租户筛选，详情/导出按模式分流；缺 `system:tenant:ignore` 或 `audit:read` 时不渲染数据区（服务端守卫仍为最终防线）。普通端点行为与授权未放宽。② **验收自动化**——新增真实 SQLite 集成 `audit-tenant-isolation.integration.spec.ts`（10 例：写入 `tenant_id`、真实行集、他租户 4001、详情双维度 404、导出产物、**任务重跑按 params 重建且不混入新增他租户行**、维护入口仅 `ignoreTenant` 上下文生效）；`smoke-tenant.mjs` 新增阶段 E（真实 HTTP 双账号 65/65，acmeauditor vs admin 的列表/详情/导出/维护入口对照）；种子新增 `tenant_auditor` 角色与 `acmeauditor` 账号（tenantId=1，无跨租户码）作为稳定 A/B 账号。③ **验收口径**——AC-15-07/09 证据由「单测级 C」升为「真实库 + 双账号自动化（推送后 A 级）」，新增 §7.4 真机部署双租户验收步骤与 10 步取证清单，**仍不勾选**（生产部署窗口取证未做） | 平台运营获得显式、可审计、且不会放宽普通端点的跨租户入口；「租户隔离只有控制器桩」的证据缺口关闭；真机验收有可执行清单而非口头建议 |
| 2026-10-21 | **P1：审计租户隔离与 `dataScope` 分维（FR-15-06 / FR-15-20）**：修复「`dataScope=all` 被当作跨租户平台权限」的边界缺陷。新增 `@fw/auth` 的 `tenant-scope.ts`（`resolveTenantScope` / `resolveTenantFilter` / `isTenantWithinScope`），与 `data-scope.ts`（归属人维度）分开：普通请求强制服务端当前租户（上下文租户 → 用户档案租户，legacy `'0'` 保留），客户端 `tenant_id` 只能同值、他租户 `4001`；在线列表 / 在线导出 / 归档列表 / 归档导出四出口统一注入，导出 params 派发时固化；详情同时校验记录 `tenantId`（与「不存在」统一 404）。新增跨租户维护入口 `/audit-logs/platform*` 与 `/audit-archives/platform*`（`@IgnoreTenant()` + `system:tenant:ignore`，守卫写 `tenant_bypass` 审计），该入口只放开租户维度、归属人范围照旧收敛；全局访问行为独立于普通端点验收。模板同名控制器同步。测试：`tenant-scope.test.ts` 15 例 + `audit-tenant-scope.spec.ts` 9 例，`audit-detail-scope.spec.ts` / `audit-archive-scope.spec.ts` 同步更新（all 档改为本租户内不限归属人）。无新增错误码 / 迁移；维护入口为 additive 路由 | 共享库跨租户越权路径关闭（猜 ID / `tenant_id` 参数均不可行）；平台级跨租户检索获得显式、可审计的入口；AC-15-07/09 证据补强（真机取证仍待补，保持未勾选） |
| 2026-10-21 | **P1 加固：名称快照查询异常降级（FR-15-10）**：`saas-ops.controller.ts` 的 `tenantLabelOf` / `planLabelOf` / `subscriptionLabelOf` 名称查询补统一 try/catch——查询成功写真实名称快照；对象不存在 / 名称为空白（软删、脏引用）写 `snapshotMissingLabel(id)`；**查询抛异常（库抖动 / 连接池耗尽 / 驱动缺陷）同样降级为缺失标记且不向外抛**；`cancelSubscription` 中业务成功后的 `findSubscriptionById` 回查同口径防护。动因：名称解析调用点在业务写入成功之后（套餐已发布 / 订阅已取消 / 迁移已生效），异常透出会把已提交操作变成失败响应，客户端重试撞 `active_marker` 唯一冲突、重复取消、重复迁移；4030 / 4029 的 denial 路径还会覆盖原始业务错误——与 AuditService 审计降级同向（旁路不伤主链路）。测试：`saas-ops.controller.spec.ts` 41 例（+8 故障注入：名称查询恒抛时业务照常成功 / 原始错误原样抛出 / 审计落缺失标记），反向验证回退 try/catch → 8 例全红；saas 模块 69/69、example-api `tsc --noEmit` 零错、`check:headers` / `check:audit-events` / `check:no-raw-throw` 全绿。无新增错误码 / 迁移 / 契约变更 | 「业务已提交却返回失败」的旁路覆盖风险关闭；审计可读性不因降级回退成裸 ID |
| 2026-10-21 | **验收记录与最新提交对齐**：`2f710d6`（M15 P1/P2 收口）已推送 `origin/main`，run 104（[39463134812](https://github.com/donttemos/TY/actions/runs/39463134812)）四腿全绿；§7.1 / §7.2 / §7.3 与本节此前的「P1 修复仍在工作区未提交、不在 run 103 内」表述更新为「已提交 + A 级 CI 证据」，CHANGELOG [Unreleased] 同句同步 | 验收记录与代码 / CI 事实一致；零 AC 状态变化（AC-15-07 仍不勾选，真机取证仍缺） |
| 2026-10-21 | **P1：SaaS 审计事件 `target_label` 名称快照收口（FR-15-10）**：`saas-ops.controller.ts` 六处写入点（套餐发布 / 订阅开通 / 订阅取消 / 配额超限 4029 / 生命周期迁移成功 / 非法迁移 4030）不再把 `tenantId` / `planId` / 订阅 ID 写进 `target_label`，改为**写入时解析名称**——新增端口 `SaasStore.findTenantName`（Fake/Prisma 双实现；Prisma 侧 `tenant` 投影扩 `name` 列），套餐名经既有 `findPlanById`（与订阅列表 `enrichSubscriptions` 同口径，软删套餐不暴露名称）；订阅类事件落「租户名 · 套餐名」，任一侧缺失只标记该侧。解析不到（租户不存在 / 脏引用 / 套餐软删）时写 `snapshotMissingLabel(id)`（`@fw/auth` 新增，与展示侧 `ACTOR_SNAPSHOT_MISSING` 同文案）：「名称快照缺失（ID: …）」——绝不让 ID 冒充名称，也不静默留空让展示层回退成 `targetType:targetId`；存量裸 ID 行不回填（R8）。测试：`saas-ops.controller.spec.ts` 33 例（+9 双侧断言 + 共享 AUDIT 桩用例隔离）、`@fw/saas` 37/37、saas 集成 spec 20/20（真实库 `findTenantName`：seed `t1`→「租户一」/ 不存在→null）、`@fw/auth` 278/278、`check:audit-events` 32 事件 / 42 写入点 / 矩阵三方一致、example-api `tsc --noEmit` 零错。无新增错误码 / 迁移 / API 契约变更 | AC-15-02 的「对象名称快照」代码缺口关闭（真实库 SQL 断言仍缺，保持未勾）；运营在对象列不再看到裸租户 ID |
| 2026-10-21 | **限流丢弃观测闭环（评审 P2 交付）**：`AuditEventThrottle` 新增 `onDrop` 回调并区分 `rate_limited`（窗口超限）/ `capacity`（容量拒建桶）两种丢弃原因；登录失败（`AuthService.recordLoginFailure`）与越权拒绝（`RbacGuard`）两条真实调用路径接线到 `fw_auth_audit_dropped_total{path,reason}`（四条固定序列恒输出，含 0）与周期性汇总结构化日志（每路径每 60s 最多一条，ctx 仅低基数计数、不含维度键原文）。此前丢弃在登录路径是「直接 return、无审计行也无日志」，限流器注释声称的「结构化日志兜底」并未落实。测试：`audit-throttle-observability.test.ts` 3 例（登录限流/登录容量/越权限流三条真实路径计数可观测 + 审计样本数不变 + 汇总日志内容与基数护栏）、`auth-metrics.test.ts` +2、`audit-events.test.ts` +2；auth 包 278/278、`audit-throttle.ts` 覆盖率 100%。文档：docs/45 §4、ADR-0032 R6 与待定 #4、本节 | 运维侧首次可回答「审计样本是否正在大量丢失」；业务拒绝行为零变化 |
| 2026-10-20 | **三条 AC 延后取证登记（15-07/12/13）**：数据范围回归（15-07）、性能容量（15-12）、覆盖矩阵运行期抽样（15-13）的证据分别依赖真机多租户数据 / 真实负载 / 运行期触发，沙箱环境无法可信取证；用户决定改在下一个迭代或真机部署窗口补齐，三条保持未勾选，具体验收动作已内联到 §7 对应条目。代码与门禁状态不受影响（CI 四腿全绿，`check:audit-events` 32 条事件 CI 常驻） | 验收排期明确，杜绝「假绿」；真机窗口前不再反复本地试探 |
| 2026-10-20 | **推送与 CI 收口**：commit `0674f0a`（M15 全量，72 文件）+ `8fe98a0`（修复）。首轮 CI run `39446395221` 挂在第 15 步 C-06 冒烟——`smoke-admin` 的 `audit_module` 六项定数断言漏同步（seed/mock/smoke-mock 已改七项，后端冒烟没改）；修复后 run `39447355932` 四腿全绿（base + sqlite/postgres/mysql）。本次同时验证 `check:audit-events` 在 CI 环境（Node 22.22.2 + strip-types）正常 | AC-15-08 关闭；M15 代码全部入库 |

| 2026-10-20 | **浏览器 E2E（AC-15-01 关闭）**：新增 `scripts/e2e-m15-audit-view.mjs`（复用 M14 的 CDP 骨架，零新依赖），覆盖列表运营视图 / 结果与风险筛选 / 详情业务区与技术折叠 / 导出派发 / 暗色 / 双分辨率，15 项全过并产出 9 张截图。过程中发现并修掉两个演示数据缺陷：① mock 注册表只抄了 12 条事件（页面大半显示「未登记」）→ 改为由 `scripts/gen-audit-events-mock.mjs` 从后端注册表**生成** `mock/audit-events.ts`，门禁新增「生成物是否最新」校验；② mock 拒绝行是「登录成功 + 已拒绝」自相矛盾 → 改为语义匹配的 `auth.login_failed` | 视觉可读性有截图证据；mock 不再是手抄副本，注册表漂移由门禁拦截 |

| 2026-10-20 | **收口：模板同步（templates/admin）**：`server` 侧 12 处 `@Audit` 全部改为领域事件（用户/角色/认证），审计端点补事件注册表 `/audit-logs/events` 与 `result`/`tenant_id`/`event` 多值过滤，Prisma 存储层补租户列与五个快照列的读写与过滤，种子补 `security` 动作；`admin-web` 侧同步 `AuditLogRecord` 新字段、四态结果、`AuditQuery` 新过滤与 `fetchAuditEvents`（模板不含审计页——裁剪范围内本就无该页与菜单，无死入口）。模板无独立 node_modules，未做类型检查，采用 `tsc.transpileModule` 语法校验 + triway 七轴对撞 | 生成项目不再退回「双写 + 不可读审计」；模板审计页仍留白（按 example-api 页面为范式补齐） |

| 2026-10-20 | 立项草案：基于 main@7e1be4a 源码核实八项结构性缺口（U-15-1~8），提出 B1~B5 五批次与 23 条 FR、13 条 AC，并配套 ADR-0032（九条决策规则） | 待评审；无代码改动 |

| 2026-10-20 | **B1 契约与注册表已交付（代码）**：新增 `@fw/auth` 的 `AUDIT_EVENTS` 注册表（12 条现有事件 + `verifyAuditRegistry` 自检 + `version` 指纹）与 `AuditService.recordEvent/recordEventSync`（注册表补全 module/action/category、摘要三级生成链、`auditSource=domain`、未知码严格/降级两路径）；`AuditLogRecord` 增 5 个快照字段 + `tenantId`，`result` 增 `unknown`；在线/归档表三库同构软增列（migration `20261020120000`）；`GET /api/v1/audit-logs/events` 下发注册表；`/audit-logs` 与 `/audit-archives` 增 `result` / `tenant_id` 过滤（含非法值 400），并补上归档端点此前缺失的 M12 五个契约过滤；拦截器落库标 `audit_source=interceptor`。测试：auth 224→243、example-api 177→178、admin-web 243 全绿；`vue-tsc` 零错。**未完成**：PG/MySQL 迁移未在 CI 实跑、CSV 业务列（B4）、覆盖矩阵门禁（B5）、前端运营视图（B3） | 契约层可评审；AC-15-04/10 仅部分（门禁/前端缓存未做） |

| 2026-10-20 | **B2 事件覆盖与写入点治理已交付（代码）**：注册表扩至 31 条（认证 9 / 账号权限 7 / 租户套餐 9 / 安全配置运维 3 等）；认证服务 8 个写入点改 `recordEvent`，登录失败按错误码映射低基数原因并按（IP+账号）3 条/分钟限流；`RbacGuard` 越权拒绝落 `authz.denied`（用户+权限码限流）；生命周期动作改显式事件码映射，4030 非法迁移补 `saas.lifecycle.invalid`（先记 denial 再原样抛出）；套餐/订阅/配额/配置变更/审计导出（在线+归档）全部改用事件写入；`users`/`rbac`/`auth` 控制器 12 处 `@Audit` 全部移除（改为领域事件，消除既有双写）。覆盖矩阵落 `docs/45` §7。测试：auth 243→248、example-api 179→181 全绿 | AC-15-03 主体行为成立（无 UI 证据）；AC-15-13 七类事件均有真实写入点；模板 `templates/admin/server` 尚未同步（仍为 12 处 `@Audit`，登记为后续项） |

| 2026-10-20 | **B3 运营视图已交付（前端）**：审计页改版——列表主列「事件摘要」+ 结果/风险/对象/操作人，技术字段默认收起（列设置可开）；详情抽屉业务区优先（摘要/事件说明/操作人/对象/原因/来源/指引/需复核）+ 技术详情折叠（事件码/requestId/traceId/familyId/jti/IP/UA/原始快照）；筛选新增租户/分类/结果/风险/事件（>3 项自动折叠）；风险筛选经注册表展开为 `event=a,b`（后端新增多值过滤，≤20，交集为空返回空结果而非全量）；`CrudTable` 新增 `transformSearch` 钩子（列表与导出共用同一份条件）；`DiffViewer` 支持注册表字段中文名与枚举翻译；字典补 `security` 动作与 `saas` 模块（seed + mock + smoke 七项断言三处同改）。测试：admin-web 243→257（+14），`vue-tsc` 零错；example-api 181→182（多值解析用例） | AC-15-05 / AC-15-10 关闭；AC-15-01 代码与单测就绪，缺浏览器截图证据 |
| 2026-10-20 | **B4 导出同口径已交付**：`buildAuditCsv` 在 M12 十五列之后**追加**八个业务列（`eventName/summary/targetLabel/actorLabel/reason/result/auditSource/risk`），既有列序与位置不变；事件名与风险由注册表现算、未登记留空；在线与归档导出复用同一函数；mock 产物同表头同语义，`smoke-mock` / `smoke-admin` 两处表头断言同批更新。测试：example-api 182→187（CSV 5 例）、`smoke-mock` 143/143 | AC-15-11 关闭；下游脚本不受影响（纯追加） |
| 2026-10-20 | **B5 门禁已交付**：新增 `scripts/check-audit-events.mjs`（Node `--experimental-strip-types` 直读 TS 注册表，不生成第二份码表）：① `verifyAuditRegistry` 自检；② 生产代码 `event:` / `recordEvent('literal')` 出现未登记码即失败；③ 注册表每个未废弃条目必须有写入点（字面量出现，兼容动作→码映射表）；④ `docs/45` §7 矩阵必须逐条列出。接入 CI base 作业与 `docs/70` §1.6.8 门禁清单。覆盖矩阵生命周期行展开为完整码（原 `.freeze` 简写无法被机器校验）。反向验证：注入未登记码 → `RC=1` 且定位到文件行号；移除探针后恢复 | AC-15-04 关闭；OQ-15-9 定案 strict |
| 2026-10-20 | **安全加固（评审 P1/P2 四项）**：① CSV 单元格编码统一走 `@fw/auth` 的 `escapeCsvCell`，新增 `= + - @`/制表符前缀中和（引号转义挡不住 Excel 求值，UI 校验也挡不住导入与历史数据），mock 抽同源实现并由 triway 轴 H + 三处同组向量单测锁定；② `check:audit-events` 写入点判定收紧为「排除注册表定义文件 + 真实调用 + 服务端 `event:` + 显式 `@audit-event-map` 映射表」，逻辑抽到 `scripts/lib/audit-gate.mjs` 并新增反向测试（node:test）与 CI 步骤；③ `AuditEventThrottle` 容量成为硬上限（满则拒建桶 + 丢弃计数 + 扫描节流），新增数千不同账号容量测试；④ `AuditService.persist` 写入时刻集中补 `actorLabel` 快照，展示侧缺快照时标注「名称快照缺失（ID: …）」，不再用当前用户名回填 | AC-15-02 / G15-2 补齐（改名后历史不变）；AC-15-12 防洪内存有界；AC-15-04 门禁强度可被反向证伪 |

| 2026-10-21 | **验收状态口径拆分（代码 ≠ 证据）+ CI 独立核实**：§7 改为「代码状态 / 证据状态 / 等级」三元记账（A = 外部可核实的 CI 或入库产物；B = 实现方本机自报；C = 缺失），新增 §7.1 总览表与 §7.2 证据来源；7 条未勾选项（15-02/03/06/09/07/12/13）逐条写明「已有哪一级证据、还缺什么、怎么补」。**独立核实（A 级）**：`dac84ca` → run 103（[39455559488](https://github.com/donttemos/TY/actions/runs/39455559488)）`completed / success`，四作业均 success；`8fe98a0` → run 100（[39447355932](https://github.com/donttemos/TY/actions/runs/39447355932)）success。取数方式为 `check-runs` 与 `actions/runs?head_sha=`；**`/commits/{sha}/status` 对本仓库恒空**（legacy commit status，本仓库只产 check run），据此判「无状态检查」属端点用错。**同批的 P1 修复已提交**：审计详情 `dataScope` 越权 + 归档范围同源随 `2f710d6` 提交并推送，run 104（[39463134812](https://github.com/donttemos/TY/actions/runs/39463134812)）四腿全绿，B 级证据 13 例（含两次反向变异）升格为 CI 可核实（A 级）；因此 AC-15-07 由「延后取证」改记为「证据部分（单测级）」，**仍不勾选**（真机四档取证仍缺） | 验收记录不再把「代码已实现」当「已验收」；实现方报告与评审方核实的边界明确；本次零 AC 关闭 |

