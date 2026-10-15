# PRD-009 · 配置中心与热更新

> 里程碑：M9 ｜ 状态：**已发布 v0.4.0（2026-10-15）** ｜ 优先级：P2 ｜ 依赖：M1（`@fw/config`）、M3（审计）、M5（admin 页面模式）｜ 负责人：donttemo ｜ 更新：2026-10-15
>
> 变更记录：2026-10-15 donttemo 起草——M8 遗留 L-02（FR-08 配置中心占位未实现，见 [`docs/archive/m8/96-m8-drills.md`](../archive/m8/96-m8-drills.md) §6.4）是全项目**唯一的需求级缺口**（其余遗留 L-01/L-03/L-04 均为环境相关），按终验建议独立成 PRD 收口。范围沿用 PRD-008 §9 已结案结论：首版仅定义抽象接口与本地文件适配，不绑定 Nacos / Apollo。
> 变更记录：2026-10-15 donttemo 实现收口——独立包 `@fw/config-center`（端口 + file 适配 + 单一管道）、`@fw/config` 键注册表（`ENV_KEY_PATHS` 65 键 + `ENV_HOT_KEYS` 白名单 11 键，完整性单测防键集漂移）、四个框架服务热更入口（cache/queue/telemetry/tenant 的 `updateRuntimeOptions`）、example-api 装配（审计桥 + 订阅 + `/api/v1/configs` 两端点）、admin-web 参数配置页与变更历史、mock 同构、`smoke-config.mjs` **27/27**、`smoke-mock` 119/119。三个 Open Questions 按 §9 建议定稿（见该节决议列）。

## 1. 背景与目标

`@fw/config` 现状是**启动时静态快照**：zod 校验环境变量后生成 `ConfigService`，进程生命周期内不可变。这带来两个问题：

1. **运行时可调参数改不动**——排障时把日志级别调到 `debug`、高峰期调大缓存 TTL / 空值 TTL、收紧登录限流阈值，都得改 `.env` + 重启进程（多实例还要滚动重启）。
2. **配置变更无审计**——`.env` 是运维手工文件，谁在何时改了什么、旧值是什么，系统内无记录。

M8 终验（`docs/96` §6.4）把这项登记为 L-02 / P2 遗留，并建议以 `ConfigCenterPort` + 本地文件适配落地；PRD-008 §9 已结案「首版不绑定 Nacos / Apollo，落地项目选型后实现对应 adapter」。

**目标**：

- 白名单内的运行时参数**不重启即可生效**，生效延迟有上界；
- 每次配置变更（成功与失败）**可审计**：键、旧值 → 新值、来源、操作者、traceId；
- 为 Nacos / Apollo 预留 adapter 注册位，落地项目**只写 adapter 不改框架**。

**衡量**：验收环境改一次日志级别，不重启、在轮询间隔内生效，且审计日志可查到这条变更；反向验证（白名单外键 / 非法值被拒）全部成立。

## 2. 范围

**做**：配置中心端口（`ConfigCenterPort`）与本地文件适配、热更新白名单与单一生效管道、配置变更审计、管理端点（查 / 改）、admin-web 参数配置页与变更历史、mock 同构、冒烟 `smoke-config.mjs`。

**不做**：

- Nacos / Apollo 的具体实现（只留 adapter 注册位与 `nacos` 驱动预留枚举说明，先例：`TRANSPORT_DRIVER_VALUES` 的 tcp / kafka）；
- **敏感配置热更**——密钥、连接串、驱动、端口等进程形态配置仍走环境变量 + 重启（安全边界，见 FR-03 白名单）；
- 回滚 UI / 配置版本 diff（首版从审计历史人工恢复旧值）；
- 按租户维度的差异化配置（tenant-scoped config，登记为后续 Backlog）；
- 配置灰度发布、多环境推送、加密分发通道。

## 3. 用户故事

- 作为运维，线上排障时我不重启进程，把日志级别 `info → debug`，排完调回，全程两次配置变更都有审计。
- 作为运维，高峰期我把 `cache.ttl` / `cache.nullTtl` 调大以缓解 DB 压力，低谷调回。
- 作为安全审计员，我要能回答「上周三谁把 `auth.maxFailed` 从 5 改成了 3」，在审计日志按 `module=config` 过滤即可。
- 作为落地项目的架构师，我们选型了 Nacos，我只实现 `NacosConfigAdapter` 并注册，框架与业务代码零改动。
- 作为平台管理员，我在管理后台「系统管理 → 参数配置」页查看当前生效值并在线修改，无权用户不可见不可改。

## 4. 功能需求（FR）

| 编号 | 需求 | 说明 |
|---|---|---|
| FR-01 | 配置中心端口 | `ConfigCenterPort`：`load()` / `write(key, value, operator)` / `onChange(key, cb)` + adapter 注册位；`CONFIG_CENTER_DRIVER` 切换适配器，首版枚举仅 `file`（`nacos` 预留不入枚举，非法取值启动即失败——沿用 transport 先例） |
| FR-02 | 本地文件适配 | 运行时配置文件（默认 `./config/runtime.json`）+ **mtime 轮询**（`CONFIG_CENTER_POLL_SECONDS`，默认 5s；不用 `fs.watch`，跨平台语义不可靠）；写走**原子写**（临时文件 + rename），读失败 / 语法错误保持最后一份有效快照 |
| FR-03 | 热更新白名单 | 白名单**从 env-schema 声明式派生**（每个键标注 `hot: true/false` meta，加键时强制声明，防键集漂移）；首版白名单：`log.level`、`log.maxBytes`、`cache.ttl`、`cache.nullTtl`、`cache.ttlJitter`、`cache.slowMs`、`cache.lockTtl`、`mq.rateLimit`、`mq.concurrency`、`otel.sampleRatio`、`tenant.cacheTtl`；**boot 键（端口 / 驱动 / 连接串 / 密钥 / 开关类）一律禁改** |
| FR-04 | 复用校验 | 新值走与 env **同一份 zod 校验器**；非法值 → `400/5002`、保持旧值、审计记录失败变更（含被拒原因） |
| FR-05 | 变更审计 | 单一生效管道：**校验 → 应用 → 通知订阅者 → 审计**（同一条管道服务 API 写入与文件轮询两条入口）；审计事件含 key / old / new / source（`api` 或 `file`）/ operator（用户名或 `system`）/ traceId；审计写入失败则**变更整体失败回滚**（先审计后生效） |
| FR-06 | 管理端点 | `GET /api/v1/configs`（列表：当前值、来源、是否可热更、最近变更时间）、`PUT /api/v1/configs/:key`（白名单 + `system:config:write` 权限码）；白名单外键 → `400/5001`，键不存在 → `404/5003`；响应与 api-spec §1.5 无关（无排序分页，总量 ≤ 数十键） |
| FR-07 | 前端页面 | 系统管理 → 参数配置页：键值列表（只读列 + 可热更标记）、编辑弹窗（含新值校验错误回显）、变更历史抽屉（审计 `module=config` 过滤，展示 old → new / 来源 / 操作者 / 时间）；无 `system:config:read` 用户不可见菜单 |
| FR-08 | mock 同构 | mock 与真实后端**同白名单、同校验语义、同错误码**（`5001/5002/5003`、越权 `403/3002`）、同审计可见性——mock 放宽校验会产生「dev 全绿、真机 400」的假绿 |
| FR-09 | 变更订阅 | 各框架服务（Logger / Cache / 限流 / OTel 采样 / 租户缓存）经 `onChange` 订阅各自键，**禁止各处自行轮询**；每个订阅生效路径必须有单测（反向验证：撤掉订阅应 FAIL） |

## 5. 非功能需求（NFR）

- 热更生效延迟 ≤ 轮询间隔 + 1s（API 直写路径即时生效）。
- **fail-keep**：文件损坏 / 语法错误 / 轮询 IO 失败 → 保持最后一份有效快照 + `ERROR` 日志，进程不崩；文件恢复后自动追上。
- **读路径 fail-open，写路径 fail-closed**：启动时配置中心不可用（文件缺失）→ 按 env 快照启动 + `WARN`；任何写入失败即整体失败，不留半更新状态。
- 多实例：file 适配是**单实例语义**（多实例共享本地文件有覆盖竞态）——文档明示，多实例场景引导实现 Nacos adapter；框架不强加分布式锁。
- 新配置键三处同步（既有硬规则）：PRD + `docs/60` 部署手册 + `.env.example`；新错误码同步 `docs/40` 与 PRD-001 错误码体系。
- 可观测：配置中心轮询周期、最近一次应用变更、当前快照版本号纳入 `/ready` 之外的诊断端点或日志（不阻塞就绪判定）。

## 6. 关键设计

**配置优先级与两类键**

```
boot 键（env 独占）：APP_PORT / *_DRIVER / *_URL / 密钥 / 总开关 —— 进程形态，改 = 重启
白名单键（config center 可覆盖 env 默认值）：
  启动：load() → 全量校验（非法条目 fail-fast，与 env 非法值启动即失败同语义）→ 应用覆盖
  运行：轮询 / API → 单一管道（校验 → 应用 → 通知 → 审计）
```

**单一事实源**：运行时配置文件（管理端点经 `adapter.write()` 写文件，不另建 DB 表）——与 Nacos 模型同构（配置中心是唯一事实源 + openAPI 写入），落地项目切 Nacos 时管理端点零改动；审计仍走既有 `audit_logs`（app 侧装配 adapter 把配置事件桥接进 `@fw/auth` 审计服务，框架不反向依赖 auth）。

**新增配置键（落地时三处同步）**

| 键 | 默认 | 说明 |
|---|---|---|
| `CONFIG_CENTER_ENABLED` | `false` | 总开关，关闭时零开销（不读文件不起轮询） |
| `CONFIG_CENTER_DRIVER` | `file` | 适配器（首版枚举仅 `file`） |
| `CONFIG_CENTER_FILE` | `./config/runtime.json` | 运行时配置文件路径 |
| `CONFIG_CENTER_POLL_SECONDS` | `5` | mtime 轮询间隔 |

**新增错误码（建议 5xxx 段「配置中心」，落地时同步 `docs/40` §2 与 PRD-001）**

| 码 | 语义 |
|---|---|
| `5001` | 该配置键不可热更新（boot 键或不在白名单） |
| `5002` | 新值非法（zod 校验失败，details 带原因） |
| `5003` | 配置键不存在 |

**依赖方向**：`@fw/config`（或新子模块 `@fw/config-center`，实现时按包体量定）→ 只依赖 zod 与 node:fs；审计经 `ConfigAuditPort` 端口由 example-api 装配——沿用 `DataScopeOrgPort`（M8 T-M8-04）的端口反转先例。

## 7. 验收标准（AC）

- [x] 修改 `log.level`（经 API 与经文件两种入口）后，后续日志按新级别输出，进程未重启，生效延迟 ≤ 轮询间隔 + 1s。（`smoke-config.mjs` 阶段 B/E：demo-queue 入队的 DEBUG 日志在默认 info 级不可见、trace 阈值下出现）
- [x] 修改 boot 键（如 `db.driver`）→ `400/5001`，值不变；键不存在 → `404/5003`。（阶段 C；`@fw/config-center` 单测另有键判别三态断言）
- [x] 写入非法值（如 `log.level=verbose`）→ `400/5002`，旧值保持，审计记录一条失败变更（含拒绝原因）。（阶段 C；失败审计 `afterValue.ok=false` + `reason`）
- [x] 每次成功变更在审计日志可查（key / old / new / source / operator / traceId），且**审计失败时变更整体回滚**。（阶段 B/C；审计回滚为 `@fw/config-center` 单测「先审计后生效」用例）
- [x] 运行时配置文件被写坏（语法错误）→ 进程不崩、快照保持、`ERROR` 日志；修复文件后 ≤ 一个轮询周期自动追上。（阶段 F）
- [x] 无 `system:config:write` 的用户调用 `PUT /configs/:key` → `403/3002`；无 `system:config:read` 的用户看不到参数配置菜单。（阶段 A + seed 菜单按 `system:config:read` 挂载）
- [x] mock 与真实后端行为一致（同白名单 / 同错误码 / 审计同构），`smoke-mock` 断言通过。（119/119，含参数配置段 12 断言）
- [x] `smoke-config.mjs` 全绿（端口 3450，与既有冒烟错开），覆盖：双入口生效、三类拒绝、fail-keep、审计可见、越权面。（27/27，另含未启用形态与覆盖移除恢复 env）
- [x] 订阅生效路径有反向验证单测（撤掉订阅 / 管道通知，用例必须 FAIL 才算护栏有效）。（`config-subscriptions.spec.ts`：白名单 11 键逐一断言生效路径 + 退订用例；`@fw/config` `env-registry.test.ts` 防键集漂移）

## 8. 依赖与风险

- 依赖：M1（`@fw/config` zod schema 是校验唯一来源）、M3（审计服务与权限码模式）、M5（admin 页面 / 权限码 / mock 三同构模式）。
- 风险：**生效点散落** → 以 `onChange` 订阅集中注册 + 禁止自行轮询（lint 或评审约束），每个订阅路径单测反向验证。
- 风险：**键集漂移**（env-schema 加键、白名单没加）→ 白名单从 schema meta 派生，加键时未声明 `hot` 即单测失败。
- 风险：**file 适配多实例竞态** → 明示单实例语义，不在框架内做文件锁；多实例是 Nacos adapter 的目标场景。
- 风险：**审计与生效的一致性** → 先审计后生效、审计失败整体回滚；避免「值已变但审计丢失」的不可追溯态。

## 9. 待定问题（Open Questions）

| 问题 | 建议（待评审） | 负责人 | 结论时间 |
|---|---|---|---|
| 白名单首版范围是否含 `auth.maxFailed` / `auth.lockMinutes`？ | 倾向**不含**——登录策略属于安全基线，改策略应走有评审的重启路径；有运营诉求再纳入 | donttemo | **已定稿（2026-10-15）：不含**。白名单 11 键固定为 log/cache/mq/otel/tenant 五个运行时可调域，安全基线键单测禁入（`env-registry.test.ts` boot 键断言） |
| 放 `@fw/config` 内子模块还是独立包 `@fw/config-center`？ | 倾向独立包（沿用 queue / transport 双驱动端口先例，避免 config 包依赖面变宽）；实现时按体量终定 | donttemo | **已定稿（2026-10-15）：独立包 `@fw/config-center`**（依赖 `@fw/config` + `@fw/core` + `@fw/logger`，只依赖 zod 与 node:fs 的传递面；审计经 `ConfigAuditPort` 端口反转由应用装配） |
| 是否需要配置快照版本号与一键回滚 API？ | 首版不做（审计历史人工恢复）；若变更频率高再立项 | donttemo | **部分采纳（2026-10-15）**：快照版本号已实现（`snapshotVersion` 单调递增，纳入 `meta` 诊断与响应）；一键回滚 API 不做（审计历史人工恢复，登记后续 Backlog） |

## 10. Backlog 收口（2026-10-15，v0.4.0 后迭代）

| 项 | 结论 |
|---|---|
| 一键回滚 API | ✅ **已实现**（推翻 §9「不做」的初版结论——配置热更上线后变更频率显著高于预期，人工从审计历史恢复不现实）。`POST /api/v1/configs/rollback`（api-spec §3.10）：进程内快照历史环形表（20 版）+ 三阶段管道（全量预审计 → 持久化目标覆盖 → 逐键应用并通知）；回滚本身计入历史（再回滚 = 撤销回滚）。证据：`@fw/config-center` 单测 6 条（含审计失败 / 持久化失败整体不生效的反向验证）+ `smoke-config.mjs` 阶段 G2（35/35） |
| Nacos adapter 示例 | ✅ **已实现**（`@fw/config-center` 导出 `NacosConfigDriver`）：走 Nacos v1 HTTP Open API（不引 SDK，Node 20+ 内置 fetch），读 404 → fail-open、写 = 发布、内容 MD5 周期轮询（多实例安全，不用长轮询监听端点）、可选鉴权惰性登录、fetch 可注入测试桩。**装配方式**：落地项目在装配处实例化注入（`CONFIG_CENTER_DRIVER` 枚举仍仅 `file`，环境契约不变）；单测 9 条（fetch 桩，含自触发抑制与解析失败 fail-keep 反向验证） |
| tenant-scoped config | 📐 **设计完成，实现待排期**（见 §11 附录——半成品实现不如不出；消费端接线面大，独立排期） |

## 11. 附录：tenant-scoped config 设计草案（未实现，排期输入）

**目标**：同一热更键可按租户差异化（如 `cache.ttl` 对 acme 生效 60s、对其他租户 300s）。

**数据模型**：运行时覆盖集从「点路径 → 值」扩展为两层——全局覆盖（现状不变）+ 租户覆盖（`tenant:<id>/<点路径> → 值`，仍受同一白名单与 zod 校验约束）。事实源文件同构扩展（顶层分 `global` / `tenants` 两节，旧格式向后兼容读入）。

**生效语义**：`effective(tenantId, key)` 解析序 = 租户覆盖 → 全局覆盖 → env 快照。租户覆盖**不进**现有 11 键的全局订阅通知（避免无租户上下文的订阅者误消费）；新增 `onChangeScoped(tenantId, key)` 供感知租户的消费者订阅。

**消费端接线面（实现工作量所在）**：① `@fw/cache` 的 CacheService 需要按调用方租户解析 TTL（TenantContext 已在请求链路，键生成需带租户段）；② `@fw/queue` 的并发 / 限速是进程级资源，**不支持按租户拆分**（明确排除，文档写死）；③ `@fw/tenant` 自身的 `cacheTtl` 是租户解析缓存，按租户覆盖会造成「解析缓存的配置本身按租户」的自指，排除。**建议首版范围：仅 `cache.ttl` / `cache.nullTtl` 两键支持租户覆盖**。

**管理面**：`GET/PUT /configs/tenants/:tenantId/:key`（`system:config:write` + `system:tenant:ignore`，与 N-01 同型）；审计 `module=config`，`after` 携带 tenantId。

**风险**：覆盖组合爆炸（全局 × 租户 × env 三层）的排障复杂度 → 列表接口需带「生效来源 = tenant/global/env」标注；租户停用后其覆盖仍残留 → 随 `DELETE /tenants/:id` 级联清理。
