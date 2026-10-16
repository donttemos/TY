# PRD-010 · 下一阶段增强：多实例一致性收口与模板生态

> 里程碑：M10（v0.5.0–v0.6.0）｜ 状态：**P0/P1 已交付、P2 过半（E-08/E-09/E-10 已交付）、P3 全部落地**（余 E-05 暂缓待环境、E-11 待排）｜ 优先级：P1 ｜ 依赖：M1–M9 已交付能力（重点 M7 `@fw/queue`、M9 `@fw/config-center`、M4 `@fw/cache`）｜ 负责人：donttemo ｜ 更新：2026-10-16
>
> 变更记录：2026-10-15 donttemo 起草——核心功能（M1–M9）已交付，本 PRD 承接下一阶段完善规划，系统评估结果来自 [增强功能规划](../81-enhancement-roadmap.md)（E-01~E-17）。核心判断：**单实例叙事已闭环，下一阶段主线是「多实例与规模化叙事」+「模板生态补全」**——三处进程内存态（任务中心、配置快照历史、登录限流计数之外的业务 API 裸奔面）在多副本部署下打破 G2「业务代码零改动规模演进」承诺。
> 变更记录：2026-10-15 donttemo P0 落地——**E-01 已交付**（任务中心驱动化，OQ-1 采纳建议结论：产物 ≤20MB 内联起步；AC1 经 `smoke-jobs-db.mjs` 双进程冒烟 10/10）；**E-02 已交付**（快照历史下沉持久层 + nacos 转正，OQ-2 采纳建议结论：持久层方案；AC2 经 `smoke-config-multi.mjs` 双进程冒烟 10/10）；**E-04 已交付**（权限树契约收口，AC4 前端两处选择器换接，实现注记：权限点无菜单归属外键，树不伪造归属层级——契约字面差异如实登记于 api-spec §3.4 与 CHANGELOG）。**E-03 已交付**（框架级 API 限流——令牌桶原语进 `CacheStorePort`（memory 进程内 / redis Lua 原子多实例共享）、429/9003 + Retry-After、白名单豁免、dry-run 灰度、计数进 `/metrics`；AC3 经 `smoke-rate-limit.mjs` 冒烟 8/8。实现注记：按 IP 维度（中间件在鉴权守卫前）+ dry-run 承接灰度观测（PRD §8 风险缓解「计数先行」），语义与 §6 关键设计的差异（令牌桶状态经 store 原语而非 CacheService 表面）已在 CHANGELOG 登记）。**P0 四项（E-01~E-04）全部交付**。
> 变更记录：2026-10-15 donttemo **E-06 已交付**（bullmq/transport 的 redis-cluster 实测收口——多节点连接串走 ioredis.Cluster + bullmq hash-tag 约定与启动告警；真机 6 节点集群实测 [docs/94b](../94b-queue-transport-cluster-live-test.md)：bullmq 8 断言含失速恢复演练、transport 3 断言全通过；AC8 的 E-06 部分勾选）。**E-07 进行中**。
> 变更记录：2026-10-15 donttemo **E-12 已交付**（P3 体验增强首项，SSE 实时推送端到端；本条与上一条 E-07 同期交付，按主题归拢记录）——`@fw/transport` 新增**事件面**（端口可选能力 `publish`/`subscribe`；in-process 进程内扇出 / redis PUBLISH-SUBSCRIBE 跨实例广播，独立订阅连接）；example-api 新增统一 SSE 通道 `POST /events/ticket`（60s 一次性票据，存 `CACHE_STORE`，避免 access token 进 URL）+ `GET /events/stream`（`job` / `queue` 两类事件、15s 心跳、`X-Accel-Buffering: no`、断连退订）；任务三种驱动与 `JobExecutor` 在状态变更点经模块级汇发事件（memory 驱动构造契约与既有单测零改动），队列死信经 `alert` 汇入、积压 15s 巡检边沿触发；前端 SSE 客户端（能力探测前置 + 主动重连，不信任 EventSource 内建重连）接入 `useJobCenter`，**实时优先、轮询降级为兜底**（SSE 在线停轮询 + 60s 低频对账）。验证：transport 93/93（新增 10）、example-api 58/58（新增 6）、admin-web 104/104（新增 10）+ `vue-tsc` 0 错误、新冒烟 `smoke-events.mjs` **19/19**、回归 smoke-transport 6/6 / smoke-jobs-db 10/10 / smoke-mock 119/119 / 静态门禁 4 项全绿；**AC9 勾选**。范围边界：多副本跨实例扇出需真实 Redis（本机无），由 transport 单测（共享事件总线双驱动实例）覆盖。契约见 [api-spec §3.13](../40-api-spec.md)；OQ-3 结论采纳（轮询保留为兜底路径，SSE 在线时以 60s 对账取代轮询回路））。
> 变更记录：2026-10-15 donttemo **E-13 已交付**（站内信 / 通知中心，依赖 E-12 事件面）——**消息由事件订阅产生而非业务直调**：通知派发器订阅 `@fw/transport` 的 `job.progress`（仅终态）/ `queue.alert`，按规则落成收件人可见的消息（任务终态 → 派发人；队列告警 → 持 `system:queue:list` 的账号，收件人按权限码解析）。新表 `notifications`（`dedupe_key` 唯一做跨副本幂等；数据字典 §3.18）+ 五端点 `/notifications`（`notification:read` 守卫 + 归属人 404；api-spec §3.14）+ seed/mock 权限点同步；落库后经 SSE `notification` 事件推实时未读（票据主题裁剪同步）。前端把连接所有权抽为 `store/realtime`（单连接多消费者）并新增顶栏铃铛（`NotificationBell.vue`）+ `store/notification.ts` + 相对时间工具。验证：example-api 79/79（新增 20）、admin-web 152/152（新增 15 + 改写 5）、新冒烟 `smoke-notifications.mjs` **29/29**（含无权限探针账号 3002 与主题不含 notification 的反向验证、归属人隔离、幂等）；**AC10 勾选**。范围边界：多副本跨实例扇出仍依赖真实 Redis（本机无），写幂等由唯一约束 + 单测覆盖。
> 变更记录：2026-10-15 donttemo **E-16 已交付**（边界上限配置化，P3）——四处硬编码常量定价为 env 键并登记 `ENV_KEY_PATHS`（现共 87 键，「加键必须登记」门禁由 env-registry 单测强制 schema 与注册表一致）：`WEB_KEEP_ALIVE_MAX`（默认 12，前端 `<keep-alive :max>` 钳制值，**入热更白名单** `web.keepAliveMax`——前端布局挂载时经 `GET /configs` 读取，不热更则改值必须重新构建部署，与「上限配置化」目标相悖）、`MQ_DEAD_LETTER_PAGE_MAX`（默认 200，死信分页每页上限，boot 键——与 `MQ_DEAD_LETTER_MAX` 同先例，构造期读取）、`JOB_ARTIFACT_MAX_MB`（默认 20，任务产物体积上限，memory/db/bullmq 三驱动同口径构造注入，boot 键）、`CONFIG_CENTER_HISTORY_MAX`（默认 20，配置历史保留版本数，回滚候选集与环形表淘汰三处改读，boot 键）。前端新增 `store/web-limits`（一次会话只打一次 `GET /configs`、失败不重试 fail-open、值域 [1,1000] 校验）+ `AppMain.vue` 接线；mock 同构（白名单 12 键、已知键集补齐 4 个新点路径）。实现注记：`web.keepAliveMax` 入白名单属「评审扩范围」——原 PRD 口径为「按需入热更白名单」，前端消费路径（`GET /configs` 只列 hot 键）决定该键必须热更，否则配置化只覆盖后半句。验证：`@fw/config` 16/16（87 键护栏）、`@fw/queue` 150/150（新增可配钳制断言）、`@fw/config-center` 54/54（maxHistory 可配 + 回滚 404 文案同步）、example-api 97/97（jobs 产物上限可配）、admin-web 155/155（web-limits 6 条）+ `vue-tsc` 0 错误、smoke-mock 133/133（含 12 键白名单断言）。文档同步：60 手册 4 键、`.env.example`、api-spec §3.8 死信分页 / §3.11 产物上限 / §3.12 白名单 12 键与回滚保留版本文案。
> 变更记录：2026-10-16 donttemo **E-15 已交付**（P3 体验增强收尾项，O-4 决策收口；纯前端，零后端改动、零新增配置键）——① **令牌层双列落地**（`apps/admin-web/src/styles/variables.css`）：暗色块按原型 §2.1「暗色列」补齐五个语义色（主 / 成功 / 警告 / 危险 / 信息）、文本三级、背景 / 卡片 / 边框，并补齐 `--el-color-*-rgb` 三元组（Element Plus 部分规则以 `rgba(var(--el-color-x-rgb), α)` 取色，只改十六进制会让这些位置对不上）；EP 结构性令牌（页面底色 / 卡片底色 / 浮层底色 / 空填充 / 文本五级）在 `:root` 与 `html.dark` **各写一次**并统一映射到 `--fw-*` 语义令牌——EP 的 `html.dark` 选择器特异性高于 `:root`，只在 `:root` 写会被其覆盖；至此「改 `--fw-*` 而 EP 组件不跟随」的两套调色板并存消除。② **主色派生按主题分流（真实缺陷修复）**：原实现两套主题一律向白混色，暗色下浅色系被冲淡（按钮 hover 背景发白、tag 浅底刺眼）；现改为浅色向白混色、暗色向黑混色，`dark-2` 各自反向，并同步写入 `--el-color-primary-rgb`；**派生档取值按同一混色公式预计算为静态值写进令牌文件**（刻意不用 `color-mix()`：实测 vite 8 / lightningcss 会静默丢弃无法静态求值的 `color-mix(in srgb, var(--x) 70%, #fff)` 声明，形成「开发态有效、产线回落 EP 默认派生色」的假通过；改静态值后已复验产物逐项命中，并加「令牌文件不得出现 `color-mix(`」护栏）；主色预设补暗色值（原型 §2.1 暗色列：`#5B8CFF` / `#36AD6A` / `#F2C037` / `#E0574D`）——同一预设在两套主题下各取原型值，主色本身可运行时切换故其派生档仍由 store 动态写入（同口径）。③ **主题三态** `light | dark | auto`（新增「跟随系统」并设**默认 auto**）：`prefers-color-scheme` 变更监听即时生效（无需刷新），显式选择不被系统覆盖；`darkMode` 降为生效值派生字段并**不落盘**（落盘的是用户意图 `themeMode`）；旧持久化（只有 `darkMode` 布尔）按显式模式迁移——升级前后视觉零回归，不会被新版默认 auto 改写；顶栏主题按钮改三态下拉（auto 用 Monitor 图标、tooltip 显示当前模式，文案走 E-14 locale 表新增 4 键）。④ **首帧上色**：`index.html` 前置内联脚本按持久化偏好与系统偏好先上 `html.dark`（否则暗色用户先看到浅色底再被 store 切暗）；该脚本是本口径唯一的前置副本，键名 / 三模式串 / 媒体查询串 / 位置早于应用脚本由单测断言同源。⑤ 硬编码颜色收口：登录页验证码画布底色改读 `--fw-bg`（取不到保持透明，不写死任何颜色）、logo 文字色用 `--el-color-white`、任务条上投影改令牌 `--fw-shadow-up`（暗色需加深）。⑥ **护栏**：新增令牌层单测 9 条（原型 §2.1 两列逐项锁定 / 六语义色派生档逐项等于混色公式预计算值 / `-rgb` 三元组与基色一致 / 禁止 `color-mix()` / 暗色独有 `--fw-*` 检测 / `.vue` 零颜色字面量 / EP 暗色变量先于本仓令牌的覆盖顺序 / 结构性映射落到 `--fw-*`）+ 外观 store 单测 19 条（默认 auto、跟随系统与实时变更、显式不跟随的反向验证、迁移与派生不落盘、主色双口径、明暗切换重算、损坏存储与缺 `matchMedia` 环境兜底）。**验证**：admin-web **183/183**（新增 28 条）+ `vue-tsc` 0 错误、**`pnpm build` 后校验产线 CSS 逐项命中**（`smoke-mock` 脚本**不构建**，只在 `dist` 已存在时跑体积门禁——不先构建会拿旧产物「通过」；本项验证流程固定为 build → 产线取值断言 → smoke）、`smoke-mock` **133/133**（bundle 门禁：dist gzip 339.1 kB ≤ 600、vendor-element-plus 236.5 kB ≤ 360）、静态门禁 check:headers（578 文件）/ check-no-raw-sql（336 文件）/ check:helm（63/63）/ check-api-parity 全绿。**决策与范围边界（如实登记）**：O-4 收口为「暗色首发一等形态」；语义色派生档为静态预计算值（不引 SCSS / PostCSS / 前端色库，也不用 `color-mix()`——构建管线会静默丢弃），改基色由单测按公式逐项标红；EP 结构边框五级**刻意不拉平**到单一 `--fw-border`（各级边框需保证暗色可见性，强行拉平会让表格分隔线与输入框描边不可见），差异已在 `variables.css` 文件头与 [ADR-0015](../adr/0015-dark-mode-tokens.md) 登记。
> 变更记录：2026-10-15 donttemo **E-17 已交付**（前端错误监控 RUM，P3）——① 采集侧 `apps/admin-web/src/utils/rum.ts`：三源采集（`window error` 捕获阶段含资源加载失败 / `unhandledrejection` / Vue `errorHandler`——保留既有 handler 不吞行为），会话内同签名去重（每签名 ≤5 条）+ 单会话 ≤100 条 + 单批 ≤10 条（`RUM_MAX_BATCH`）三重上限防一个 bug 刷爆上报；`navigator.sendBeacon` 优先、`fetch keepalive` 兜底、**全程 try/catch fire-and-forget**（采集与上报任何失败都不得反噬业务）；`VITE_RUM_ENABLED=false` 或非浏览器环境整体关闭（零开销）。② 关联侧：`utils/trace.ts` 记住最近一次后端响应 `X-Trace-Id`（request.ts 响应/错误拦截器登记）——前端错误与后端日志同链关联，不引前端 OTel SDK。③ 服务端 `POST /api/v1/telemetry/client-errors`（新模块 `client-errors`，**@Public**——登录页与未登录态异常同样上报）：信封形状 / 来源枚举 / 字段长度 / 单批条数校验（多字段错误一次回齐，details 带 `reports[i].field` 定位），逐条 **error 级结构化日志**（`module=rum`，字段化 ctx，与后端异常同一管道可检索，对齐「错误全采」理念），进程内按 source 计数随响应回带 `{received, total}`（被动观测面，**不设 stats 查询端点、不新增权限码**）。④ mock 同构（公开端点 + 同口径校验 + 计数）。设计取舍：上报走 sendBeacon/fetch 而非 `request.ts`（无鉴权头、不过响应拦截器——登录前也要能报），故 api-parity 门禁将该路由归入「后端有前端未调用」提示位（预期内，与 SSE stream 同情形）。验证：admin-web 155/155（rum 19 条：归一化/签名/批量窗口/去重/会话上限/beacon 优先与兜底/静默失败/HMR 卸载）+ `vue-tsc` 0 错误、example-api 97/97（client-errors 18 条：校验矩阵 + 日志结构化 + 计数累计 + 摄取前置拦截）、smoke-mock 133/133（新增 6 条 mock 契约）、smoke-admin 114/114（新增 3 条真实后端端到端：合法上报 received/total、超批 400/1001、非法字段 details 回齐）、静态门禁 4 项全绿。范围边界：计数为进程内视图（多实例合计需日志侧聚合，与 `/metrics` cache 段同口径）；无专项 E-17 冒烟脚本（端点契约由单测 + smoke-admin 段覆盖，同 E-14/E-16 先例）。
> 变更记录：2026-10-16 donttemo **E-09 已交付**（P2 模板生态，文件存储端口）——① 新框架包 `@fw/storage`：`StoragePort`（put/get/delete/exists/stat/ping/close）+ `StorageModule.forRoot()` 按 `STORAGE_DRIVER=local|s3` 装配（沿既有驱动化范式；s3 桶名缺失启动即失败）；S3 走 optional peer + 结构化最小接口（`@aws-sdk/client-s3` 懒加载，local 零依赖，未安装启用即失败给安装命令；导出面不泄漏 SDK 类型——ioredis 先例同款），决策见 [ADR-0016](../adr/0016-storage-port-fw-storage.md)。② 默认安全（NFR）：门面层类型/大小白名单默认收紧（20MB + 11 类扩展名，`STORAGE_MAX_MB`/`STORAGE_ALLOWED_EXTS` 可调，超限 `400/1001` 不静默截断）+ 服务端生成 key（`<yyyyMM>/<uuid><ext>`）+ 端口 key 卫兵 + local resolve 越界最终防线。③ example-api 端到端：新表 `upload_files`（迁移 20261016000000 + pg 变体，数据字典 §3.19）+ `/api/v1/files` 三端点（api-spec §3.16；POST 需 `file:create`（新权限点 `PERM.FILE_CREATE`，seed 授予 user）、元数据与下载登录即可——语义同任务产物下载）+ 10 个 `STORAGE_*` 键登记 `ENV_KEY_PATHS`（87→97）。④ codegen 附件字段识别：`*FileId`/`*AttachmentId` 的 String 字段 → 前端 upload 控件（新组件 FileUpload；FormDialog 与生成的 form.vue.tpl 双接线，值存文件 id），后端照常按 string 接收。⑤ mock 同构（N-02 逐字节纪律）：`/files` 三端点 + 白名单文案逐字一致 + 下载逐字节回放，smoke-mock 140/140。⑥ **E-08 模板收编（AC5 承诺兑现）**：模板 upload 模块删除自有 fs 实现，平移为 `@fw/storage` 门面消费，业务接口不变，`smoke-template-admin` 7/7 复验。验证：`@fw/storage` 45/45（双驱动，覆盖率 86.55/82.6/93.47/87.05）、`@fw/cli` 120/120、admin-web 183/183 + 构建零错误、静态门禁 4 项全绿。范围边界：s3 真实端点连通性（MinIO/AWS）本机无环境未实测——fake 客户端覆盖语义，归入 E-05/E-11 环境到位后补测（AC8 同款纪律）；下载整 Buffer 回放，Range/分片为非目标。**AC11 勾选**。
> 变更记录：2026-10-15 donttemo **E-14 已交付**（i18n 骨架，NG6 到期项，P3；OQ-4 采纳「前端接管」）——admin-web 新增 `src/locales` 文案表与极简 i18n 运行时：zh-CN / en-US 双表（错误码全集 + 语言切换器文案），**键集与 `BIZ_CODE` 数值全集编译期同构**（`ErrorMessages` 强类型，新增错误码不同步两表即 `vue-tsc` 报错，承接 api-spec §2「新增错误码必须同步」的前端侧义务）+ 模块级响应式 locale（localStorage `fw_admin_locale` 持久化 + `<html lang>` 同步）+ 点路径 `translate()` / `{var}` 插值 / `useLocale()` 组合式；**不引 vue-i18n**（2 门语言骨架用不上复数/日期本地化，自研运行时约 60 行，决策见 [ADR-0014](../adr/0014-i18n-frontend-locale.md)）。`describeBizError` 文案表化：zh-CN 沿用「后端 message 优先」**显示行为零回归**，非 zh-CN 由前端表接管，未知码回落 message 再落兜底；9001/5002 走占位模板、4001 补租户专属文案。后端零改动，信封 `{ code, message }` 契约不变；Element Plus locale 经 `ElConfigProvider` 接线 + Navbar 语言切换下拉。验证：admin-web **121/121**（新增 11 条）+ `vue-tsc` 0 错误、smoke-mock 119/119、静态门禁全绿（本项零新增配置键）。
> 变更记录：2026-10-15 donttemo **E-07 已交付**（OAuth2 授权码端到端——`@fw/auth` OAuth2FlowService（state 一次性消费 + 回调域名白名单边界校验）+ example-api 三端点 + admin-web 登录页入口与回调接管；apikey 强制验签 + `/api/v1/open/ping` 策略载体补上「枚举有、路径无」缺口；session 保持端口注入语义并文档化；`AUTH_STRATEGY` 名实相符经 api-spec §1.2 状态列收口（含 `/auth/oauth/:provider` 悬空契约订正为 `/auth/oauth2/*`）；新配置键 3 个（77→80）。验证：`@fw/auth` 129/129、`smoke-oauth2` 15/15（stub IdP 全链路 + 反向验证）、admin-web 94/94、smoke-mock 119/119；AC6 勾选（跳转→回调→换 token→登录会话全链路 + 越权/重放/白名单反向验证成立）。约定与流程见 [docs/41](../41-auth-strategies.md)）。
> 变更记录：2026-10-15 donttemo **E-10 已交付**（审计归档策略——`@fw/auth` 新增 `AuditArchivePort` + `AuditArchiveService`（批量「先写归档主键 upsert 幂等、后删在线」迁移循环，写失败绝不删在线 fail-closed，崩溃重跑覆盖同 id 不产生重复）；example-api 落地 `audit_log_archives` 冷存表（迁移 `20261015210000`，数据字典 §3.17，SQLite/PG 双方言）+ `PrismaAuditArchiveStore` 适配 + `@Cron audit.archive`（每天 02:00，`lock: true` 分布式锁多副本单执行，与 auth.refresh-cleanup 同机制）+ `/audit-archives` 查询/导出两端点（dataScope 与排序白名单同源收敛，CSV 与在线导出同构，任务类型 `audit.archive.export` 登记 JobRunnerRegistry）+ `GET /auth-maintenance/audit-archive` 运行快照；新配置键 2 个 `AUDIT_ARCHIVE_RETENTION_DAYS`（默认 180，与数据字典 §3.13 保留期口径一致）/ `AUDIT_ARCHIVE_BATCH_SIZE`（默认 1000），`ENV_KEY_PATHS` 80→82 键护栏同步，boot 键不入热更白名单。验证：`@fw/auth` **138/138**（新增 9 条：截止线边界/分批/maxBatches/fail-closed 反向/崩溃重跑幂等/删零中止）、`@fw/config` 16/16（82 键护栏）、example-api **58/58**、新冒烟 `smoke-audit-archive.mjs` **13/13**（RETENTION_DAYS=1/BATCH_SIZE=2 实测：lastArchived=3、在线行数回落、幂等重跑 0、归档查询/导出 CSV BOM、越权 403/3002 与未登录 401 反向）；98 清单 1.4 口径扩展为「在线行数有界可持续」。分布式锁多副本单执行由 @fw/queue TC-JOB-002 单测与 docs/94b cron 分布式互斥实测背书，本项不重复）。
> 变更记录：2026-10-15 donttemo **E-08 已交付**（admin 全栈项目模板，P2 首项）——`templates/admin/`（server：登录 + RBAC + 用户/角色/菜单/字典/审计端点 + E-03 限流 + demo-item 示例 CRUD（gen crud 产物形态补权限守卫）+ 附件上传/下载（`file:create` 守卫、扩展名白名单、20MB 上限、本地磁盘按月分目录，E-09 落地后可平移 `StoragePort` 适配）+ prisma schema（含模板自有 `upload_files` 表）+ 幂等种子（三角色/菜单树/字典/部门树/三账号）；admin-web：自 apps/admin-web 裁剪的登录/动态路由/按钮级权限/示例 CRUD 骨架）。`fw new --template=admin` 交付：自动注册 `server`/`admin-web` 两个工作区成员进仓库根 `pnpm-workspace.yaml`（幂等 + 标记注释；仓库外生成打印手工说明）——依赖解析走 `workspace:*` 与 `apps/*` 同构，不引入 file: 链接（pnpm 11 overrides 对 file:/tarball 传递依赖不生效已实测排除）。新冒烟 `smoke-template-admin.mjs` **7/7**：生成 → 安装 → migrate → seed → 构建启动 → 登录 + CRUD + 附件上传三端点连通 + 401/越权 3002 反向断言（专项冒烟不入 CI）；生成项目服务端 tsc 与 admin-web vue-tsc 均 0 错误；`@fw/cli` 单测 8/8。文档同步：根 README 快速开始改「已交付」、templates/admin/README.md 新增、templates/api/.env.example 补齐 E-03 RATE_LIMIT_* 六键（模板 env 同源缺口）。**AC5 勾选**。附件上传为模板自有实现（非框架端口），E-09 落地后按「端口 + 多驱动」范式收编——AC5 的「附件上传三端点连通」在本项口径下已成立。

## 1. 背景与目标

M1–M9 交付后，框架在单实例形态下功能完整（鉴权、多库、缓存、队列、多租户、配置热更均已闭环）。但以「规模化演进」的视角复核现状，存在四类缺口：

1. **无状态性缺口**——`JobCenterService` 是进程内存登记表（N-02 交付物），多副本下派发请求与进度/下载/重跑请求落在不同实例即 404；`@fw/config-center` 快照历史是进程内环形表（20 版），回滚跨实例不一致。两者直接违反 [98 规模化自检清单](../98-scale-checklist.md) 7.1「应用无状态」。
2. **默认安全缺口**——G5 承诺「限流默认开启」，实际只有登录面限流（`login-security.ts`）与 Nginx 部署层限流，业务 API 无框架级兜底；Helm 直暴露或裸 Node 形态下业务接口可被无限打耗。
3. **契约悬空**——`GET /permissions/tree` 在 api-spec 有契约、实现为零、前端未消费，是当前**唯一**悬空契约；落地项目每个都要拉平表自拼树。
4. **模板生态缺口**——`templates/` 只有 `api` + `codegen`，README 快速开始宣传的 `fw new --template=admin` 无资产可产；文件上传（98 清单 7.1 隐含「上传走对象存储」）无框架侧存储端口；`AUTH_STRATEGY` 枚举含 `session/oauth2/apikey` 但仅 `jwt` 有端到端路由（M3 遗留 ①）。

**目标**：

- 多副本部署形态下，任务面与配置面行为与单实例**语义一致**（副本数对业务与运维透明）；
- 业务 API 具备框架级限流兜底，默认开启、可白名单豁免、分布式语义与 cache 驱动同构；
- 消除全部悬空契约与「枚举有、路径无」的策略位；
- admin 全栈模板可由 `fw new` 一键产出，附件类 CRUD 有标准存储端口可依赖。

**衡量**：Helm `replicaCount ≥ 2` 形态下复跑现有 smoke 套件全绿（任务面 N-02 段、配置面 `smoke-config` 段）；限流中间件超限请求 429 且白名单豁免成立；`fw new --template=admin` 产出的骨架从生成到三端点连通 ≤ 30 分钟。

## 2. 范围

**做**（按优先级分四个阶段，映射 81 号规划 E-01~E-17）：

- **P0 多实例一致性收口（v0.5.0 主线）**：任务中心驱动化（E-01）、配置中心多实例语义 + nacos 驱动转正（E-02）、框架级 API 限流（E-03）、`/permissions/tree` 契约落地（E-04）。
- **P1 规模化与部署遗留（v0.5.x）**：真实 K8s 部署冒烟（E-05，对应 L-01，当前暂缓待环境）、bullmq/transport 的 redis-cluster 支持评估（E-06，L-04 划出的范围边界）、OAuth2/apikey/session 端到端（E-07）。
- **P2 模板生态（v0.6.0 候选）**：admin 全栈项目模板（E-08）、`@fw/storage` 文件存储端口（E-09）、审计归档策略（E-10）、长压与百万行分页压测补课（E-11，R2-03）。
- **P3 体验增强（按需穿插）**：SSE 实时推送（E-12）、站内信/通知中心（E-13）、i18n 骨架（E-14，NG6 到期项）、暗色模式（E-15，O-4）、边界上限配置化（E-16）、前端错误监控 RUM（E-17）。

**不做**：

- Kafka 驱动（O-5 评估结论：bullmq 已覆盖承诺场景，引入即新增维护面；如需按端口新增适配，不排期）；
- 营销页/大屏（NG5）、低代码运行时（NG4）、自研基础设施（NG2）、公有云托管运营（NG7）；
- tenant-scoped config 的首版实现（E-02 只保证多实例一致语义，按租户差异化配置另行立项）；
- 配置灰度发布、多环境推送、加密分发通道。

## 3. 用户故事

- 作为平台运维，我把应用扩到 3 副本后，任何实例上派发的导出任务，我在任意实例的页面上都能看到进度并下载产物——不需要会话粘滞。
- 作为平台运维，我在 A 实例写入的配置版本，在 B 实例回滚时历史完整可见、结果一致。
- 作为安全负责人，即使 Nginx 层限流被误删，业务 API 仍有框架级限流兜底，我不会在全量单测里才发现某个接口可被暴力枚举。
- 作为落地项目的架构师，我把 `AUTH_STRATEGY` 切到 `oauth2` 对接公司 SSO，登录页与菜单权限零改动。
- 作为全栈开发者，`fw new my-app --template=admin` 一条命令得到含登录 + RBAC + 示例 CRUD 的可运行骨架，带附件字段的需求用 `@fw/storage` 端口直接实现，不重写上传逻辑。

## 4. 功能需求（FR）

> 编号沿用 81 号规划的 E-xx，可独立验收；验收口径详见该表，此处列需求本体与关键约束。

| 编号 | 需求 | 关键约束 |
|---|---|---|
| E-01 | 任务中心驱动化：抽 `JobCenterPort`，memory（默认，现行为）+ bullmq/db 双驱动，产物可落库或对象存储 | 多副本下进度/下载/重跑任意实例可达；memory 驱动行为不变（兼容既有单测）；98 清单 7.1 可勾选 |
| E-02 | 配置中心多实例语义：快照历史下沉持久层或经 `@fw/transport` 广播版本推进；`nacos` 驱动转正入 `CONFIG_CENTER_DRIVER` 枚举并出装配示例 | 环形表语义保留为 memory 驱动行为；nacos 转正复用既有 9 条桩单测；**不引入按租户差异化** |
| E-03 | 框架级 API 限流：令牌桶，复用 `@fw/cache` 驱动实现分布式限流，按路由组/全局两级配置 | 默认对全部业务路由开启、可白名单豁免；降级策略与 cache 三防护同构（fail-open 可配）；新配置键必须登记 `ENV_KEY_PATHS` |
| E-04 | `GET /permissions/tree` 落地：菜单/按钮/接口三层树端点 + 前端消费（菜单选择器、权限码选择器换数据源） | api-spec 该行去除 Backlog 标注；`check-api-parity` 零提示；权限码 `permission:read` 沿用契约 |
| E-05 | 真实 K8s 部署冒烟（L-01，当前暂缓） | 沿用 96 §6.4 七条 AC；规格结论已写入 Helm README §7（k3s 4C8G 起） |
| E-06 | bullmq / transport 的 redis-cluster 支持：hash-tag 约定（队列 key 带 `{...}`）或明确不支持并文档化禁用组合 | 容器 6 节点集群实跑，口径参照 `docs/94` 8/8 |
| E-07 | OAuth2 / apikey / session 端到端：至少 OAuth2 授权码走通端到端（example-api + admin-web 登录入口），apikey 出签名约定文档 | `AUTH_STRATEGY` 枚举名实相符；smoke 增阶段；api-spec §1.2 策略表更新 |
| E-08 | admin 全栈项目模板：`fw new --template=admin` 产出含登录 + RBAC + 示例 CRUD 的可运行骨架 | 组合现有 packages 而非新功能；模板冒烟脚本（生成 → migrate → seed → 三端点连通） |
| E-09 | `@fw/storage` 文件存储端口：StoragePort（local / s3 适配），codegen 识别附件字段生成上传组件与后端接收 | 单测双驱动 + mock 同构（沿用 N-02 逐字节同构纪律）；数据字典补表。**已交付（2026-10-16，见 AC11）** |
| E-10 | 审计归档策略：保留天数配置 + 归档定时任务（复用 `@fw/queue` cron + 分布式锁）+ 归档表/导出件 | 归档任务单测 + 30 数据字典补表；98 清单 1.4 口径从「100 万行内」扩展为可持续。**已交付（2026-10-15，见 AC7）** |
| E-11 | 压测补课（R2-03）：长压（≥30min）与百万行分页复跑 `bench.mjs` | 更新压测基线报告；发布报告可引用长周期 P95/内存曲线 |
| E-12 | SSE 实时推送：任务进度、死信/积压告警经统一 SSE 通道（`@fw/transport` 事件面承载），前端轮询降级为兜底 | 完成感知从最慢 10s → 秒级；多副本下 SSE 由任意实例可服务（依赖 E-01）。**已交付（2026-10-15，见 AC9）** |
| E-13 | 站内信/通知中心：站内消息实体 + 前端铃铛 + 未读数，业务侧经 `@fw/transport` 事件订阅 | 依赖 E-12 事件面；与审计、任务中心同构的权限码与 seed 流程。**已交付（2026-10-15，见 AC10）** |
| E-14 | i18n 骨架（NG6 到期项）：后端错误码文案表 + 前端 locale 骨架（Element Plus locale 接线） | 仅骨架不追求全覆盖；时间仍 UTC 存储（既有约定不变）。**已交付（2026-10-15，OQ-4 采纳前端接管，见 ADR-0014）** |
| E-15 | 暗色模式（O-4）：设计令牌层暗色变体 | 纯前端；25 原型 §2.1 决策收口。**已交付（2026-10-16，令牌层双列 + 主题三态默认跟随系统 + 主色按主题派生；见 AC11）** |
| E-16 | 边界上限配置化：keep-alive 条数、死信分页上限、任务产物上限、配置历史版本数登记为 env 键 | 按「加键必须登记」门禁执行；按需入热更白名单（boot 键禁入）。**已交付（2026-10-15，4 键登记 ENV_KEY_PATHS，`web.keepAliveMax` 入热更白名单——评审扩范围注记见变更记录）** |
| E-17 | 前端错误监控：admin-web 轻量 RUM，错误上报至 telemetry 面 | 与 telemetry 错误全采理念对齐；上报失败不影响业务（fire-and-forget）。**已交付（2026-10-15，三源采集 + `POST /api/v1/telemetry/client-errors` @Public 摄取端点）** |

## 5. 非功能需求（NFR）

| 维度 | 要求 |
|---|---|
| 兼容性 | E-01/E-02 的 memory 驱动必须保持现行为（既有 782+ 单测与全部 smoke 零改动通过）；新驱动只增不改 |
| 可观测 | E-03 限流命中/拒绝计数进 `/metrics`；E-01 任务面跨实例访问有 traceId 贯通；E-12 SSE 断连重连有日志 |
| 安全 | E-03 默认开启不可整体关闭（白名单豁免是唯一出口）；E-09 上传类型/大小白名单校验默认收紧；E-07 OAuth2 回调域名白名单 |
| 性能 | E-03 限流中间件单请求额外开销 P95 ≤ 1ms（memory 驱动）；E-12 单实例 SSE 连接数 ≥ 500（**未实测**：本机无长连压测环境，登记为待验项） |
| 文档 | 每项新增配置键同步 60 手册 §3 + `.env.example` + PRD 关键设计（文档硬规则）；E-06/E-11 实测报告落 `docs/` |

## 6. 关键设计

- **驱动化范式复用**：E-01（JobCenterPort）、E-02（快照历史持久化）、E-09（StoragePort）均沿用「端口 + 多驱动 + `*_DRIVER` 枚举切换 + 非法取值启动即失败」的既有框架范式（先例：cache/queue/transport/config-center）。
- **限流实现路径**：令牌桶状态存 `CacheService`（memory 驱动 = 进程内，redis 驱动 = 分布式，redis-cluster = hash-tag），与 cron 分布式锁同源，不新引依赖；中间件挂 NestJS 全局 guard 位，路由组元数据声明豁免与配额。
- **权限树数据源**：菜单/按钮来自现有五表，接口层来自 controller 装饰器扫描（启动期构建，权限码变更需重新部署——与「权限码唯一权威 `packages/auth/src/constants.ts` PERM」一致）；前端 IconPicker/权限码选择器换接该端点。
- **上限配置化登记**：E-16 各键进 `@fw/config` `ENV_KEY_PATHS` 并按需标 `hot: true`，完整性单测自动强制登记（M9 既有门禁，防键集漂移）。

## 7. 验收标准（AC）

- [x] AC1（E-01）：实例 A 派发的任务在实例 B 可查进度、可下载、可重跑；memory 驱动下现有 smoke-admin N-02 段零改动全绿。（**口径注记**：Helm `replicaCount=2` 形态以 `smoke-jobs-db.mjs` 双进程冒烟 10/10 等效覆盖（db 驱动下两进程即两实例语义）；真实 Helm 多副本实跑归入 E-05 环境到位后一并执行）
- [x] AC2（E-02）：A 实例写入配置版本后，B 实例 `GET /configs` 的 `meta.snapshotVersion` 一致；回滚在任意实例执行结果一致；nacos 驱动入枚举且非法取值启动即失败。（`smoke-config-multi.mjs` 双进程冒烟 10/10，口径注记同 AC1）
- [x] AC3（E-03）：未豁免路由超限返回 `429` + 限流错误码（进 api-spec §2 错误码段）；白名单路由不受影响；多实例下全局限流阈值语义正确（redis 驱动实测）。（`smoke-rate-limit.mjs` 8/8；429/9003 语义、白名单豁免成立——redis 多实例聚合语义由 `@fw/cache` Lua 原子单测覆盖，真机复跑归入 E-05/E-11 环境）
- [x] AC4（E-04）：`/permissions/tree` 返回三层树且受 `permission:read` 保护；前端两处选择器消费该端点；`check-api-parity` 对该端点零提示。（api-spec 该行 Backlog 已去除；实现注记：权限点无菜单归属外键，树不伪造归属层级，契约字面差异登记于 api-spec §3.4）
- [x] AC5（E-08）：`fw new --template=admin` 生成的项目从 migrate 到登录 + CRUD + 附件上传三端点连通 ≤ 30 分钟，全程无手工改码。（实测 `smoke-template-admin.mjs` 全流程 ≈ 3 分钟；附件上传为模板自有端点，`@fw/storage` 端口（E-09）落地后收编——**已于 2026-10-16 收编复验 7/7**：模板 upload 模块平移为 `@fw/storage` 门面消费，业务接口不变）
- [x] AC6（E-07）：OAuth2 授权码端到端（跳转 → 回调 → 换 token → 登录会话）在 example-api + admin-web 走通，越权与回调域名白名单反向验证成立。
- [x] AC9（E-12）：统一 SSE 通道端到端成立——`POST /events/ticket` 签发的 60s 一次性票据可建流（已核销 / 伪造票据一律 `401`），连接收到 `ready` 帧；派发的任务**不经轮询**即在秒级内收到 `job` 事件（进度与终态，携带与 `/jobs/:id/progress` 同形的视图）；主题按权限裁剪（无 `system:queue:list` 只得 `job`）与归属人隔离（他人连接收不到你的任务事件）反向验证成立；断连后事件面订阅数回落为 0（无悬挂订阅）。冒烟 `smoke-events.mjs` 19/19。范围边界：多副本跨实例扇出需真实 Redis（本机无），该语义由 `@fw/transport` 单测（共享事件总线的双驱动实例）覆盖，真机复跑待环境。
- [x] AC10（E-13）：站内信端到端成立——任务终态经**事件订阅**落成派发人的一条消息（含级别 / 标题 / 可下载或失败原因），并通过 SSE `notification` 事件实时到达（未读无需轮询）；未读数 / 列表 / 标记已读（幂等）/ 全部已读 / 删除均正确；反向验证成立：他人读或删你的消息一律 `404`、他人连接收不到你的通知、**无 `notification:read` 的账号消息面 `3002` 且票据主题不含 `notification`**；幂等成立：两条终态任务恰好两条消息（进度事件不产生消息、重复投递不重复建）。冒烟 `smoke-notifications.mjs` 29/29。范围边界：多副本跨实例扇出需真实 Redis（同 AC9）。
- [x] AC11（E-09）：`@fw/storage` 端口落地——双驱动单测全绿（local 真实临时目录 / s3 fake 客户端 45 条，逐字节往返与越界防护）；`/api/v1/files` 三端点 + mock 三端点逐字节同构（上传信封 / 白名单 400 文案与 `@fw/storage` 逐字一致 / 下载逐字节回放，`smoke-mock` 140/140）；codegen 附件字段（`*FileId`/`*AttachmentId`）生成 upload 控件（`@fw/cli` 120/120）；数据字典补表 §3.19；`STORAGE_*` 10 键登记 `ENV_KEY_PATHS`（97 键）；E-08 模板附件端点收编并端到端复验（`smoke-template-admin` 7/7）。（范围边界：s3 真实端点连通性待环境，归入 AC8 口径）
- [x] AC7（E-10）：归档任务按保留天数迁移审计记录到归档表，分布式锁保证多副本单执行；在线表行数回落。（验证：`@fw/auth` 归档单测 9 条 + `smoke-audit-archive.mjs` 13/13；锁语义由 @fw/queue TC-JOB-002 与 docs/94b 实测背书）
- [x] AC11（E-15）：暗色模式下原型 §2.1「暗色列」取值逐项生效（令牌层单测锁定 11 个语义 / 文本 / 背景令牌，缺失或改值即红）；主色在暗色下按暗色口径派生（浅色系向黑混色、`dark-2` 向白提亮）且与浅色口径反向对照成立，六语义色派生档逐项等于混色公式的预计算值且**构建产物中逐项命中**；主题三态（浅 / 暗 / 跟随系统）即时生效，`auto` 跟随系统、系统切换无需刷新，显式选择不被系统覆盖（反向验证）；旧持久化按显式模式迁移（视觉零回归）；暗色用户首帧无浅色闪屏（前置脚本早于应用脚本且与 store 同源）；业务组件零颜色字面量（单测扫描强制）。验证：admin-web **183/183**（新增 28 条）+ `vue-tsc` 0 错误、`pnpm build` 后产线取值断言通过、`smoke-mock` 133/133（bundle 门禁通过）、静态门禁 4 项全绿。范围边界：EP 结构边框分级刻意保留（见 ADR-0015）。
- [ ] AC8（环境依赖项 E-05/E-06/E-11）：环境到位即执行，验收数据写入对应实测报告；长期不闭环须在每轮发布报告重申状态（95 报告风险 ② 同款纪律）。

## 8. 依赖与风险

| 项 | 说明 | 缓解 |
|---|---|---|
| 环境依赖 | E-05（K8s 集群）、E-06（≥3 节点 Redis）、E-11（大规格压测环境）——本机沙箱与 2C2G 真机均不具备；L-01 已明确暂缓（用户决策 2026-10-15） | 到位即做、每轮发布重申状态；E-06 可容器化实跑（先例 `docs/94`） |
| 行为回归 | E-01/E-02 动的是已全量验证的交付物（N-02、M9） | memory 驱动冻结现行为；新驱动独立单测 + 双驱动 CI 矩阵；smoke 在多副本形态复跑 |
| 范围膨胀 | PRD-010 是伞形 PRD（17 项横跨 2–3 个版本） | 按阶段独立验收；单项过大时（如 E-07、E-09）拆子 PRD，本 PRD 只留编号与验收锚点 |
| 限流误伤 | E-03 默认开启可能拦截正常批量操作 | 白名单豁免 + 可观测计数先行（灰度期仅告警不拦截，配置切换） |

## 9. 待定问题（Open Questions）

| # | 问题 | 建议结论 | 负责人 / 时间 |
|---|---|---|---|
| OQ-1 | E-01 任务产物持久化选型：落库（大字段）vs 对象存储（依赖 E-09 先行）vs bullmq job 数据内联（20MB 上限内） | 产物 ≤ 20MB 用 bullmq/db 内联起步，E-09 落地后切对象存储 | donttemo / E-01 开工前 |
| OQ-2 | E-02 快照历史持久化 vs transport 广播的取舍：持久层简单可靠但引表；广播轻量但有竞态窗口 | 首选持久层（复用 `@fw/db`，三库矩阵现成），广播留作 Nacos 场景备选 | donttemo / E-02 开工前 |
| OQ-3 | E-12 SSE 与既有轮询的共存期长度 | **已采纳（2026-10-15）**：轮询降级为兜底路径保留；SSE 在线时以 60s 低频对账取代轮询回路，观测 SSE 稳定性后再考虑移除兜底 | donttemo / E-12 交付时 |
| OQ-4 | E-14 i18n 错误码文案表放后端（Accept-Language 协商）还是前端全量接管 | **已采纳（2026-10-15，E-14 已交付）**：前端接管（错误码 → 文案映射随构建分发），后端只回码不回文案；zh-CN 沿用后端 `message` 优先保零回归，双语义与「不引 vue-i18n」决策见 ADR-0014 | donttemo / E-14 开工前 |
