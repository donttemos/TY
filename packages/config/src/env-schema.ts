/*
 * @file 环境变量 schema
 * @description 用 zod 定义全部配置键的类型与取值约束；新增配置项必须同步 .env.example 与 docs/40-api-spec.md；前缀即能力切换点（DB_/CACHE_/AUTH_/MQ_），非法取值在启动时即失败。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo AUTH_ALLOW_REGISTER 默认改 false（与部署手册/「默认安全」一致）
 * @modified 2026-10-13 donttemo M4 新增 9 个 CACHE_* 键（前缀/TTL/容量/降级/空值/抖动/锁/慢操作/大key）
 * @modified 2026-10-13 donttemo M7 新增 10 个 MQ_* 键（连接/前缀/并发/尝试/退避/超时/cron/限速/死信上限/停机等待）
 * @modified 2026-10-13 donttemo M8 新增 6 个 TENANT_* 键（总开关/解析顺序/请求头名/基准域名/JWT claim/缓存TTL）
 * @modified 2026-10-14 donttemo M8 T-M8-02 新增 TENANT_DB_KEY（dedicated 租户独立库连接串加密密钥）
 * @modified 2026-10-14 donttemo M8 T-M8-05 新增 7 个 TRANSPORT_* 键（驱动/连接/前缀/超时/角色/实例标识/停机等待）
 * @modified 2026-10-14 donttemo M8 T-M8-06 新增 5 个 OTEL_* 键（总开关/服务名/导出端点/采样比例/错误全采）
 * @modified 2026-10-13 donttemo 新增 MQ_STALLED_MS（bullmq 失速检测间隔，TC-JOB-008 演练可调）
 * @modified 2026-10-15 donttemo M9/PRD-009 新增 4 个 CONFIG_CENTER_* 键（总开关/驱动/文件/轮询间隔）；
 *   新增 ENV_KEY_PATHS（全部 Env 键 → 点路径注册表）与 ENV_HOT_KEYS（热更新白名单，FR-03）——
 *   两者都以类型与单测强制与 envSchema.shape 对齐：新增配置键未登记映射时单测即失败（防键集漂移）
 * @modified 2026-10-15 donttemo M10/E-01 新增 JOB_CENTER_DRIVER（任务中心驱动，boot 键不入热更白名单）
 * @modified 2026-10-15 donttemo M10/E-02 CONFIG_CENTER_DRIVER 枚举转正 nacos；新增 6 个
 *   CONFIG_CENTER_NACOS_* 键（服务地址/dataId/分组/命名空间/鉴权用户名密码）——72 键
 * @modified 2026-10-15 donttemo M10/E-03 新增 5 个 RATE_LIMIT_* 键（容量/每秒补充/豁免前缀/
 *   故障放行/灰度仅告警）——G5「限流默认开启」的框架级落地，77 键
 * @modified 2026-10-15 donttemo M10/E-07 新增 3 个 AUTH_* 键（OAuth2 提供方 JSON / 回调地址白名单 /
 *   API Key 签名密钥）——认证策略名实相符，80 键；全部 boot 键不入热更白名单
 * @modified 2026-10-15 donttemo M10/E-10 新增 2 个 AUDIT_ARCHIVE_* 键（保留天数 / 单批条数）——
 *   审计归档策略（PRD-010 AC7：在线表行数回落），82 键；boot 键不入热更白名单
 * @modified 2026-10-15 donttemo M10/E-16 边界上限配置化：新增 4 键（WEB_KEEP_ALIVE_MAX 前端
 *   keep-alive 条数 / MQ_DEAD_LETTER_PAGE_MAX 死信分页每页上限 / JOB_ARTIFACT_MAX_MB 任务产物
 *   体积上限 / CONFIG_CENTER_HISTORY_MAX 配置历史版本数）——含 M10/E-10 两键共 87 键；
 *   web.keepAliveMax 入热更白名单（12 键），其余 boot 键禁入
 *   （前端 GET /configs 消费路径要求，PRD-010 E-16 评审扩范围），其余三项构造期读取，不入白名单
 * @modified 2026-10-16 donttemo M10/E-09 新增 10 个 STORAGE_* 键（驱动/local 根目录/s3 五件套/
 *   path-style/大小上限/扩展名白名单）——文件存储端口（PRD-010 E-09），97 键；
 *   全部为 boot 键不入热更白名单（驱动与存储根属进程形态变更，必须走重启）
 * @module config
 * @since v0.1.0
 */
import { z } from 'zod';

/** 运行环境，对应 .env.{env} 覆盖文件 */
export const APP_ENV_VALUES = ['default', 'dev', 'test', 'prod'] as const;
/** 日志级别，从低到高 */
export const LOG_LEVEL_VALUES = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const;
/** 数据库驱动可选值（M2 起生效，M1 仅校验与透传） */
export const DB_DRIVER_VALUES = ['mysql', 'postgres', 'sqlite'] as const;
/** 缓存驱动可选值（M4 起生效） */
export const CACHE_DRIVER_VALUES = ['memory', 'redis', 'redis-cluster'] as const;
/** 鉴权策略可选值（M3 起生效） */
export const AUTH_STRATEGY_VALUES = ['jwt', 'session', 'oauth2', 'apikey'] as const;
/** 密码强度策略可选值（PRD-003 FR-07） */
export const AUTH_PASSWORD_POLICY_VALUES = ['low', 'medium', 'high'] as const;
/** 队列驱动可选值（M7 起生效；`kafka` 仅预留驱动端口，M8 落地，故暂不入枚举——非法取值启动即失败） */
export const MQ_DRIVER_VALUES = ['memory', 'bullmq'] as const;
/** 传输驱动可选值（M8 起生效，PRD-008 FR-06；`tcp` / `kafka` 仅预留驱动端口，暂不入枚举——非法取值启动即失败） */
export const TRANSPORT_DRIVER_VALUES = ['in-process', 'redis'] as const;
/** 传输角色可选值（M8 起生效）：caller 只调用 / handler 只处理 / both 两者兼顾 */
export const TRANSPORT_ROLE_VALUES = ['caller', 'handler', 'both'] as const;
/** 租户识别来源可选值（M8 起生效，PRD-008 FR-01 三级回退） */
export const TENANT_SOURCE_VALUES = ['subdomain', 'header', 'jwt'] as const;
/** 配置中心驱动可选值（M9/PRD-009 FR-01 起生效；M10 E-02 `nacos` 转正入枚举——非法取值启动即失败） */
export const CONFIG_CENTER_DRIVER_VALUES = ['file', 'nacos'] as const;
/** 任务中心驱动可选值（M10/E-01 起生效）：memory 进程内（默认）/ db 落库+派发实例执行 / bullmq 落库+队列分发 */
export const JOB_CENTER_DRIVER_VALUES = ['memory', 'db', 'bullmq'] as const;
/** 限流键维度（M10/E-03）：per-ip 固定（中间件位于鉴权守卫之前，拿不到用户身份）；白名单豁免是另一出口 */
export const RATE_LIMIT_SCOPE_VALUES = ['per-ip'] as const;
/** 文件存储驱动可选值（M10/E-09 起生效；`oss`/`cos` 原生协议暂不入枚举，走 s3 兼容端点——非法取值启动即失败） */
export const STORAGE_DRIVER_VALUES = ['local', 's3'] as const;

/** 空字符串视为未设置（.env 里 `DB_URL=` 留空等价于注释掉） */
const emptyToUndefined = (value: unknown): unknown =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

/** 可选连接串：空串等价未设置；填写后必须非空 */
const optionalUrl = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());

/** 可选字符串：空串等价未设置（密钥类配置不设默认值，避免弱默认值带入生产） */
const optionalString = () => z.preprocess(emptyToUndefined, z.string().min(1).optional());

/**
 * 布尔型环境变量：z.coerce.boolean 会把字符串 'false' 判为 true，
 * 因此显式白名单：「true/1/yes/on」为真，其余为假。
 */
const boolString = (defaultValue: boolean) =>
  z
    .preprocess(
      (value) => (typeof value === 'string' ? ['true', '1', 'yes', 'on'].includes(value.trim().toLowerCase()) : value),
      z.boolean(),
    )
    .default(defaultValue);

/**
 * 环境变量 schema：必填项无默认值（缺失即启动失败），可选项带默认值与中文说明
 */
export const envSchema = z.object({
  /** 运行环境（必填，决定加载哪个 .env.{env} 覆盖文件） */
  APP_ENV: z.enum(APP_ENV_VALUES).describe('运行环境：default/dev/test/prod'),
  /** HTTP 监听端口 */
  APP_PORT: z.coerce.number().int().min(1).max(65535).default(3000).describe('HTTP 监听端口'),
  /** 日志级别 */
  LOG_LEVEL: z.enum(LOG_LEVEL_VALUES).default('info').describe('默认日志级别'),
  /** 单条日志最大字节数，超出截断 */
  LOG_MAX_BYTES: z.coerce.number().int().min(512).default(8192).describe('单条日志上限（字节）'),
  /** 数据库驱动 */
  DB_DRIVER: z.enum(DB_DRIVER_VALUES).default('sqlite').describe('数据库驱动'),
  /** 数据库连接串 */
  DB_URL: optionalUrl().describe('数据库连接串'),
  /** 缓存驱动 */
  CACHE_DRIVER: z.enum(CACHE_DRIVER_VALUES).default('memory').describe('缓存驱动'),
  /** 缓存连接串（redis 驱动必填；cluster 模式为逗号分隔的节点列表） */
  CACHE_URL: optionalUrl().describe('Redis 连接串'),
  /** key 全局前缀；留空时自动使用 `fw:<APP_ENV>`（避免多应用/多环境串数据） */
  CACHE_PREFIX: z.string().default('').describe('缓存 key 全局前缀'),
  /** 默认 TTL（秒） */
  CACHE_TTL: z.coerce.number().int().min(1).max(86400).default(300).describe('缓存默认 TTL（秒）'),
  /** memory 驱动容量上限（LRU 淘汰） */
  CACHE_MAX_ITEMS: z.coerce.number().int().min(1).max(1000000).default(10000).describe('memory 驱动容量上限'),
  /** 依赖故障是否降级直查（fail-open）；false 时抛 9002 */
  CACHE_FAIL_OPEN: boolString(true).describe('缓存故障降级开关（CACHE_FAIL_OPEN）'),
  /** 空值占位 TTL（秒）：防穿透，PRD-004 FR-06 */
  CACHE_NULL_TTL: z.coerce.number().int().min(1).max(3600).default(60).describe('空值占位 TTL（秒）'),
  /** TTL 抖动比例（0–1）：防雪崩，PRD-004 FR-08 */
  CACHE_TTL_JITTER: z.coerce.number().min(0).max(1).default(0.1).describe('TTL 随机抖动比例'),
  /** 分布式锁默认 TTL（秒） */
  CACHE_LOCK_TTL: z.coerce.number().int().min(1).max(3600).default(30).describe('分布式锁默认 TTL（秒）'),
  /** 标签映射 TTL（秒）：防「幽灵缓存」，显著长于业务键 */
  CACHE_TAG_TTL: z.coerce.number().int().min(60).max(604800).default(86400).describe('标签映射 TTL（秒）'),
  /** 慢缓存操作告警阈值（毫秒） */
  CACHE_SLOW_MS: z.coerce.number().int().min(1).max(10000).default(50).describe('慢缓存操作阈值（毫秒）'),
  /** 单 key 序列化后字节上限（大 key 防护） */
  CACHE_MAX_VALUE_BYTES: z.coerce.number().int().min(1024).max(104857600).default(1048576).describe('单 key 值字节上限'),
  /** 鉴权策略 */
  AUTH_STRATEGY: z.enum(AUTH_STRATEGY_VALUES).default('jwt').describe('鉴权策略'),
  /** access token 有效期（时长串，如 2h / 30m） */
  AUTH_ACCESS_TTL: z.string().min(1).default('2h').describe('access token 有效期'),
  /** refresh token 有效期（时长串，如 7d / 12h） */
  AUTH_REFRESH_TTL: z.string().min(1).default('7d').describe('refresh token 有效期'),
  /** 连续登录失败几次后锁定账号 */
  AUTH_MAX_FAILED: z.coerce.number().int().min(1).max(100).default(5).describe('登录失败锁定阈值'),
  /** 账号锁定时长（分钟） */
  AUTH_LOCK_MINUTES: z.coerce.number().int().min(1).max(1440).default(15).describe('账号锁定时长（分钟）'),
  /** refresh 轮换并发宽限窗口（秒）：窗口内同一 refresh 并发使用不判泄漏（TC-AUTH-008） */
  AUTH_REFRESH_GRACE_SECONDS: z.coerce.number().int().min(0).max(120).default(10).describe('refresh 并发宽限窗口（秒）'),
  AUTH_FINGERPRINT: z.enum(['on', 'off']).default('on').describe('refresh grace 指纹绑定开关（ADR-0022）：off 时新轮换不写指纹且重试不比对'),
  /** 密码强度策略 */
  AUTH_PASSWORD_POLICY: z.enum(AUTH_PASSWORD_POLICY_VALUES).default('medium').describe('密码强度策略'),
  /** 是否开放自助注册 */
  AUTH_ALLOW_REGISTER: boolString(false).describe('是否开放自助注册（默认关闭：框架「默认安全」原则，开放注册须显式开启）'),
  /** JWT 签名密钥（M3 起由 @fw/auth 消费；缺失时鉴权模块启动即失败） */
  JWT_SECRET: optionalString().describe('JWT 签名密钥'),
  /** 上一版 JWT 签名密钥：密钥轮换过渡期用于验签旧令牌（TC-AUTH-014） */
  JWT_SECRET_PREV: optionalString().describe('上一版 JWT 签名密钥（轮换过渡）'),
  /** API Key 列表，格式 `key:主体名[:权限码,权限码]`，逗号分隔（开放接口策略） */
  AUTH_API_KEYS: z.string().default('').describe('API Key 列表'),
  /** API Key 签名密钥（M10/E-07）：配置后 apikey 策略强制验签（X-Api-Timestamp + X-Api-Sign，约定见 docs/41）；敏感键不入日志 */
  AUTH_API_KEY_SIGN_SECRET: optionalString().describe('API Key 签名密钥（AUTH_API_KEY_SIGN_SECRET）'),
  /** OAuth2 提供方配置（M10/E-07）：JSON 对象串 { provider: { clientId, clientSecret, authorizeUrl, tokenUrl, userInfoUrl, scope? } }；空 = 未启用 */
  AUTH_OAUTH2_PROVIDERS: z.string().default('').describe('OAuth2 提供方配置（AUTH_OAUTH2_PROVIDERS，JSON）'),
  /** OAuth2 回调地址白名单（M10/E-07）：逗号分隔前缀（NFR 安全）；空 = 拒绝一切回调地址（默认安全） */
  AUTH_OAUTH2_REDIRECT_WHITELIST: z.string().default('').describe('OAuth2 回调地址白名单（AUTH_OAUTH2_REDIRECT_WHITELIST，逗号分隔前缀）'),
  /** 队列驱动 */
  MQ_DRIVER: z.enum(MQ_DRIVER_VALUES).default('memory').describe('队列驱动'),
  /** 队列 Redis 连接串（bullmq 驱动；留空时回退 CACHE_URL，两者都为空则启动失败） */
  MQ_URL: optionalUrl().describe('队列 Redis 连接串（bullmq）'),
  /** 队列名前缀；留空时自动使用 `fw:<APP_ENV>`（避免多应用/多环境串队列） */
  MQ_PREFIX: z.string().default('').describe('队列名前缀'),
  /** 每队列并发处理数 */
  MQ_CONCURRENCY: z.coerce.number().int().min(1).max(1000).default(10).describe('每队列并发数'),
  /** 单个任务最大执行次数（含首次）：4 = 首次 + 3 次重试，与 PRD-007 TC-JOB-003 对齐 */
  MQ_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(20).default(4).describe('单个任务最大执行次数（含首次）'),
  /** 重试退避序列（毫秒，逗号分隔）：第 n 次重试前等待第 n 项，超出取最后一项 */
  MQ_BACKOFF: z.string().default('1000,5000,30000').describe('重试退避序列（毫秒，逗号分隔）'),
  /** 单个任务执行超时（秒）：超时按失败处理并记录，进入重试链路 */
  MQ_JOB_TIMEOUT: z.coerce.number().int().min(1).max(3600).default(60).describe('单任务执行超时（秒）'),
  /** 是否启用 cron 定时任务调度 */
  MQ_CRON_ENABLED: boolString(true).describe('是否启用定时任务调度（MQ_CRON_ENABLED）'),
  /** 每队列每秒最大处理数：0 = 不限速 */
  MQ_RATE_LIMIT: z.coerce.number().int().min(0).max(100000).default(0).describe('每队列每秒处理上限（0=不限速）'),
  /** 死信保留上限（超出丢弃最旧），防止内存无限增长 */
  MQ_DEAD_LETTER_MAX: z.coerce.number().int().min(1).max(1000000).default(1000).describe('死信保留上限'),
  /** 优雅停机等待在途任务的超时（秒）；超时未完成的任务重新入队 */
  MQ_SHUTDOWN_TIMEOUT: z.coerce.number().int().min(1).max(300).default(30).describe('队列优雅停机等待超时（秒）'),
  /** bullmq 失速检测间隔（毫秒）：消费进程被强杀后，在途任务最长等这么久被搬回等待区重试；0 = 用 bullmq 默认 30s */
  MQ_STALLED_MS: z.coerce.number().int().min(0).max(600000).default(30000).describe('bullmq 失速检测间隔（毫秒）'),
  /** 优雅停机等待在途请求的超时（秒） */
  SHUTDOWN_TIMEOUT: z.coerce.number().int().min(1).max(300).default(10).describe('优雅停机超时（秒）'),
  /** 慢查询告警阈值（毫秒，M2 起由 @fw/db 消费） */
  DB_SLOW_MS: z.coerce.number().int().min(10).max(60000).default(500).describe('慢查询告警阈值（毫秒）'),
  /** 多租户总开关（M8）：false 时全部接口按单租户运行（无租户上下文校验） */
  TENANT_ENABLED: boolString(false).describe('是否启用多租户（TENANT_ENABLED）'),
  /** 租户解析回退顺序（M8，PRD-008 §9 定稿）：subdomain/header/jwt 的子序列，逗号分隔；未列出的来源即关闭 */
  TENANT_ORDER: z.string().default('subdomain,header,jwt').describe('租户解析回退顺序（TENANT_ORDER）'),
  /** 租户标识请求头名称（M8）：小写；默认 x-tenant-id */
  TENANT_HEADER_NAME: z.string().regex(/^[a-z0-9-]+$/).default('x-tenant-id').describe('租户标识请求头名（TENANT_HEADER_NAME）'),
  /** 子域名解析基准域名（M8）：如 example.com；未配置时 subdomain 来源按设计关闭 */
  TENANT_BASE_DOMAIN: optionalString().describe('子域名解析基准域名（TENANT_BASE_DOMAIN）'),
  /** JWT claim 字段名（M8）：从 access token 载荷提取租户归属，默认 tenantId */
  TENANT_JWT_CLAIM: z.string().min(1).default('tenantId').describe('JWT 租户 claim 字段名（TENANT_JWT_CLAIM）'),
  /** 租户信息缓存 TTL（秒，M8）：tenants 表查询结果的本地缓存时长 */
  TENANT_CACHE_TTL: z.coerce.number().int().min(1).max(3600).default(60).describe('租户信息缓存 TTL（秒）'),
  /**
   * dedicated 租户独立库连接串的加密密钥（M8 T-M8-02）：64 位十六进制（32 字节）或 base64。
   * 缺省时用内置开发密钥（仅限本地开发，生产必须显式配置）。
   */
  TENANT_DB_KEY: optionalString().describe('dedicated 租户独立库连接串加密密钥（TENANT_DB_KEY，64 位十六进制）'),
  /** 传输驱动（M8 T-M8-05，PRD-008 FR-06）：in-process 单体直连 / redis 跨进程 RPC；tcp / kafka 预留 */
  TRANSPORT_DRIVER: z.enum(TRANSPORT_DRIVER_VALUES).default('in-process').describe('传输驱动'),
  /** 传输 Redis 连接串（redis 驱动必填；留空时回退 CACHE_URL，两者都为空则启动失败） */
  TRANSPORT_URL: optionalUrl().describe('传输 Redis 连接串（redis 驱动）'),
  /** 传输 key 前缀；留空时自动使用 `fw:<APP_ENV>`（避免多应用/多环境串数据） */
  TRANSPORT_PREFIX: z.string().default('').describe('传输 key 前缀'),
  /** 单次传输调用超时（毫秒）：超时抛错不等满（BLPOP 按秒粒度循环等待保证精度） */
  TRANSPORT_TIMEOUT_MS: z.coerce.number().int().min(100).max(600000).default(5000).describe('单次传输调用超时（毫秒）'),
  /** 本进程传输角色：caller 只发起调用 / handler 只处理请求 / both 两者兼顾（默认） */
  TRANSPORT_ROLE: z.enum(TRANSPORT_ROLE_VALUES).default('both').describe('本进程传输角色'),
  /** 传输实例标识（诊断用：跨进程区分处理方）；缺省 `host-<pid>` */
  TRANSPORT_INSTANCE_ID: optionalString().describe('传输实例标识（TRANSPORT_INSTANCE_ID）'),
  /** 传输优雅停机等待在途请求的超时（秒） */
  TRANSPORT_SHUTDOWN_TIMEOUT: z.coerce.number().int().min(1).max(300).default(10).describe('传输优雅停机等待超时（秒）'),
  /** 链路追踪总开关（M8 T-M8-06，PRD-008 FR-07）：false 时零开销（不装 SDK，插桩点退化为非记录 span） */
  OTEL_ENABLED: boolString(false).describe('是否启用 OpenTelemetry 链路追踪（OTEL_ENABLED）'),
  /** 服务名（资源属性 service.name）；缺省取 `fw-<APP_ENV>` */
  OTEL_SERVICE_NAME: optionalString().describe('链路追踪服务名（OTEL_SERVICE_NAME）'),
  /** OTLP/HTTP 采集端点（启用后必填，如 http://otel-collector:4318/v1/traces；缺失启动即失败）。
   *  说明：0.223 的 exporter-trace-otlp-http 硬编码 JSON 序列化（content-type: application/json），
   *  故不提供协议配置键——配置诚实原则，无效键不留。 */
  OTEL_EXPORTER_URL: optionalUrl().describe('OTLP/HTTP 采集端点（OTEL_EXPORTER_URL）'),
  /** 采样比例（0~1）：按 traceId 确定性决策，同链路跨服务一致；错误 span 不受此限（见 OTEL_SAMPLE_ERRORS） */
  OTEL_SAMPLE_RATIO: z.coerce.number().min(0).max(1).default(0.1).describe('链路追踪采样比例（0~1）'),
  /** 错误 span 全采（status=ERROR 或记录过异常的 span 忽略比例导出，保证错误链路不丢） */
  OTEL_SAMPLE_ERRORS: boolString(true).describe('错误 span 全采开关（OTEL_SAMPLE_ERRORS）'),
  /** 配置中心总开关（M9/PRD-009）：false 时零开销（不读文件不起轮询），全部运行时参数按 env 快照 */
  CONFIG_CENTER_ENABLED: boolString(false).describe('是否启用配置中心（CONFIG_CENTER_ENABLED）'),
  /** 配置中心适配器（M9/PRD-009 FR-01）：首版枚举仅 file（本地文件 + mtime 轮询）；nacos 预留不入枚举 */
  CONFIG_CENTER_DRIVER: z.enum(CONFIG_CENTER_DRIVER_VALUES).default('file').describe('配置中心适配器（CONFIG_CENTER_DRIVER）'),
  /** 运行时配置文件路径（M9/PRD-009 FR-02）：单一事实源，管理端点写入与轮询读取共用 */
  CONFIG_CENTER_FILE: z.string().min(1).default('./config/runtime.json').describe('运行时配置文件路径（CONFIG_CENTER_FILE）'),
  /** mtime 轮询间隔（秒，M9/PRD-009 FR-02）：热更生效延迟上界 = 轮询间隔 + 1s */
  CONFIG_CENTER_POLL_SECONDS: z.coerce.number().int().min(1).max(300).default(5).describe('配置中心轮询间隔（秒，CONFIG_CENTER_POLL_SECONDS）'),
  /** 任务中心驱动（M10/E-01）：memory 进程内（默认，N-02 原行为）/ db 落库+派发实例执行 / bullmq 落库+队列分发；boot 键禁热更 */
  JOB_CENTER_DRIVER: z.enum(JOB_CENTER_DRIVER_VALUES).default('memory').describe('任务中心驱动（JOB_CENTER_DRIVER）'),
  /** Nacos 服务地址（M10/E-02，CONFIG_CENTER_DRIVER=nacos 时必填，缺失启动即失败） */
  CONFIG_CENTER_NACOS_SERVER_ADDR: optionalString().describe('Nacos 服务地址（CONFIG_CENTER_NACOS_SERVER_ADDR）'),
  /** Nacos 配置 ID（M10/E-02，对应一份运行时覆盖 JSON） */
  CONFIG_CENTER_NACOS_DATA_ID: z.string().min(1).default('fw-runtime').describe('Nacos dataId（CONFIG_CENTER_NACOS_DATA_ID）'),
  /** Nacos 分组（M10/E-02） */
  CONFIG_CENTER_NACOS_GROUP: z.string().min(1).default('DEFAULT_GROUP').describe('Nacos 分组（CONFIG_CENTER_NACOS_GROUP）'),
  /** Nacos 命名空间（M10/E-02，缺省 public） */
  CONFIG_CENTER_NACOS_NAMESPACE: optionalString().describe('Nacos 命名空间（CONFIG_CENTER_NACOS_NAMESPACE）'),
  /** Nacos 鉴权用户名（M10/E-02，开启鉴权时必填） */
  CONFIG_CENTER_NACOS_USERNAME: optionalString().describe('Nacos 用户名（CONFIG_CENTER_NACOS_USERNAME）'),
  /** Nacos 鉴权密码（M10/E-02，开启鉴权时必填；敏感键不入日志） */
  CONFIG_CENTER_NACOS_PASSWORD: optionalString().describe('Nacos 密码（CONFIG_CENTER_NACOS_PASSWORD）'),
  /** 限流桶容量（M10/E-03）：每 IP 令牌桶上限；请求超出即 429（dry-run 除外）；boot 键禁热更 */
  RATE_LIMIT_CAPACITY: z.coerce.number().int().min(1).max(1000000).default(600).describe('限流桶容量（RATE_LIMIT_CAPACITY）'),
  /** 限流每秒补充令牌数（M10/E-03）：稳态吞吐上限 = 该值；boot 键禁热更 */
  RATE_LIMIT_REFILL_PER_SECOND: z.coerce.number().int().min(1).max(100000).default(10).describe('限流每秒补充（RATE_LIMIT_REFILL_PER_SECOND）'),
  /** 限流豁免路径前缀（M10/E-03，逗号分隔）：健康探针与 metrics 等运维面必须豁免 */
  RATE_LIMIT_WHITELIST: z.string().min(1).default('/api/v1/health,/api/v1/ready,/api/v1/metrics').describe('限流豁免路径前缀（RATE_LIMIT_WHITELIST）'),
  /** 限流存储故障时放行（M10/E-03，fail-open）：与 cache 三防护同构；false = fail-closed 全拒绝 */
  RATE_LIMIT_FAIL_OPEN: boolString(true).describe('限流故障放行（RATE_LIMIT_FAIL_OPEN）'),
  /** 限流灰度模式（M10/E-03）：true = 仅计数告警不拦截（观测先行，切换放开即 false；非「关闭」——桶与计数照常运转） */
  RATE_LIMIT_DRY_RUN: boolString(false).describe('限流灰度仅告警（RATE_LIMIT_DRY_RUN）'),
  /** 审计归档保留天数（M10/E-10）：createdAt 早于「now - 保留天数」的审计记录由定时任务迁入归档表（audit_log_archives）；与数据字典 §3.13 保留期口径一致 */
  AUDIT_ARCHIVE_RETENTION_DAYS: z.coerce.number().int().min(1).max(3650).default(180).describe('审计归档保留天数（AUDIT_ARCHIVE_RETENTION_DAYS）'),
  /** 审计归档单批条数（M10/E-10）：每批「先写归档（幂等 upsert）后删在线」，控制单批事务压力与长占锁时间 */
  AUDIT_ARCHIVE_BATCH_SIZE: z.coerce.number().int().min(1).max(100000).default(1000).describe('审计归档单批条数（AUDIT_ARCHIVE_BATCH_SIZE）'),
  /** 前端 keep-alive LRU 条数上限（M10/E-16）：admin-web 主内容区缓存已访问页面条数（启动经 GET /configs 读取，变更后刷新页面生效） */
  WEB_KEEP_ALIVE_MAX: z.coerce.number().int().min(1).max(1000).default(12).describe('前端 keep-alive 条数上限（WEB_KEEP_ALIVE_MAX）'),
  /** 死信分页每页条数上限（M10/E-16）：管理面死信列表 pageSize 钳制上界（与 api-spec §1.5 列表约定同源） */
  MQ_DEAD_LETTER_PAGE_MAX: z.coerce.number().int().min(1).max(1000).default(200).describe('死信分页每页上限（MQ_DEAD_LETTER_PAGE_MAX）'),
  /** 单任务产物体积上限（MB，M10/E-16）：超出任务失败并给可读原因（不静默截断）；memory 与 db/bullmq 驱动同口径 */
  JOB_ARTIFACT_MAX_MB: z.coerce.number().int().min(1).max(1024).default(20).describe('任务产物体积上限（MB，JOB_ARTIFACT_MAX_MB）'),
  /** 配置快照历史保留版本数（M10/E-16）：进程内环形表与持久历史的淘汰窗口同口径；回滚到已淘汰版本报 404/5003 */
  CONFIG_CENTER_HISTORY_MAX: z.coerce.number().int().min(1).max(1000).default(20).describe('配置历史保留版本数（CONFIG_CENTER_HISTORY_MAX）'),
  /** 文件存储驱动（M10/E-09）：local 本地磁盘（默认）/ s3 兼容对象存储（@aws-sdk/client-s3 optional peer）；boot 键禁热更 */
  STORAGE_DRIVER: z.enum(STORAGE_DRIVER_VALUES).default('local').describe('文件存储驱动（STORAGE_DRIVER）'),
  /** local 驱动存储根目录（M10/E-09）：对象 key 为其下的相对路径（<yyyyMM>/<uuid><ext>） */
  STORAGE_LOCAL_ROOT: z.string().min(1).default('./uploads').describe('local 驱动存储根目录（STORAGE_LOCAL_ROOT）'),
  /** S3 兼容端点（M10/E-09）：MinIO / COS / OSS 等自定义端点；缺省走 AWS 原生寻址 */
  STORAGE_S3_ENDPOINT: optionalString().describe('S3 兼容端点（STORAGE_S3_ENDPOINT）'),
  /** S3 区域（M10/E-09） */
  STORAGE_S3_REGION: z.string().min(1).default('us-east-1').describe('S3 区域（STORAGE_S3_REGION）'),
  /** S3 桶名（M10/E-09，s3 驱动必填，缺失启动即失败） */
  STORAGE_S3_BUCKET: optionalString().describe('S3 桶名（STORAGE_S3_BUCKET）'),
  /** S3 访问密钥 ID（M10/E-09；SDK 未显式配置时回退节点 IAM/环境链路） */
  STORAGE_S3_ACCESS_KEY_ID: optionalString().describe('S3 访问密钥 ID（STORAGE_S3_ACCESS_KEY_ID）'),
  /** S3 访问密钥（M10/E-09；敏感键不入日志） */
  STORAGE_S3_SECRET_ACCESS_KEY: optionalString().describe('S3 访问密钥（STORAGE_S3_SECRET_ACCESS_KEY）'),
  /** S3 path-style 寻址（M10/E-09）：MinIO 必须 true；AWS 原生建议 false */
  STORAGE_S3_FORCE_PATH_STYLE: boolString(true).describe('S3 path-style 寻址（STORAGE_S3_FORCE_PATH_STYLE）'),
  /** 单文件大小上限 MB（M10/E-09）：超出 400 拒绝（不静默截断），与任务中心产物口径一致 */
  STORAGE_MAX_MB: z.coerce.number().int().min(1).max(1024).default(20).describe('单文件大小上限（MB，STORAGE_MAX_MB）'),
  /** 上传扩展名白名单（M10/E-09，逗号分隔，大小写不敏感；默认收紧，按需放宽） */
  STORAGE_ALLOWED_EXTS: z.string().min(1).default('.png,.jpg,.jpeg,.gif,.webp,.pdf,.txt,.csv,.xlsx,.docx,.zip').describe('上传扩展名白名单（STORAGE_ALLOWED_EXTS）'),
});

/** 校验后的环境变量类型 */
export type Env = z.infer<typeof envSchema>;

/** 各 enum 字段的可选值常量，供报错提示复用 */
export const ENUM_OPTIONS: Record<string, readonly string[]> = {
  APP_ENV: APP_ENV_VALUES,
  LOG_LEVEL: LOG_LEVEL_VALUES,
  DB_DRIVER: DB_DRIVER_VALUES,
  CACHE_DRIVER: CACHE_DRIVER_VALUES,
  AUTH_STRATEGY: AUTH_STRATEGY_VALUES,
  AUTH_PASSWORD_POLICY: AUTH_PASSWORD_POLICY_VALUES,
  MQ_DRIVER: MQ_DRIVER_VALUES,
  TRANSPORT_DRIVER: TRANSPORT_DRIVER_VALUES,
  TRANSPORT_ROLE: TRANSPORT_ROLE_VALUES,
  TENANT_ORDER: TENANT_SOURCE_VALUES,
  CONFIG_CENTER_DRIVER: CONFIG_CENTER_DRIVER_VALUES,
  STORAGE_DRIVER: STORAGE_DRIVER_VALUES,
};

/**
 * 全部 Env 键 → 点路径注册表（M9/PRD-009，配置中心键空间的唯一事实源）。
 *
 * 规则：AppConfig 视图已有的域沿用其路径（app/log/db/cache/auth/mq/shutdown）；
 * 未入视图的键按「小写前缀.小写驼峰键名」派生（jwt/tenant/transport/otel/configCenter）。
 * **新增配置键必须在此登记**——`env-schema.test.ts` 断言本表键集与 envSchema.shape 完全一致，
 * 漏登记即单测失败（防键集漂移，PRD-009 §8 风险缓解）。
 */
export const ENV_KEY_PATHS = {
  APP_ENV: 'app.env',
  APP_PORT: 'app.port',
  LOG_LEVEL: 'log.level',
  LOG_MAX_BYTES: 'log.maxBytes',
  DB_DRIVER: 'db.driver',
  DB_URL: 'db.url',
  DB_SLOW_MS: 'db.slowMs',
  CACHE_DRIVER: 'cache.driver',
  CACHE_URL: 'cache.url',
  CACHE_PREFIX: 'cache.prefix',
  CACHE_TTL: 'cache.ttl',
  CACHE_MAX_ITEMS: 'cache.maxItems',
  CACHE_FAIL_OPEN: 'cache.failOpen',
  CACHE_NULL_TTL: 'cache.nullTtl',
  CACHE_TTL_JITTER: 'cache.ttlJitter',
  CACHE_LOCK_TTL: 'cache.lockTtl',
  CACHE_TAG_TTL: 'cache.tagTtl',
  CACHE_SLOW_MS: 'cache.slowMs',
  CACHE_MAX_VALUE_BYTES: 'cache.maxValueBytes',
  AUTH_STRATEGY: 'auth.strategy',
  AUTH_ACCESS_TTL: 'auth.accessTtl',
  AUTH_REFRESH_TTL: 'auth.refreshTtl',
  AUTH_MAX_FAILED: 'auth.maxFailed',
  AUTH_LOCK_MINUTES: 'auth.lockMinutes',
  AUTH_REFRESH_GRACE_SECONDS: 'auth.refreshGraceSeconds',
  AUTH_FINGERPRINT: 'auth.fingerprintEnabled',
  AUTH_PASSWORD_POLICY: 'auth.passwordPolicy',
  AUTH_ALLOW_REGISTER: 'auth.allowRegister',
  AUTH_API_KEYS: 'auth.apiKeys',
  AUTH_API_KEY_SIGN_SECRET: 'auth.apiKeySignSecret',
  AUTH_OAUTH2_PROVIDERS: 'auth.oauth2.providers',
  AUTH_OAUTH2_REDIRECT_WHITELIST: 'auth.oauth2.redirectWhitelist',
  JWT_SECRET: 'jwt.secret',
  JWT_SECRET_PREV: 'jwt.secretPrev',
  MQ_DRIVER: 'mq.driver',
  MQ_URL: 'mq.url',
  MQ_PREFIX: 'mq.prefix',
  MQ_CONCURRENCY: 'mq.concurrency',
  MQ_MAX_ATTEMPTS: 'mq.maxAttempts',
  MQ_BACKOFF: 'mq.backoff',
  MQ_JOB_TIMEOUT: 'mq.jobTimeout',
  MQ_CRON_ENABLED: 'mq.cronEnabled',
  MQ_RATE_LIMIT: 'mq.rateLimit',
  MQ_DEAD_LETTER_MAX: 'mq.deadLetterMax',
  MQ_SHUTDOWN_TIMEOUT: 'mq.shutdownTimeout',
  MQ_STALLED_MS: 'mq.stalledMs',
  SHUTDOWN_TIMEOUT: 'shutdown.timeoutSeconds',
  TENANT_ENABLED: 'tenant.enabled',
  TENANT_ORDER: 'tenant.order',
  TENANT_HEADER_NAME: 'tenant.headerName',
  TENANT_BASE_DOMAIN: 'tenant.baseDomain',
  TENANT_JWT_CLAIM: 'tenant.jwtClaim',
  TENANT_CACHE_TTL: 'tenant.cacheTtl',
  TENANT_DB_KEY: 'tenant.dbKey',
  TRANSPORT_DRIVER: 'transport.driver',
  TRANSPORT_URL: 'transport.url',
  TRANSPORT_PREFIX: 'transport.prefix',
  TRANSPORT_TIMEOUT_MS: 'transport.timeoutMs',
  TRANSPORT_ROLE: 'transport.role',
  TRANSPORT_INSTANCE_ID: 'transport.instanceId',
  TRANSPORT_SHUTDOWN_TIMEOUT: 'transport.shutdownTimeout',
  OTEL_ENABLED: 'otel.enabled',
  OTEL_SERVICE_NAME: 'otel.serviceName',
  OTEL_EXPORTER_URL: 'otel.exporterUrl',
  OTEL_SAMPLE_RATIO: 'otel.sampleRatio',
  OTEL_SAMPLE_ERRORS: 'otel.sampleErrors',
  CONFIG_CENTER_ENABLED: 'configCenter.enabled',
  CONFIG_CENTER_DRIVER: 'configCenter.driver',
  CONFIG_CENTER_FILE: 'configCenter.file',
  CONFIG_CENTER_POLL_SECONDS: 'configCenter.pollSeconds',
  CONFIG_CENTER_NACOS_SERVER_ADDR: 'configCenter.nacos.serverAddr',
  CONFIG_CENTER_NACOS_DATA_ID: 'configCenter.nacos.dataId',
  CONFIG_CENTER_NACOS_GROUP: 'configCenter.nacos.group',
  CONFIG_CENTER_NACOS_NAMESPACE: 'configCenter.nacos.namespace',
  CONFIG_CENTER_NACOS_USERNAME: 'configCenter.nacos.username',
  CONFIG_CENTER_NACOS_PASSWORD: 'configCenter.nacos.password',
  JOB_CENTER_DRIVER: 'jobCenter.driver',
  RATE_LIMIT_CAPACITY: 'rateLimit.capacity',
  RATE_LIMIT_REFILL_PER_SECOND: 'rateLimit.refillPerSecond',
  RATE_LIMIT_WHITELIST: 'rateLimit.whitelist',
  RATE_LIMIT_FAIL_OPEN: 'rateLimit.failOpen',
  RATE_LIMIT_DRY_RUN: 'rateLimit.dryRun',
  AUDIT_ARCHIVE_RETENTION_DAYS: 'audit.archiveRetentionDays',
  AUDIT_ARCHIVE_BATCH_SIZE: 'audit.archiveBatchSize',
  WEB_KEEP_ALIVE_MAX: 'web.keepAliveMax',
  MQ_DEAD_LETTER_PAGE_MAX: 'mq.deadLetterPageMax',
  JOB_ARTIFACT_MAX_MB: 'jobCenter.artifactMaxMb',
  CONFIG_CENTER_HISTORY_MAX: 'configCenter.historyMax',
  STORAGE_DRIVER: 'storage.driver',
  STORAGE_LOCAL_ROOT: 'storage.localRoot',
  STORAGE_S3_ENDPOINT: 'storage.s3.endpoint',
  STORAGE_S3_REGION: 'storage.s3.region',
  STORAGE_S3_BUCKET: 'storage.s3.bucket',
  STORAGE_S3_ACCESS_KEY_ID: 'storage.s3.accessKeyId',
  STORAGE_S3_SECRET_ACCESS_KEY: 'storage.s3.secretAccessKey',
  STORAGE_S3_FORCE_PATH_STYLE: 'storage.s3.forcePathStyle',
  STORAGE_MAX_MB: 'storage.maxMb',
  STORAGE_ALLOWED_EXTS: 'storage.allowedExts',
} as const satisfies Record<keyof Env, string>;

/**
 * 热更新白名单（M9/PRD-009 FR-03）：键为点路径，值为对应 Env 键名。
 *
 * 首版范围 = PRD-009 FR-03 定稿清单（log / cache / mq / otel / tenant 五个运行时可调域）；
 * M10/E-16 增补 web.keepAliveMax（PRD-010 E-16 评审扩范围：前端 keep-alive 上限须经 GET /configs
 * 运行时读取，不登记即不可见——与「按需入热更白名单」的 E-16 约束一致）；
 * **boot 键（端口 / 驱动 / 连接串 / 密钥 / 开关）一律禁改**——改动属进程形态变更，必须走重启；
 * 登录策略（auth.maxFailed / auth.lockMinutes）属安全基线，按 PRD-009 §9 决议不纳入。
 * 新键是否可热更在 ENV_KEY_PATHS 之外**显式**登记于此：不登记即不可热更（fail-safe 方向）。
 */
export const ENV_HOT_KEYS = {
  'log.level': 'LOG_LEVEL',
  'log.maxBytes': 'LOG_MAX_BYTES',
  'cache.ttl': 'CACHE_TTL',
  'cache.nullTtl': 'CACHE_NULL_TTL',
  'cache.ttlJitter': 'CACHE_TTL_JITTER',
  'cache.slowMs': 'CACHE_SLOW_MS',
  'cache.lockTtl': 'CACHE_LOCK_TTL',
  'mq.rateLimit': 'MQ_RATE_LIMIT',
  'mq.concurrency': 'MQ_CONCURRENCY',
  'otel.sampleRatio': 'OTEL_SAMPLE_RATIO',
  'tenant.cacheTtl': 'TENANT_CACHE_TTL',
  'web.keepAliveMax': 'WEB_KEEP_ALIVE_MAX',
} as const satisfies Record<string, keyof Env>;
