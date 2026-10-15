/*
 * @file 配置订阅装配（PRD-009 FR-09：各框架服务经 onChange 订阅各自键，禁止自行轮询）
 * @description 白名单键 → 框架服务运行时选项的唯一映射表：
 *   log.* → @fw/logger（configureLogger 全局单例）、cache.* → CacheService、mq.* → QueueService、
 *   otel.sampleRatio → TelemetryService（尾采样处理器共享引用，即改即生效）、tenant.cacheTtl → TenantService。
 *   syncAll() 在启动加载后把事实源覆盖值一次性推给各服务（init 不逐键通知，订阅只管运行期变更）。
 *   每条映射都有单测反向验证（撤掉订阅 / 管道通知，用例必须 FAIL 才算护栏有效，见 spec 文件）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import type { CacheService } from '@fw/cache';
import type { ConfigCenterService, Unsubscribe } from '@fw/config-center';
import type { QueueService } from '@fw/queue';
import { configureLogger, type LogLevel } from '@fw/logger';
import type { TelemetryService } from '@fw/telemetry';
import type { TenantService } from '@fw/tenant';

/** 可订阅的框架服务面（只声明用到的最小方法集，测试可用桩对象） */
export interface ConfigSubscriptionTargets {
  cache?: Pick<CacheService, 'updateRuntimeOptions'>;
  queue?: Pick<QueueService, 'updateRuntimeOptions'>;
  telemetry?: Pick<TelemetryService, 'updateRuntimeOptions'>;
  tenant?: Pick<TenantService, 'updateRuntimeOptions'>;
}

/** 单键生效路径 */
interface KeyBinding {
  key: string;
  apply: (value: unknown) => void;
}

/** 订阅装配结果 */
export interface ConfigSubscriptionWiring {
  /** 已登记生效路径的键（诊断与测试断言用） */
  readonly keys: readonly string[];
  /** 退订函数集合（优雅停机时可清理；进程退出场景可忽略） */
  readonly unsubscribes: readonly Unsubscribe[];
  /** 把当前生效值（env 快照 + 启动覆盖）推给各框架服务（启动加载后调用一次） */
  syncAll(): void;
}

/**
 * 装配配置订阅：白名单 11 键逐一映射到框架服务运行时选项。
 * 目标服务缺失（如未启用多租户 / 链路追踪）时跳过对应键——值仍在覆盖层生效，
 * 但该服务面不消费；装配方应以 WARN 记录缺失面（生命周期内处理）。
 * @param center 配置中心服务
 * @param targets 可用的框架服务（缺域即跳过）
 */
export function wireConfigCenterSubscriptions(
  center: ConfigCenterService,
  targets: ConfigSubscriptionTargets,
): ConfigSubscriptionWiring {
  const bindings: KeyBinding[] = [
    // 日志域：Logger 是模块级单例，configureLogger 任意时刻可调
    { key: 'log.level', apply: (value) => configureLogger({ level: value as LogLevel }) },
    { key: 'log.maxBytes', apply: (value) => configureLogger({ maxBytes: value as number }) },
  ];
  if (targets.cache) {
    const cache = targets.cache;
    bindings.push(
      { key: 'cache.ttl', apply: (value) => cache.updateRuntimeOptions({ defaultTtlSeconds: value as number }) },
      { key: 'cache.nullTtl', apply: (value) => cache.updateRuntimeOptions({ nullTtlSeconds: value as number }) },
      { key: 'cache.ttlJitter', apply: (value) => cache.updateRuntimeOptions({ ttlJitter: value as number }) },
      { key: 'cache.slowMs', apply: (value) => cache.updateRuntimeOptions({ slowMs: value as number }) },
      { key: 'cache.lockTtl', apply: (value) => cache.updateRuntimeOptions({ lockTtlSeconds: value as number }) },
    );
  }
  if (targets.queue) {
    const queue = targets.queue;
    bindings.push(
      { key: 'mq.rateLimit', apply: (value) => queue.updateRuntimeOptions({ rateLimit: value as number }) },
      { key: 'mq.concurrency', apply: (value) => queue.updateRuntimeOptions({ concurrency: value as number }) },
    );
  }
  if (targets.telemetry) {
    const telemetry = targets.telemetry;
    bindings.push({ key: 'otel.sampleRatio', apply: (value) => telemetry.updateRuntimeOptions({ sampleRatio: value as number }) });
  }
  if (targets.tenant) {
    const tenant = targets.tenant;
    bindings.push({ key: 'tenant.cacheTtl', apply: (value) => tenant.updateRuntimeOptions({ cacheTtlMs: (value as number) * 1000 }) });
  }

  const unsubscribes = bindings.map((binding) => center.onChange(binding.key, (value) => binding.apply(value)));

  return {
    keys: bindings.map((binding) => binding.key),
    unsubscribes,
    syncAll(): void {
      for (const entry of center.list()) {
        const binding = bindings.find((item) => item.key === entry.key);
        if (binding) binding.apply(entry.value);
      }
    },
  };
}
