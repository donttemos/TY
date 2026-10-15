/*
 * @file 配置中心生命周期（M9/PRD-009）
 * @description onModuleInit：事实源加载（全量校验 fail-fast）→ 注册订阅（白名单 11 键 → 框架服务）→
 *   syncAll 把启动覆盖值一次性推给各框架服务。CONFIG_CENTER_ENABLED=false 时跳过加载与订阅
 *   （零开销：不读文件不起轮询），GET /configs 仍可提供 env 视图。停机释放轮询定时器。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */
import { Inject, Injectable, type OnApplicationShutdown, type OnModuleInit } from '@nestjs/common';
import type { ConfigCenterService, Unsubscribe } from '@fw/config-center';
import { Logger } from '@fw/logger';
import { CONFIG_CENTER, CONFIG_CENTER_STATE, CONFIG_SUBSCRIPTION_TARGETS } from './config-center.tokens.js';
import { wireConfigCenterSubscriptions, type ConfigSubscriptionTargets } from './config-subscriptions.js';

const logger = Logger.for('config-center.lifecycle');

/**
 * 配置中心生命周期
 */
@Injectable()
export class ConfigCenterLifecycle implements OnModuleInit, OnApplicationShutdown {
  private unsubscribes: Unsubscribe[] = [];

  constructor(
    @Inject(CONFIG_CENTER) private readonly center: ConfigCenterService,
    @Inject(CONFIG_CENTER_STATE) private readonly state: { enabled: boolean },
    @Inject(CONFIG_SUBSCRIPTION_TARGETS) private readonly targets: ConfigSubscriptionTargets,
  ) {}

  /** 启动：加载事实源 → 订阅 → 同步初始覆盖值 */
  async onModuleInit(): Promise<void> {
    if (!this.state.enabled) {
      logger.info('配置中心未启用（CONFIG_CENTER_ENABLED=false），运行时参数按 env 快照');
      return;
    }
    await this.center.init();
    const wiring = wireConfigCenterSubscriptions(this.center, this.targets);
    this.unsubscribes = [...wiring.unsubscribes];
    wiring.syncAll();
    const missing: string[] = [];
    for (const entry of this.center.list()) {
      if (!wiring.keys.includes(entry.key)) missing.push(entry.key);
    }
    logger.info('配置中心已启动', {
      driver: this.center.meta().driver,
      snapshotVersion: this.center.snapshotVersion,
      wiredKeys: wiring.keys.length,
      ...(missing.length > 0 ? { missingSubscribers: missing } : {}),
    });
  }

  /** 停机：释放驱动资源（file 驱动的轮询定时器） */
  async onApplicationShutdown(): Promise<void> {
    if (!this.state.enabled) return;
    for (const unsubscribe of this.unsubscribes) unsubscribe();
    this.unsubscribes = [];
    await this.center.shutdown();
  }
}
