/*
 * @file 前端运行时上限 store（Pinia）
 * @description M10/E-16：keep-alive 条数等前端侧边界上限经配置中心下发（GET /configs →
 *   web.keepAliveMax，后端 WEB_KEEP_ALIVE_MAX 热更白名单键）。读取失败（无 system:config:read
 *   权限 / 配置中心未启用 / 网络异常）时回退内置默认值——上限读取是增强而非前置，不影响渲染。
 *   一次会话最多加载一次（失败不重试，避免无权限用户每次进布局都打一次必败请求）。
 * @author donttemo
 * @created 2026-10-15
 * @module admin-web/store
 */

import { defineStore } from 'pinia';
import { ref } from 'vue';
import { fetchConfigs } from '@/api/config';

/** keep-alive 条数默认值（与后端 WEB_KEEP_ALIVE_MAX schema 默认值同口径） */
export const DEFAULT_KEEP_ALIVE_MAX = 12;

/** 合法区间（与后端 zod 约束同口径：min 1 / max 1000） */
const MIN_KEEP_ALIVE_MAX = 1;
const MAX_KEEP_ALIVE_MAX = 1000;

/**
 * 前端运行时上限（当前仅 keep-alive 条数）
 */
export const useWebLimitsStore = defineStore('web-limits', () => {
  /** keep-alive LRU 条数上限（布局主内容区 :max） */
  const keepAliveMax = ref(DEFAULT_KEEP_ALIVE_MAX);

  /** 是否已尝试加载（含失败——失败按默认值运行，不反复重试） */
  const loaded = ref(false);

  /**
   * 从配置中心拉取前端侧上限并应用（fire-and-forget 语义由调用方 void 处理）
   */
  async function load(): Promise<void> {
    if (loaded.value) return;
    loaded.value = true;
    try {
      const result = await fetchConfigs();
      const entry = result.configs.find((item) => item.key === 'web.keepAliveMax');
      const value = Number(entry?.value);
      if (Number.isInteger(value) && value >= MIN_KEEP_ALIVE_MAX && value <= MAX_KEEP_ALIVE_MAX) {
        keepAliveMax.value = value;
      }
    } catch {
      // 无权限 / 未启用 / 网络失败：保持默认值（fail-open，上限读取不阻塞布局）
    }
  }

  return { keepAliveMax, loaded, load };
});
