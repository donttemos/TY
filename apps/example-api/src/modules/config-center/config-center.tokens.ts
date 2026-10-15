/*
 * @file 配置中心 DI 令牌
 * @description CONFIG_CENTER = ConfigCenterService 实例；CONFIG_CENTER_STATE = 启用状态（决定 GET/PUT 语义）；
 *   CONFIG_SUBSCRIPTION_TARGETS = 可订阅框架服务集合（生命周期装配用）。
 * @author donttemo
 * @created 2026-10-15
 * @module example-api/config-center
 */

/** 配置中心服务令牌 */
export const CONFIG_CENTER = 'FW_CONFIG_CENTER';

/** 启用状态令牌 */
export const CONFIG_CENTER_STATE = 'FW_CONFIG_CENTER_STATE';

/** 订阅目标集合令牌 */
export const CONFIG_SUBSCRIPTION_TARGETS = 'FW_CONFIG_SUBSCRIPTION_TARGETS';
