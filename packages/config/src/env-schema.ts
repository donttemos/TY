/*
 * @file 环境变量 schema
 * @description 用 zod 定义全部配置键的类型与取值约束；新增配置项必须同步 .env.example 与 docs/40-api-spec.md；前缀即能力切换点（DB_/CACHE_/AUTH_/MQ_），非法取值在启动时即失败。
 * @author donttemo
 * @created 2026-10-09
 * @modified 2026-10-13 donttemo AUTH_ALLOW_REGISTER 默认改 false（与部署手册/「默认安全」一致）
 * @modified 2026-10-13 donttemo M4 新增 9 个 CACHE_* 键（前缀/TTL/容量/降级/空值/抖动/锁/慢操作/大key）
 * @modified 2026-10-13 donttemo M7 新增 10 个 MQ_* 键（连接/前缀/并发/尝试/退避/超时/cron/限速/死信上限/停机等待）
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
  /** 优雅停机等待在途请求的超时（秒） */
  SHUTDOWN_TIMEOUT: z.coerce.number().int().min(1).max(300).default(10).describe('优雅停机超时（秒）'),
  /** 慢查询告警阈值（毫秒，M2 起由 @fw/db 消费） */
  DB_SLOW_MS: z.coerce.number().int().min(10).max(60000).default(500).describe('慢查询告警阈值（毫秒）'),
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
};
