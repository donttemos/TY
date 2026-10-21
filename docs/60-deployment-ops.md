# 通用应用框架 · 部署与运维手册

> 版本 v0.1 ｜ 状态：已随 M8 更新 ｜ 关联：[架构设计](./20-architecture.md) 第 6 节 ｜ [验收标准](./10-acceptance-criteria.md) ｜ [三大演练](./archive/m8/96-m8-drills.md) ｜ [规模化自检清单](./98-scale-checklist.md) ｜ 更新：2026-10-14
>
> 适用：基于本框架构建的所有项目。档位选择决定操作复杂度——**小档不要求运维懂 K8s，大档不要求开发改代码**。

## 1. 环境要求

| 组件 | 小档 | 中档 | 大档 |
|---|---|---|---|
| 应用运行时 | Node 20 / 22（NestJS 11 要求 ≥ 20） | 同左 | 同左（容器镜像） |
| 包管理 | pnpm 9+ | 同左 | CI 内构建，运行时不需 |
| 数据库 | SQLite 或 MySQL 8 单实例 | MySQL 8 / PostgreSQL 15（主从） | 主从 + 读写分离 |
| 缓存 | 进程内 memory | Redis 7（哨兵可选） | Redis Cluster |
| 队列 | 进程内 | BullMQ + Redis | Kafka（M8） |
| 编排 | Docker | docker-compose | Helm / K8s |
| 建议资源 | 1C2G × 1 | 2C4G × 2–3 | 按 HPA 弹性 |

## 2. 档位选择

| 判断项 | 小 | 中 | 大 |
|---|---|---|---|
| 日活 | < 1k | 1k–10w | > 10w |
| 可用性要求 | 可接受分钟级中断 | 99.9% | 99.95%+ |
| 实例数 | 1 | 2–3（无状态） | 弹性 |
| 是否多租户 | 否 | 可选 | 是 |
| 运维人力 | 无专职 | 兼职 | 专职 |

原则：**先小档起步**；出现下列信号再升档——单机 CPU 长期 > 60%、需要零停机发布、出现多租户或强合规要求、团队边界清晰需拆服务。

## 3. 配置清单

> 完整 `.env` 由模板提供（`.env.example`），以下为关键项；**缺失必填项时服务启动即失败并打印项名**。

| 分类 | 键 | 必填 | 默认 | 说明 |
|---|---|---|---|---|
| 应用 | `APP_ENV` | 是 | — | `dev` / `test` / `prod` |
| | `APP_PORT` | 否 | 3000 | 监听端口 |
| 数据库 | `DB_DRIVER` | 是 | — | `mysql` / `postgres` / `sqlite` |
| | `DB_URL` | 是 | — | 连接串；`sqlite` 时为文件路径 |
| | `DB_POOL_MAX` | 否 | 10 | 连接池上限 |
| | `DB_SLOW_MS` | 否 | 500 | 慢查询阈值 |
| 缓存 | `CACHE_DRIVER` | 是 | — | `memory` / `redis` / `redis-cluster` |
| | `CACHE_URL` | 条件 | — | redis / redis-cluster 驱动必填；cluster 为逗号分隔节点列表 |
| | `CACHE_PREFIX` | 否 | `fw:<APP_ENV>` | key 全局前缀，避免多应用/多环境串数据 |
| | `CACHE_TTL` | 否 | 300 | 默认 TTL（秒） |
| | `CACHE_MAX_ITEMS` | 否 | 10000 | memory 驱动 LRU 容量上限 |
| | `CACHE_FAIL_OPEN` | 否 | true | 依赖故障降级直查；false 时抛 9002 |
| | `CACHE_NULL_TTL` | 否 | 60 | 空值占位 TTL（秒），防穿透 |
| | `CACHE_TTL_JITTER` | 否 | 0.1 | TTL 随机抖动比例，防雪崩 |
| | `CACHE_LOCK_TTL` | 否 | 30 | 分布式锁默认 TTL（秒） |
| | `CACHE_TAG_TTL` | 否 | 86400 | 标签映射 TTL（秒），防「幽灵缓存」 |
| | `CACHE_SLOW_MS` | 否 | 50 | 慢缓存操作告警阈值（毫秒） |
| | `CACHE_MAX_VALUE_BYTES` | 否 | 1048576 | 单 key 值字节上限（大 key 防护） |
| 鉴权 | `AUTH_STRATEGY` | 是 | jwt | `jwt`/`session`/`oauth2`/`apikey` |
| | `AUTH_ACCESS_TTL` | 否 | 2h | access 有效期 |
| | `AUTH_REFRESH_TTL` | 否 | 7d | refresh 有效期 |
| | `JWT_SECRET` | **是** | — | 当前签名密钥，**无默认值**（缺失则启动失败）；≥32 位强随机 |
| | `JWT_SECRET_PREV` | 否 | — | 轮换过渡期旧密钥，须与 `JWT_SECRET` 不同 |
| | `AUTH_MAX_FAILED` | 否 | 5 | 连续失败锁定阈值 |
| | `AUTH_LOCK_MINUTES` | 否 | 15 | 锁定时长 |
| | `AUTH_REFRESH_GRACE_SECONDS` | 否 | 10 | refresh 并发宽限窗口（秒）；超出即判泄漏并撤销整族 |
| | `AUTH_FINGERPRINT` | 否 | on | grace 重试客户端指纹绑定（ADR-0022）：轮换写入赢家 UA 指纹（SHA-256，IP 不参与），重试方不匹配判泄漏并族撤销；`off` 只关闭「新轮换写指纹」（已有指纹行仍按指纹比对，**多节点部署须保持一致**，见 ADR-0022 后续勘误） |
| | `AUTH_PASSWORD_POLICY` | 否 | medium | 密码强度策略：`low` / `medium` / `high` |
| | `AUTH_ALLOW_REGISTER` | 否 | false | 是否开放自助注册（默认关闭，「默认安全」） |
| | `AUTH_API_KEYS` | 否 | 空 | 开放接口 API Key，格式 `<key>:<主体名>:<权限码,权限码>`；多条用 `|` 分隔。**权限码本身含冒号，按前两段切分** |
| | `AUTH_API_KEY_SIGN_SECRET` | 否 | — | API Key 签名密钥（M10/E-07）：配置后 apikey 策略强制验签（`X-Api-Timestamp` + `X-Api-Sign`，算法与示例见 [41](./41-auth-strategies.md)）；敏感键不入日志 |
| | `AUTH_OAUTH2_PROVIDERS` | 否 | 空 | OAuth2 提供方配置（M10/E-07）：JSON 对象串 `{ provider: { clientId, clientSecret, authorizeUrl, tokenUrl, userInfoUrl, scope? } }`；空 = 未启用（`/auth/oauth2/providers` 返回空列表，登录页不渲染入口） |
| | `AUTH_OAUTH2_REDIRECT_WHITELIST` | 否 | 空 | OAuth2 回调地址白名单（M10/E-07）：逗号分隔 URL 前缀；**空 = 拒绝一切回调地址（默认安全）**，启用 OAuth2 端到端必须显式配置 |
| 队列 | `MQ_DRIVER` | 否 | memory | `memory` / `bullmq`；`kafka` 尚未实现 |
| SaaS | `SAAS_GRACE_PERIOD_DAYS` | 否 | 7 | 订阅到期宽限天数（M13/ADR-0031）：active --expire--> grace --满 N 天--> frozen；到期任务每小时巡检，非法取值（非正整数）回退默认并告警 |
| | `MQ_URL` | 条件 | — | bullmq 的 Redis 连接串；留空回退 `CACHE_URL`，两者皆空则启动失败 |
| | `MQ_PREFIX` | 否 | `fw:<APP_ENV>` | 队列键前缀，部署间须隔离 |
| | **Redis Cluster 形态**（M10 E-06） | — | — | `MQ_URL` 支持逗号分隔多节点（自动走 `ioredis.Cluster`）；**cluster 下必须 `MQ_PREFIX={...}:`（hash-tag，BullMQ 键族同槽）**，缺失时启动 WARN；`@fw/transport` 的 redis 驱动同样支持多节点串且**无 hash-tag 要求**（键操作全单键）；实测见 [94b](./94b-queue-transport-cluster-live-test.md) |
| | `MQ_CONCURRENCY` | 否 | 10 | 每队列消费并发 |
| | `MQ_MAX_ATTEMPTS` | 否 | 4 | 最大执行次数，含首次（即最多重试 3 次） |
| | `MQ_BACKOFF` | 否 | `1000,5000,30000` | 重试退避序列，单位毫秒 |
| | `MQ_JOB_TIMEOUT` | 否 | 60 | 单任务执行超时，单位秒 |
| | `MQ_CRON_ENABLED` | 否 | true | 是否启用定时调度；多实例须配 Redis 分布式锁 |
| | `MQ_RATE_LIMIT` | 否 | 0 | 每队列每秒处理上限；0 为不限速 |
| | `MQ_DEAD_LETTER_MAX` | 否 | 1000 | 死信保留上限 |
| | `MQ_DEAD_LETTER_PAGE_MAX` | 否 | 200 | 死信分页每页上限（M10/E-16，1~1000）：`GET /admin/queue/dead-letters` 的 `pageSize` 钳制值，超出收敛到上限而非报错；boot 键不入热更白名单 |
| | `MQ_SHUTDOWN_TIMEOUT` | 否 | 30 | 等待在途任务的停机超时，单位秒 |
| | `MQ_STALLED_MS` | 否 | 30000 | bullmq 失速检测间隔，单位毫秒；0 表示用 bullmq 默认值。消费进程被强杀后，在途任务最长等这么久被搬回等待区重试 |
| 多租户 | `TENANT_ENABLED` | 否 | false | 多租户总开关；false 时全部接口按单租户运行（解析零开销短路），与 M7 行为一致 |
| | `TENANT_ORDER` | 否 | `subdomain,header,jwt` | 租户解析回退顺序（`subdomain`/`header`/`jwt` 的子序列，逗号分隔）；未列出的来源即关闭，非法取值启动即失败 |
| | `TENANT_HEADER_NAME` | 否 | `x-tenant-id` | 请求头来源的头部名（小写） |
| | `TENANT_BASE_DOMAIN` | 否 | 空 | 子域名解析基准域名（如 `example.com`）；未配置时 subdomain 来源关闭 |
| | `TENANT_JWT_CLAIM` | 否 | `tenantId` | JWT claim 来源的字段名（取 access token 载荷） |
| | `TENANT_CACHE_TTL` | 否 | 60 | `tenants` 表查询结果的内存缓存 TTL，单位秒；租户停用/换库等管理操作最多延迟一个 TTL 生效 |
| | `TENANT_DB_KEY` | 否 | 空 | dedicated 租户独立库连接串的加密密钥（64 位十六进制或 base64）；缺省用内置开发密钥并打印告警，**生产必须显式配置**。种子写入与运行解密须用同一密钥，轮换密钥需重写 `db_url_enc` |
| 传输 | `TRANSPORT_DRIVER` | 否 | in-process | `in-process`（进程内直连，单体零依赖）/ `redis`（跨进程 RPC）；`tcp`/`kafka` 尚未实现，非法取值启动即失败 |
| | `TRANSPORT_URL` | 条件 | — | redis 驱动的 Redis 连接串；留空回退 `CACHE_URL`，两者皆空则启动失败 |
| | `TRANSPORT_PREFIX` | 否 | `fw:<APP_ENV>` | 传输键前缀，部署间须隔离（防多环境串消息） |
| | `TRANSPORT_TIMEOUT_MS` | 否 | 5000 | 单次传输调用超时（毫秒，100~600000）；超时即失败不等满 |
| | `TRANSPORT_ROLE` | 否 | both | 本进程角色：`caller` 只发起调用 / `handler` 只处理请求 / `both` 两者兼顾；微服务拆分后按进程职责裁剪 |
| | `TRANSPORT_INSTANCE_ID` | 否 | `host-<pid>` | 实例标识（诊断用：跨进程区分处理方） |
| | `TRANSPORT_SHUTDOWN_TIMEOUT` | 否 | 10 | 传输优雅停机等待在途请求的超时（秒） |
| 日志 | `LOG_LEVEL` | 否 | info | 级别；输出格式由 `@fw/logger` 固定为结构化 JSON（字段 `time/level/traceId/spanId/module/msg/ctx`），不提供格式切换键 |
| | `LOG_IDENTITY_FIELDS` | 否 | `userId,requestId` | 日志自动身份字段集（M12 W2 OBS-11，逗号分隔：`userId`/`requestId`/`familyId`/`jti`）；**显式空串关闭全部**。身份由 ALS 自动读取，调用方手塞 ctx 不覆盖 |
| 请求 ID | `REQUEST_ID_ENABLED` | 否 | true | 单请求 ID 双 ID 分层开关（M12 W2 OBS-09）：`false` 回退仅 traceId（零行为差异）；`requestId` 不跨服务透传（ADR-0026） |
| | `REQUEST_ID_HEADER` | 否 | `X-Request-Id` | 单请求 ID 头名（请求读取 + 响应回带同用）；上游合法 ULID 复用、非法值替换 |
| 指标 | `METRICS_AUTH_SECTION_ENABLED` | 否 | true | `/metrics` 的 `fw_auth_*` / `fw_security_*` 段开关（M12 W2 OBS-12；M15 增 `fw_auth_audit_dropped_total{path,reason}` 审计限流丢弃序列）；label 仅低基数 `result`/`reason`/`path`，身份字段禁止入 label。关闭只影响 `/metrics` 渲染，不影响周期性汇总结构化日志（指标抓取不可用时的兜底通道） |
| 演示面 | `DEMO_ENDPOINTS_ENABLED` | 否 | 未设置按环境 | demo*/cache-demo/demo-queue/demo-transport 自检控制器开关（M12 W3 OBS-16）：显式 true/false 优先；未设置时 dev 开、test/prod/default **404 关闭**（默认安全，ADR-0027） |
| 追踪 | `OTEL_ENABLED` | 否 | false | 链路追踪总开关（M8 T-M8-06）；关闭时全短路零开销 |
| | `OTEL_SERVICE_NAME` | 否 | `fw:<APP_ENV>` | 服务名（采集端按 `service.name` 聚合）；多服务部署必须显式区分 |
| | `OTEL_EXPORTER_URL` | 条件 | — | OTLP/HTTP 采集端点（如 `http://otel-collector:4318/v1/traces`）；`OTEL_ENABLED=true` 时**必填，缺失启动即失败**。导出形态为 OTLP/HTTP JSON |
| | `OTEL_SAMPLE_RATIO` | 否 | 0.1 | 采样比例（0~1，默认 10%）；按 traceId 确定性取值，同链路跨服务决策一致 |
| | `OTEL_SAMPLE_ERRORS` | 否 | true | 错误 span 全采开关（status=ERROR 或携带 exception 事件）；true 时错误链路不丢 |
| 配置中心（M9） | `CONFIG_CENTER_ENABLED` | 否 | false | 配置中心总开关；false 时零开销（不读文件不起轮询），运行时参数全部按 env 快照，`PUT /configs` 一律 1004 |
| | `CONFIG_CENTER_DRIVER` | 否 | file | 事实源适配器（M10 E-02 起：`file` = 本地文件 + mtime 轮询，多实例需共享文件系统；`nacos` = Nacos v1 Open API 内容 MD5 轮询，多实例天然安全）；非法取值启动即失败 |
| | `CONFIG_CENTER_FILE` | 否 | `./config/runtime.json` | 运行时配置文件路径（点路径 → 覆盖值的 JSON 对象）；**file 适配多实例需共享文件系统（K8s PVC）**，否则用 nacos 驱动 |
| | `CONFIG_CENTER_POLL_SECONDS` | 否 | 5 | mtime 轮询间隔（秒，1~300）；热更生效延迟上界 = 轮询间隔 + 1s。文件损坏时保持最后一份有效快照（fail-keep）并记 ERROR，修复后自动追上 |
| | `CONFIG_CENTER_NACOS_SERVER_ADDR` | 条件 | — | Nacos 服务地址（如 `http://nacos:8848`）；`CONFIG_CENTER_DRIVER=nacos` 时**必填，缺失启动即失败** |
| | `CONFIG_CENTER_NACOS_DATA_ID` | 否 | fw-runtime | Nacos 配置 ID（对应一份运行时覆盖 JSON） |
| | `CONFIG_CENTER_NACOS_GROUP` | 否 | DEFAULT_GROUP | Nacos 分组 |
| | `CONFIG_CENTER_NACOS_NAMESPACE` | 否 | — | Nacos 命名空间（缺省 public） |
| | `CONFIG_CENTER_NACOS_USERNAME` / `CONFIG_CENTER_NACOS_PASSWORD` | 条件 | — | Nacos 鉴权凭据（服务端开启鉴权时必填；密码属敏感键不入日志） |
| | `CONFIG_CENTER_HISTORY_MAX` | 否 | 20 | 配置历史保留版本数（M10/E-16，1~1000）：回滚候选集与环形表淘汰条数，超出淘汰最旧；boot 键不入热更白名单 |
| 任务中心（M10/E-01） | `JOB_CENTER_DRIVER` | 否 | memory | 异步任务中心驱动：`memory` 进程内（N-02 原行为，多副本下任务面跨实例 404）/ `db` `jobs` 表登记 + 派发实例执行 / `bullmq` `jobs` 表登记 + 队列分发（消费 handler `job-center.execute`，执行实例随 `MQ_DRIVER`）。**多副本部署必须 db 或 bullmq**；boot 键不入热更白名单；db/bullmq 要求任务类型登记 `JobRunnerRegistry` 执行体工厂 |
| | `JOB_ARTIFACT_MAX_MB` | 否 | 20 | 任务产物体积上限（M10/E-16，MB，1~1024）：memory / db / bullmq 三驱动同口径注入，超出即失败终态；boot 键不入热更白名单 |
| 限流（M10/E-03） | `RATE_LIMIT_CAPACITY` | 否 | 600 | 令牌桶容量（每 IP 突发上限），超出即 `429/9003`；**默认开启且不可整体关闭**——豁免走 `RATE_LIMIT_WHITELIST`，灰度观测走 `RATE_LIMIT_DRY_RUN` |
| | `RATE_LIMIT_REFILL_PER_SECOND` | 否 | 10 | 每秒补充令牌数（稳态吞吐上限）；boot 键不入热更白名单 |
| | `RATE_LIMIT_WHITELIST` | 否 | `/api/v1/health,/api/v1/ready,/api/v1/metrics` | 豁免路径前缀（逗号分隔，严格路径段匹配）；健康探针与 metrics 必须豁免 |
| | `RATE_LIMIT_FAIL_OPEN` | 否 | true | 限流存储故障时放行（与 cache 三防护同构）；false = fail-closed 全拒绝 |
| | `RATE_LIMIT_DRY_RUN` | 否 | false | 灰度模式：true = 超限仅计数告警不拦截（桶与计数照常运转，计数进 `/metrics` 的 `fw_rate_limit_*` 段） |
| 审计归档（M10/E-10） | `AUDIT_ARCHIVE_RETENTION_DAYS` | 否 | 180 | 审计在线表保留天数（1~3650）：定时任务 `audit.archive`（每天 02:00，`MQ_CRON_ENABLED` + 分布式锁多副本单执行）把 `created_at` 早于保留线的记录迁入 `audit_log_archives` 冷存表（先写归档后删在线，失败不删）；在线表行数持续有界，冷数据经 `/audit-archives` 查询/导出 |
| | `AUDIT_ARCHIVE_BATCH_SIZE` | 否 | 1000 | 归档单批条数（1~100000）：每批「先写归档（幂等 upsert）后删在线」，控制单批事务压力与长占锁时间；大批量存量首次归档可调大 |
| 文件存储（M10/E-09） | `STORAGE_DRIVER` | 否 | local | 文件存储驱动（PRD-010 E-09）：`local` 本地磁盘（零依赖）/ `s3` S3 兼容对象存储（`@aws-sdk/client-s3` 为 optional peer，启用前安装）；非法取值启动即失败；boot 键不入热更白名单（切换属进程形态变更，须重启） |
| | `STORAGE_LOCAL_ROOT` | 否 | ./uploads | local 驱动存储根目录：对象 key 为其下相对路径（`<yyyyMM>/<uuid><ext>`，服务端生成，免疫路径穿越）；多副本部署时 local 驱动须挂共享卷或改 s3，否则下载只在写入实例可达 |
| | `STORAGE_S3_ENDPOINT` | 否 | — | S3 兼容端点（MinIO / COS / OSS 等）；缺省走 AWS 原生寻址 |
| | `STORAGE_S3_REGION` | 否 | us-east-1 | S3 区域 |
| | `STORAGE_S3_BUCKET` | s3 时必填 | — | S3 桶名；`STORAGE_DRIVER=s3` 且缺失时**启动即失败**（不猜默认桶） |
| | `STORAGE_S3_ACCESS_KEY_ID` | 否 | — | S3 访问密钥 ID（未配置时回退节点 IAM / 环境链路） |
| | `STORAGE_S3_SECRET_ACCESS_KEY` | 否 | — | S3 访问密钥（敏感键不入日志） |
| | `STORAGE_S3_FORCE_PATH_STYLE` | 否 | true | path-style 寻址：MinIO 必须 `true`；AWS 原生建议 `false` |
| | `STORAGE_MAX_MB` | 否 | 20 | 单文件大小上限（MB，1~1024）：超出 `400/1001` 拒绝（不静默截断），multer 层与 `@fw/storage` 业务校验同口径；扩展名白名单默认收紧（`.png/.jpg/.jpeg/.gif/.webp/.pdf/.txt/.csv/.xlsx/.docx/.zip`），放宽改 `STORAGE_ALLOWED_EXTS` |
| 前端（admin-web） | `VITE_API_BASE_URL` | 是 | — | 管理后台 API 基址（如 `https://api.example.com/api/v1`）；**构建期注入**，改值需重新构建 |
| | `VITE_APP_TITLE` | 否 | 通用应用框架 | 站点标题 |
| | `VITE_LOGIN_CAPTCHA` | 否 | false | 登录页验证码开关（true 时需接入验证码服务） |
| | `VITE_USE_MOCK` | 否 | 随 mode | 是否挂载 mock server（`true`/`false`）；**生产构建不引入任何 mock 代码**，切真实后端只改此项与 `VITE_API_BASE_URL` |
| | `WEB_KEEP_ALIVE_MAX` | 否 | 12 | 前端 keep-alive 条数上限（M10/E-16，1~1000）：`<keep-alive :max>` 钳制值；**入热更白名单**（`web.keepAliveMax`），`GET /configs` 可查、`PUT /configs/web.keepAliveMax` 可在线改（前端下一会话加载生效） |
| | `VITE_RUM_ENABLED` | 否 | true | 前端错误监控 RUM 开关（M10/E-17）：`false` 时整体关闭采集（零开销）；开启时异常经 `POST /api/v1/telemetry/client-errors` 上报（sendBeacon fire-and-forget，不影响业务）。**构建期注入**，改值需重新构建 |

**密钥管理**：生产禁止把密钥写进镜像或仓库；用 K8s Secret / 环境变量注入 / 密钥管理服务，定期轮换并保留 `*_PREV` 过渡值。

**管理后台托管**：`apps/admin-web` 生产构建（`pnpm --filter admin-web build`）产出纯静态 `dist/`，无 Node 依赖；Nginx 需配置 SPA history 回退（`try_files $uri $uri/ /index.html`），API 请求经 `VITE_API_BASE_URL` 直连后端或由 Nginx 反代 `/api/`。

**队列持久性**：`memory` 驱动的待执行任务不跨进程重启保留，仅用于可丢失任务；需要重启后恢复任务时选 `bullmq`，并为 Redis 配置持久化。多实例 cron 锁依赖 `CACHE_DRIVER=redis` 及可用的 `CACHE_URL`。

**多租户 dedicated 隔离（M8 T-M8-02）**：`tenants.isolation='dedicated'` 的租户按 `db_url_enc`（AES-256-GCM 密文，密钥为 `TENANT_DB_KEY`）路由到独立库。运维要点：

- 独立库与主库**同 schema**（迁移须同版本执行）；账号 / 权限 / 租户元数据仍在主库，业务数据在独立库；
- 连接串解密只在租户存储适配层发生，明文不入日志 / 审计 / 队列消息；`TENANT_DB_KEY` 按密钥管理规范注入并轮换；
- 路由层按进程内 LRU + 空闲淘汰管理独立库连接（默认上限 32、空闲 10 分钟），实例重启后按请求懒建连；
- 新增 dedicated 租户流程：建同 schema 空库 → 写 `tenants` 行（密文连接串）→ 建账号（`tenant_id` = 新租户）→ 验证 `TENANT_CACHE_TTL` 内生效；
- 停用 / 回收租户：`status=0` 立即 fail-closed（403/4001），独立库数据按合同约定归档后再下线。

**传输层角色裁剪（M8 T-M8-05）**：`in-process` 驱动为单体默认，进程内直连零外部依赖，不涉及跨机语义。拆分为多进程 / 多实例时切 `redis` 驱动并按进程职责设 `TRANSPORT_ROLE`：

- `handler` / `both`：消费 `<前缀>:req:<address>` 并注册本地 `@TransportHandler`，只应部署在承载对应服务的进程；`caller` 只发起调用不起消费循环，避免重复竞争；
- redis 驱动要求 `TRANSPORT_URL`（缺省回退 `CACHE_URL`）**启动期即可达**——连接串缺失或不可达时进程启动即失败（fail-fast），不会带病进入服务中；
- 调用方超时（`TRANSPORT_TIMEOUT_MS`，默认 30000）到达即失败返回 503/9002，处理方执行上限取信封内调用方超时，两侧语义对等；`TRANSPORT_SHUTDOWN_TIMEOUT` 控制停机时在途请求的宽限；
- redis 驱动复用缓存集群时建议独立 `TRANSPORT_PREFIX` 隔离键空间；对消息可靠性有要求时按缓存章节为 Redis 配置持久化；
- `ioredis` 为 optional peer 依赖，仅 `redis` 驱动按需安装（`pnpm add ioredis`）。

**链路追踪（M8 T-M8-06，PRD-008 FR-07）**：`OTEL_ENABLED=true` 后 traceId 贯穿 HTTP / DB / 缓存 / 队列 / 传输，经 OTLP/HTTP 导出到采集端（如 OTel Collector），日志自动带 traceId/spanId。运维要点：

- **依赖**：`@fw/telemetry` 的 SDK 为 optional peer 依赖，启用前须安装 `@opentelemetry/sdk-node` 与 `@opentelemetry/exporter-trace-otlp-http`（未装且启用时启动即失败并给出安装提示）；
- **端点**：`OTEL_EXPORTER_URL` 指向采集端 `/v1/traces`，导出为 JSON（`content-type: application/json`）；采集端临时不可达时丢 span 但业务不受影响（日志仍带 traceId 可定位）；
- **采样**：默认 10%，按 traceId 低 8 位确定性取值——同一链路在所有服务上采样决策一致；`OTEL_SAMPLE_ERRORS=true`（默认）时错误链路全采；已启用尾采样，**不建议**在应用侧把 ratio 设为 1 后又在采集端重复采样（可在高 QPS 时把 ratio 设 1 并将尾采样下沉到 OTLP Collector 的 `tail_sampling` processor）；
- **跨服务贯通**：多进程 / 多实例部署下，服务间经标准 W3C `traceparent` 头传播（transport 的 redis 信封自动携带），HTTP 入口亦兼容框架自有 `X-Trace-Id`（老客户端 / 未接 OTel 的上游仍可关联）；上游携带 `traceparent` 时服务端复用其 traceId 并续接父子关系（TC-TNT-006）；
- **资源属性**：导出 span 携带 `service.name`（缺省 `fw:<APP_ENV>`）与 `service.version`，采集端据此区分服务与环境；
- **停机**：优雅停机时 flush 在途 span 后关闭 provider，停机路径不因 flush 失败而中断。

## 4. 小档部署（单机 Docker）

```bash
# 1. 准备配置（SQLite + 内存缓存，零外部依赖）
cat > .env <<'EOF'
APP_ENV=prod
DB_DRIVER=sqlite
DB_URL=file:/data/app.db
CACHE_DRIVER=memory
AUTH_STRATEGY=jwt
JWT_SECRET=<生成的强随机串>
MQ_DRIVER=memory
EOF

# 2. 启动
docker run -d --name app -p 3000:3000 \
  -v /opt/app/data:/data --env-file .env \
  --restart unless-stopped registry.example.com/fw-app:1.0.0

# 3. 执行迁移与种子数据
docker exec app pnpm db:migrate
docker exec app pnpm db:seed

# 4. 验证
curl -fsS http://127.0.0.1:3000/health
```

要点：数据目录必须挂载到宿主机；`--restart unless-stopped` 保证重启自愈；**备份 = 备份挂载目录**。

## 5. 中档部署（docker-compose）

框架内置编排文件 **`deploy/docker-compose.prod.yml`**（`name: fw-prod`）与配套 **`deploy/nginx/fw.conf`**（SPA 回退 + `/api` 反代 + `traceparent` 透传 + 登录限流 + 运维端点内网白名单），可作为中档起步模板：

```
├─ nginx        # 静态资源 + 反向代理 + TLS 终止 + 限流（deploy/nginx/fw.conf）
├─ app-1 / app-2# 无状态应用实例（同一镜像）
├─ worker       # BullMQ 消费者（可与 app 同镜像不同启动命令）
├─ postgres     # 主库（也可换 MySQL）
├─ redis        # 缓存 + 队列 + 分布式锁
└─ migrate      # 一次性迁移容器（先于 app 启动，退出即完成）
```

**操作**

```bash
docker compose -f deploy/docker-compose.prod.yml --env-file .env.prod up -d   # 启动
docker compose -f deploy/docker-compose.prod.yml exec app pnpm db:migrate     # 迁移（只在一个实例执行）
docker compose -f deploy/docker-compose.prod.yml logs -f --tail=200 app       # 看日志
docker compose -f deploy/docker-compose.prod.yml up -d --scale app=3          # 扩容实例
docker compose -f deploy/docker-compose.prod.yml down                          # 停止（保留卷）
```

**Nginx 要点**（已落 `deploy/nginx/fw.conf`）：`/api` 反向代理到 app 上游；`/` 指向前端静态资源并配 SPA history 回退；透传上游 `traceparent`（与 OTel 链路追踪贯通）；`/auth/*` 单独限流；`/metrics`、`/ready`、`/health` 等运维端点限内网白名单；开启 gzip 并让 `client_max_body_size` 与上传限制对齐；TLS 证书与自动续期。

**无状态要求**：会话不落本地内存（走 Redis 或 JWT）、上传文件走对象存储、定时任务靠分布式锁单点执行——否则多实例会出现行为不一致。

## 6. 大档部署（Helm / K8s）

框架内置 Chart 位于 **`deploy/helm/fw-app/`**（apiVersion v2，`version`/`appVersion` 0.1.0，`kubeVersion >= 1.24`），配套生产覆盖 `deploy/helm/fw-app/values-prod.yaml`、Chart 使用说明 `deploy/helm/fw-app/README.md`。Chart 不托管于远端仓库——按项目需要自行 `helm package` 后推送私有 OCI/ChartMuseum，或直接从仓库目录安装：

```bash
# 从仓库目录直接安装（推荐先 --dry-run 预演）
helm upgrade --install myapp deploy/helm/fw-app \
  -f deploy/helm/fw-app/values-prod.yaml \
  --set image.repository=registry.example.com/fw-app --set image.tag=1.0.0 \
  --wait --timeout 5m

# 或打包后推送私有仓库
helm package deploy/helm/fw-app -d dist/    # 产出 fw-app-0.1.0.tgz
helm push dist/fw-app-0.1.0.tgz oci://registry.example.com/charts
```

**离线校验（无需 K8s 集群）**：仓库内置 Helm 模板子集渲染 + K8s 清单语义断言脚本，CI 与本地均可运行，确保模板可渲染、三档探针 / 滚动更新 / HPA / PDB / 迁移 Job / `checksum/config` 注解等语义不漂移：

```bash
pnpm check:helm        # 等价 node scripts/check-helm-chart.mjs，离线渲染三档并断言清单语义
```

**关键 values**（完整项见 `values.yaml` 注释）

| 项 | 默认 / 建议 |
|---|---|
| `replicaCount` | 3 |
| `strategy` | RollingUpdate，`maxUnavailable=0`，`maxSurge=1` |
| `probes.readiness` / `probes.liveness` / `probes.startup` | 分别指向 `/ready` 与 `/health`（启动探针防慢启动被误杀） |
| `resources` | 必须设置 requests/limits，避免节点资源争抢 |
| `autoscaling` | 默认关；开启后 `minReplicas=3`、CPU 60% 触发、`maxReplicas` 按容量评估 |
| `podDisruptionBudget` | `minAvailable: 2` |
| `migrateJob` | `helm.sh/hook: pre-install,pre-upgrade`，迁移先于应用滚动 |
| `worker` / `adminWeb` | 与主 Deployment 分离的独立工作负载；cron/handler 与 app 分进程，避免多副本重复执行 |
| `secrets` | 留空并配 `secrets.existingSecret`，从外部 Secret / CSI 驱动注入，**禁止写入 values 文件** |
| `podAntiAffinity` / `topologySpreadConstraints` | 生产开启，跨节点/可用区打散 |

**变更触发滚动**：Deployment 带 `checksum/config: {{ include "fw-app.configData" . | sha256sum }}` 注解，ConfigMap 内容变化即触发 Pod 滚动，保证配置与进程同步生效。

> **验收现状（M8 T-M8-07）**：Chart 与 compose 资产已交付、离线校验 63/63 通过；**真实 K8s 集群部署冒烟未执行**（本机沙箱无 kubectl/集群，遗留 L-01，见 `docs/archive/m8/96-m8-drills.md` §6.4）。上生产前请在目标集群补一次 `helm template` + `--dry-run=server` + 灰度发布验证。
>
> **2026-10-15 决策**：L-01 **暂缓**（暂无可用集群环境，不为冒烟单独购机）。选型所需的服务器规格结论已先行落档——**验证 1 台（k3s 单节点 4C8G）/ 最小生产 2 台 / 高可用 3 台起（etcd 奇数票）**，Chart 默认 7 Pod 资源账与各目标档的 values 精简建议见 [Helm README §7](../deploy/helm/fw-app/README.md)。暂缓期间门禁不裸奔：`pnpm check:helm` 离线校验持续在 CI 生效。

## 7. 启动、停止与优雅停机

| 操作 | 命令 / 行为 |
|---|---|
| 启动 | 容器入口执行 `pnpm db:migrate`（由迁移锁保证单实例执行）后启动应用 |
| 停止 | 发 `SIGTERM`；应用停止接收新请求，等待在途请求完成（默认 10s）后退出 |
| 强制退出 | 超时后记录告警；memory 在进程退出后不保留重新入队的任务，bullmq 由 Redis 持久化与失速检测恢复 |
| 禁止 | 直接 `kill -9`，会导致在途请求丢失与任务状态不一致 |

## 8. 数据与备份

| 项 | 策略 |
|---|---|
| 迁移 | 发布流程内自动执行；禁止手工改库结构；禁止修改已提交迁移文件 |
| 备份频率 | 每日全量 + binlog/WAL 增量（中/大档）；小档每日拷贝数据目录 |
| 保留期 | 全量 30 天，月度快照保留 12 个月 |
| 加密与异地 | 备份加密，至少一份异地/对象存储 |
| 恢复演练 | **每季度一次**，记录 RTO/RPO 实测值，演练不通过视为 P1 缺陷 |
| 敏感数据 | 备份中含用户信息，按合规要求控制访问与下载权限 |

```bash
# MySQL 备份与恢复示例
mysqldump --single-transaction --routines myapp > backup_$(date +%F).sql
mysql myapp < backup_2026-10-09.sql
```

## 9. 监控与告警

**核心指标**（`/metrics` 暴露）

| 指标 | 告警阈值建议 |
|---|---|
| HTTP 5xx 率 | 5 分钟内 > 1% |
| 接口 P95 | 持续 10 分钟 > 1s |
| 缓存命中率 | 持续 30 分钟 < 80% |
| 队列积压 | > 1000 或持续增长 10 分钟 |
| 慢查询数 | 5 分钟内 > 10 |
| 降级事件计数 | > 0（提示依赖故障） |
| DB 连接池使用率 | > 80% |
| 磁盘 / 内存 / CPU | 分别 > 85% / 85% / 80% |
| 证书到期 | < 15 天 |

**日志排查**：所有日志带 `traceId`，先取响应头 `X-Trace-Id`，再按 traceId 检索全链路：

```bash
# 结构化日志按 traceId 检索（示例：jq）
cat app.log | jq 'select(.traceId=="b3f1c9")'
# 按错误级别与模块统计
cat app.log | jq -r 'select(.level=="error") | .module' | sort | uniq -c | sort -nr
```

## 10. 故障处理 Runbook

| 现象 | 排查 | 处置 | 恢复确认 |
|---|---|---|---|
| 应用起不来 | 看启动日志：配置校验失败 / 端口占用 / DB 不可达 | 修正 `.env` 或依赖；勿改代码绕过校验 | `/health` 返回 200 |
| 5xx 飙升 | 按 module 聚合错误日志；查最近发布与迁移 | 回滚上一版本；必要时摘除故障实例 | 5xx 率 < 0.1% |
| DB 连接耗尽 | 查连接池指标与慢查询 | 限流降级、杀长事务、临时调大连接池并定位慢 SQL | `/ready` 恢复 ok |
| Redis 不可用 | 确认降级是否生效（`CACHE_FAIL_OPEN`） | 恢复 Redis；观察回切无脏数据 | 命中率回升，降级计数归零 |
| 队列积压 | 查 worker 是否存活、失败率、消费速率 | 扩容 worker、暂停非关键队列、修复失败任务后重放 | 积压持续下降 |
| 定时任务没执行 | 查锁、cron 开关、worker 副本数 | 修锁或手动触发；确认未重复执行 | 任务记录出现且仅一条 |
| 磁盘写满 | 查日志与备份占用 | 清理旧日志与备份，扩容磁盘 | 使用率 < 70% |
| 证书过期 | 检查 Nginx/Ingress 证书 | 续期并重载 | HTTPS 握手正常 |
| 数据被误删 | 定位删除操作（审计日志 + traceId） | 软删可恢复；否则用备份按时间点恢复 | 数据一致性校验通过 |

## 11. 扩容与缩容

- **横向**：应用无状态，中档 `--scale`，大档调 HPA；扩容后确认 `/ready` 全部就绪再导流。
- **纵向**：先扩应用，再考虑数据库；数据库优先加只读从库与连接池调优。
- **缩容**：先摘流量（`/ready` 返回非 ok）→ 等待在途请求完成 → 再终止，避免 5xx。

## 12. 升级与回滚

1. 预检：备份数据库、确认镜像 tag、确认迁移脚本可逆性。
2. 灰度：大档先发 1 个副本观察 10 分钟（错误率、P95、日志无新增错误）。
3. 全量：滚动更新，`maxUnavailable=0`。
4. 迁移：破坏性变更按「加字段 → 双写 → 切读 → 删旧字段」分多次发布。
5. 回滚触发条件：5xx > 1%、P95 翻倍、关键功能不可用、数据不一致。
6. 回滚步骤：回滚镜像（含迁移回滚脚本），确认 `/health` 与核心接口，补缺陷用例。

## 13. 安全运维

- 密钥集中管理、定期轮换；代码与镜像中禁止存在明文密钥（CI 扫描门禁）。
- 最小权限：应用数据库账号仅授予必要库的 DML（迁移用单独账号）；容器以非 root 运行。
- 端口最小化：仅暴露 80/443，数据库与 Redis 不对外；内网安全组限制来源。
- 依赖与镜像：定期更新基础镜像与依赖，漏洞扫描无高危才发布。
- 审计：管理操作（改密、授权、租户变更）留痕，审计日志保留 ≥ 180 天。
- 备份加密与访问审计同样适用于运维操作。

## 14. 值班检查清单

| 频次 | 检查项 |
|---|---|
| 每日 | `/health`、`/ready` 正常；5xx 与 P95 无异常；队列无积压；备份任务成功 |
| 每周 | 慢查询 Top10；缓存命中率；磁盘与内存趋势；依赖漏洞扫描结果 |
| 每月 | 证书与密钥到期检查；容量评估；备份恢复演练；Runbook 复盘更新 |
| 每季 | 灾备演练（切换/演进/降级三大演练，可执行化脚本 `pnpm --filter example-api drill`）；RTO/RPO 复核；权限与审计抽查 |

## 15. 常用命令速查

```bash
fw new <name> --template=admin      # 建项目
fw dev | fw build | fw check        # 开发 / 构建 / 配置自检
fw db:migrate | db:rollback | db:seed
fw gen crud <model> [--dry|--force]

pnpm check:helm                     # Helm Chart 离线渲染 + K8s 清单语义校验（无需集群）
pnpm --filter example-api drill     # M8 三大关键演练（切换 / 演进 / 降级）
pnpm --filter example-api bench     # 性能基线压测（登录 / 列表 / 写入）

curl -s localhost:3000/health | jq
curl -s localhost:3000/ready  | jq
curl -s localhost:3000/metrics | grep cache_hit

docker compose -f deploy/docker-compose.prod.yml logs -f --tail=200 app
helm upgrade --install myapp deploy/helm/fw-app -f deploy/helm/fw-app/values-prod.yaml --dry-run
kubectl rollout status deploy/myapp
kubectl rollout undo deploy/myapp
```

> **`db:seed` 是破坏性操作**（只用于 dev / 验收夹具，禁止在生产重置数据前未备份）：清场范围含业务与鉴权表，
> 以及**租户级 SaaS 数据**（订阅 / 配额覆盖 / 窗口用量 / 用量事件 / 用量汇总 / 生命周期日志）与归档审计
> `audit_log_archives`——租户每次重建都从 ID 0 起分配，若不清这些携带 `tenant_id` 的行，新租户会继承同 ID
> 旧租户的订阅（`active_marker` 唯一键被占，开通直接 `409/1003`）、用量与历史。目录类数据
> （`plans` / `plan_versions` / `plan_quotas` / `quota_definitions`）刻意保留，不随 reseed 清空。
