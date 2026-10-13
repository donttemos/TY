/*
 * @file 配置读取服务
 * @description 类型安全的点路径读取（如 get('db.driver')）；内部持有已校验的 Env，全进程共享一个实例即可。
 * @author donttemo
 * @created 2026-10-09
 * @module config
 * @since v0.1.0
 */
import type { Env } from './env-schema.js';

/** 嵌套配置视图：前缀即能力域（app/db/cache/auth/mq/log/shutdown） */
export interface AppConfig {
  app: { env: Env['APP_ENV']; port: number };
  log: { level: Env['LOG_LEVEL']; maxBytes: number };
  db: { driver: Env['DB_DRIVER']; url: string | undefined };
  cache: {
    driver: Env['CACHE_DRIVER'];
    url: string | undefined;
    prefix: string;
    ttl: number;
    maxItems: number;
    failOpen: boolean;
    nullTtl: number;
    ttlJitter: number;
    lockTtl: number;
    tagTtl: number;
    slowMs: number;
    maxValueBytes: number;
  };
  auth: {
    strategy: Env['AUTH_STRATEGY'];
    accessTtl: string;
    refreshTtl: string;
    maxFailed: number;
    lockMinutes: number;
    passwordPolicy: Env['AUTH_PASSWORD_POLICY'];
    allowRegister: boolean;
  };
  mq: { driver: Env['MQ_DRIVER'] };
  shutdown: { timeoutSeconds: number };
}

/** 全部合法的点路径（两级） */
export type ConfigPath = {
  [K in keyof AppConfig & string]: `${K}.${keyof AppConfig[K] & string}`;
}[keyof AppConfig & string];

/** 点路径对应的取值类型 */
export type ConfigValue<P extends ConfigPath> = P extends `${infer A}.${infer B}`
  ? A extends keyof AppConfig
    ? B extends keyof AppConfig[A]
      ? AppConfig[A][B]
      : never
    : never
  : never;

/** Env 平铺结构 → 嵌套视图的映射规则 */
function toView(env: Env): AppConfig {
  return {
    app: { env: env.APP_ENV, port: env.APP_PORT },
    log: { level: env.LOG_LEVEL, maxBytes: env.LOG_MAX_BYTES },
    db: { driver: env.DB_DRIVER, url: env.DB_URL },
    cache: {
      driver: env.CACHE_DRIVER,
      url: env.CACHE_URL,
      prefix: env.CACHE_PREFIX,
      ttl: env.CACHE_TTL,
      maxItems: env.CACHE_MAX_ITEMS,
      failOpen: env.CACHE_FAIL_OPEN,
      nullTtl: env.CACHE_NULL_TTL,
      ttlJitter: env.CACHE_TTL_JITTER,
      lockTtl: env.CACHE_LOCK_TTL,
      tagTtl: env.CACHE_TAG_TTL,
      slowMs: env.CACHE_SLOW_MS,
      maxValueBytes: env.CACHE_MAX_VALUE_BYTES,
    },
    auth: {
      strategy: env.AUTH_STRATEGY,
      accessTtl: env.AUTH_ACCESS_TTL,
      refreshTtl: env.AUTH_REFRESH_TTL,
      maxFailed: env.AUTH_MAX_FAILED,
      lockMinutes: env.AUTH_LOCK_MINUTES,
      passwordPolicy: env.AUTH_PASSWORD_POLICY,
      allowRegister: env.AUTH_ALLOW_REGISTER,
    },
    mq: { driver: env.MQ_DRIVER },
    shutdown: { timeoutSeconds: env.SHUTDOWN_TIMEOUT },
  };
}

/**
 * 配置读取服务：持有校验后的环境快照
 *
 * 用法：`config.get('db.driver')`，返回值类型由点路径自动推导。
 */
export class ConfigService {
  private readonly view: AppConfig;

  /** 校验后的原始环境变量（平铺） */
  readonly raw: Env;

  constructor(env: Env) {
    this.raw = env;
    this.view = toView(env);
  }

  /**
   * 类型安全读取配置
   * @param path 点路径，如 'db.driver'
   * @returns 对应配置值
   */
  get<P extends ConfigPath>(path: P): ConfigValue<P> {
    const [section, key] = path.split('.');
    // 入参 path 受 ConfigPath 约束，这里必然命中
    const sectionObj = this.view[section as keyof AppConfig] as Record<string, unknown>;
    return sectionObj[key] as ConfigValue<P>;
  }
}
